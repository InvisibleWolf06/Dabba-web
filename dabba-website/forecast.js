// Dabba Forecast: predicts the weight path your current eating habits lead to.
//
// Model, in three layers:
//  1. Physiology. A day-by-day energy-balance simulation. Expenditure is recomputed from your
//     changing weight with the Dabba Engine, and each kilogram gained or lost is split into fat and
//     lean tissue with Forbes' curve (more body fat → more of the change is fat), using energy densities
//     of 9,440 kcal/kg fat and 1,816 kcal/kg lean (Hall 2008). This avoids the "3,500 kcal per pound"
//     rule, which ignores that expenditure falls as weight falls.
//  2. Habits. Your intake is a recency-weighted average of your complete logging days, with its
//     day-to-day spread used for an 80% uncertainty band.
//  3. Personal calibration (regression). When you log weigh-ins, the model compares what it predicted
//     between weigh-ins with what the scale said, and fits one parameter per person — the daily calorie
//     gap the log misses (unlogged snacks, oil, under-estimated portions, or a metabolism that differs
//     from the formula) — by ridge regression shrunk towards zero, so a few noisy weigh-ins can't swing it.
//     A recency-weighted least-squares line through your weigh-ins gives your observed trend.
(function (root) {
  const E = root.DabbaEngine || (typeof require !== "undefined" ? require("./engine.js") : null);
  const RHO_FAT = 9440, RHO_LEAN = 1816, FORBES_C = 10.4;
  const pad = n => String(n).padStart(2, "0");
  const dkey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseKey = k => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); };
  const addDays = (k, n) => { const d = parseKey(k); d.setDate(d.getDate() + n); return dkey(d); };
  const between = (a, b) => Math.round((parseKey(b) - parseKey(a)) / 864e5);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const kcalOf = d => (d && d.items ? d.items.reduce((a, i) => a + (i.kcal || 0) * (i.qty || 1), 0) : 0);
  const slotsOf = d => (d && d.items ? new Set(d.items.map(i => i.meal)).size : 0);

  /** Maintenance expenditure at a given weight (no goal adjustment). */
  function tdeeAt(p, w, cache) {
    const key = Math.round(w * 10);
    if (cache.has(key)) return cache.get(key);
    const t = E.compute({ ...p, weight: w, goal: "maintain", life: p.life }).tdee;
    cache.set(key, t);
    return t;
  }

  /** Simulates weight day by day for `days` days at a constant daily intake. */
  function simulate(p, w0, intake, days, bias = 0) {
    const cache = new Map();
    let w = w0;
    let fat = w0 * E.bodyFat({ ...p, weight: w0 }).pct / 100;
    const path = [w0];
    for (let d = 1; d <= days; d++) {
      const balance = intake + bias - tdeeAt(p, w, cache);
      const pf = fat / (fat + FORBES_C);                  // share of change that is fat
      const rho = pf * RHO_FAT + (1 - pf) * RHO_LEAN;      // kcal per kg of that change
      const dw = balance / rho;
      w = Math.max(30, w + dw);
      fat = Math.max(2, fat + dw * pf);
      path.push(w);
    }
    return path;
  }

  /** How well the person is logging, and their habitual intake. */
  function habits(p, days, today, t) {
    const bmr = t.bmr;
    const rows = [];
    for (let i = 0; i < 14; i++) {
      const k = addDays(today, -i - 1);            // completed days only (yesterday back)
      const d = days[k];
      rows.push({ k, kcal: kcalOf(d), slots: slotsOf(d), logged: !!(d && d.items && d.items.length) });
    }
    const last7 = rows.slice(0, 7);
    const logged7 = last7.filter(r => r.logged).length;
    const loggedAll = rows.filter(r => r.logged);
    // A day counts as complete when at least two meals were logged and it isn't implausibly small for
    // a single meal. Genuinely low intakes with full logging stay in, so under-eating can be flagged.
    const isComplete = r => r.slots >= 3 || (r.slots >= 2 && r.kcal >= 0.5 * bmr);
    const partial = loggedAll.filter(r => !isComplete(r));
    const complete = loggedAll.filter(isComplete);
    const avgSlots = loggedAll.length ? loggedAll.reduce((a, r) => a + r.slots, 0) / loggedAll.length : 0;
    const quality = clamp(0.5 * (logged7 / 7) + 0.3 * Math.min(1, avgSlots / 3) + 0.2 * (loggedAll.length ? complete.length / loggedAll.length : 0), 0, 1);
    // Recency-weighted mean and spread of complete days (half-life 5 days)
    let sw = 0, sx = 0, sxx = 0;
    for (const r of complete) {
      const age = between(r.k, today);
      const wt = Math.pow(0.5, age / 5);
      sw += wt; sx += wt * r.kcal; sxx += wt * r.kcal * r.kcal;
    }
    const mean = sw ? sx / sw : null;
    const sd = sw ? Math.sqrt(Math.max(0, sxx / sw - mean * mean)) : null;
    return { quality, logged7, completeDays: complete.length, partialDays: partial.length, avgSlots, intake: mean, sd, rows };
  }

  /** Recency-weighted least-squares trend through weigh-ins (last 60 days). kg per week ± standard error. */
  function trend(weights, today) {
    const pts = weights.filter(x => between(x.k, today) <= 60 && between(x.k, today) >= 0).map(x => ({ x: -between(x.k, today), y: x.w, wt: Math.pow(0.5, between(x.k, today) / 21) }));
    if (pts.length < 3 || pts[pts.length - 1].x - pts[0].x < 7) return null;
    const W = pts.reduce((a, q) => a + q.wt, 0);
    const mx = pts.reduce((a, q) => a + q.wt * q.x, 0) / W, my = pts.reduce((a, q) => a + q.wt * q.y, 0) / W;
    const sxx = pts.reduce((a, q) => a + q.wt * (q.x - mx) ** 2, 0);
    const slope = pts.reduce((a, q) => a + q.wt * (q.x - mx) * (q.y - my), 0) / sxx;
    const resid = pts.reduce((a, q) => a + q.wt * (q.y - (my + slope * (q.x - mx))) ** 2, 0) / Math.max(1, W * (pts.length - 2) / pts.length);
    const se = Math.sqrt(resid / sxx);
    return { perWeek: slope * 7, se: se * 7, n: pts.length, level: my + slope * (0 - mx) };
  }

  /** Ridge-regression calibration: the daily kcal gap between logged intake and what the scale implies. */
  function calibrate(p, weights, days, today, bmr) {
    const ws = weights.filter(x => between(x.k, today) <= 60).sort((a, b) => (a.k < b.k ? -1 : 1));
    let num = 0, den = 0, intervals = 0;
    const LAMBDA = 21; // prior strength in days: three weeks of evidence to move half-way
    for (let i = 1; i < ws.length; i++) {
      const a = ws[i - 1], b = ws[i];
      const n = between(a.k, b.k);
      if (n < 3 || n > 21) continue;
      // Only use intervals where most days were fully logged
      let sum = 0, ok = 0;
      for (let j = 0; j < n; j++) {
        const d = days[addDays(a.k, j)];
        const kc = kcalOf(d);
        if (slotsOf(d) >= 3 || (slotsOf(d) >= 2 && kc >= 0.5 * bmr)) { sum += kc; ok++; }
      }
      if (ok < n * 0.7) continue;
      const intake = sum / ok;
      const pred = simulate({ ...p, weight: a.w }, a.w, intake, n)[n];
      const pf = 0.5, rho = pf * RHO_FAT + (1 - pf) * RHO_LEAN;
      const gap = (b.w - pred) * rho / n;   // kcal/day the log is missing (+) or over-counting (−)
      num += n * gap; den += n; intervals++;
    }
    if (!intervals) return { bias: 0, intervals: 0, confidence: 0 };
    const bias = clamp(num / (den + LAMBDA), -600, 800);
    return { bias, intervals, confidence: den / (den + LAMBDA) };
  }

  function reachDay(path, goal, losing) {
    if (!goal) return null;
    for (let i = 0; i < path.length; i++) if (losing ? path[i] <= goal : path[i] >= goal) return i;
    return null;
  }

  /**
   * Main entry. Returns trajectories, ETAs and alerts.
   * profile: Dabba profile object ({ p, weights, ... }); days: { "YYYY-MM-DD": day }.
   */
  function forecast(profile, days, opts = {}) {
    const today = opts.today || dkey(new Date());
    const horizon = opts.horizon || 365;
    const p = profile.p;
    const weights = (profile.weights || []).filter(x => x && x.w > 0).sort((a, b) => (a.k < b.k ? -1 : 1));
    const w0 = weights.length ? weights[weights.length - 1].w : p.weight;
    const t = E.compute({ ...p, weight: w0 });
    const h = habits(p, days, today, t);
    const tr = trend(weights, today);
    const cal = calibrate(p, weights, days, today, t.bmr);
    const goalW = p.goalW || null;
    const losing = goalW ? goalW < w0 : p.goal === "lose" || p.goal === "recomp";

    const out = { today, w0, target: t.target, tdee: t.tdee, bmr: t.bmr, habits: h, trend: tr, calibration: cal, goalW, losing, enough: h.intake != null && h.completeDays >= 3 };
    const planPath = simulate(p, w0, t.target, horizon); // the plan assumes the target is eaten as logged
    out.plan = { path: planPath, reach: reachDay(planPath, goalW, losing) };
    if (out.enough) {
      const bias = cal.bias; // add what the scale says the log is missing
      const I = h.intake;
      const spread = Math.max(80, (h.sd || 0) / Math.sqrt(Math.max(1, h.completeDays)) + Math.abs(bias) * (1 - cal.confidence) * 0.5);
      const mid = simulate(p, w0, I, horizon, bias);
      const lo = simulate(p, w0, I - 1.28 * spread, horizon, bias);
      const hi = simulate(p, w0, I + 1.28 * spread, horizon, bias);
      out.habit = { intake: I, effective: I + bias, path: mid, lo, hi, reach: reachDay(mid, goalW, losing) };
      out.at = wk => ({ habit: mid[wk * 7], plan: planPath[wk * 7] });
      out.ratePerWeek = (mid[28] - w0) / 4;
    }
    out.alerts = alerts(out, p, t);
    return out;
  }

  function alerts(f, p, t) {
    const list = [];
    const fmtDate = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }); };
    if (f.habits.quality < 0.5 || !f.enough) {
      list.push({ level: "track", title: "Your forecast needs more data", body: `You logged ${f.habits.logged7} of the last 7 days${f.habits.partialDays ? `, and ${f.habits.partialDays} logged day${f.habits.partialDays > 1 ? "s look" : " looks"} incomplete` : ""}. Log every meal for 3 full days and Dabba can predict where your habits are heading.` });
      return list;
    }
    const H = f.habit, w12 = H.path[84], p12 = f.plan.path[84];
    const diff12 = w12 - p12;
    if (H.effective < Math.max(t.bmr * 0.9, p.sex === "f" ? 1200 : 1500) || f.ratePerWeek < -f.w0 * 0.01) {
      list.push({ level: "under", title: "You're eating too little to stay healthy", body: `At about ${Math.round(H.effective)} kcal a day you'd lose ${Math.abs(f.ratePerWeek).toFixed(2)} kg a week, faster than the 0.5 kg a week ICMR considers safe. Fast losses come partly from muscle and tend to rebound. Eat closer to your ${t.target} kcal target.` });
    }
    if (f.calibration.intervals >= 2 && f.calibration.bias > 200) {
      list.push({ level: "unlogged", title: "Your scale and your log disagree", body: `Your weigh-ins suggest about ${Math.round(f.calibration.bias / 10) * 10} kcal a day more than you're logging. Common culprits: cooking oil and ghee, chai, second helpings and snacks between meals.` });
    }
    const wantsLoss = f.losing && p.goal !== "gain";
    if (wantsLoss && diff12 > 0.75) {
      const habitEta = H.reach, planEta = f.plan.reach;
      const eta = f.goalW ? (habitEta == null ? `you won't reach ${f.goalW} kg within a year on this path` : `your goal of ${f.goalW} kg moves from ${planEta != null ? fmtDate(planEta) : "later"} to ${fmtDate(habitEta)}`) : "";
      list.push({ level: "over", title: w12 > f.w0 ? "This path leads to weight gain" : "This path slows your progress", body: `You're averaging ${Math.round(H.intake)} kcal against a ${t.target} kcal target. In 12 weeks that puts you at ${w12.toFixed(1)} kg instead of ${p12.toFixed(1)} kg${eta ? `, and ${eta}` : ""}.` });
    } else if (!wantsLoss && p.goal !== "gain" && w12 - f.w0 > 1.5) {
      list.push({ level: "over", title: "This path leads to weight gain", body: `At about ${Math.round(H.intake)} kcal a day you'd weigh ${w12.toFixed(1)} kg in 12 weeks, ${(w12 - f.w0).toFixed(1)} kg more than today.` });
    }
    if (!list.length) list.push({ level: "good", title: "You're on track", body: `At your current habits you'll be about ${w12.toFixed(1)} kg in 12 weeks${H.reach != null && f.goalW ? ` and reach ${f.goalW} kg around ${fmtDate(H.reach)}` : ""}.` });
    return list;
  }

  const API = { forecast, simulate, habits, trend, calibrate };
  if (typeof module !== "undefined" && module.exports) module.exports = API; else root.DabbaForecast = API;
})(typeof window !== "undefined" ? window : globalThis);
