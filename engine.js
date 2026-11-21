// Dabba Engine — an India-calibrated energy and nutrient target model.
// Pure functions only: no DOM. Works in the browser (window.DabbaEngine) and in Node (module.exports).
(function (root) {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const round = (v, s = 1) => Math.round(v / s) * s;

  const OCCUPATION = {
    desk:     { f: 1.10, label: "Mostly sitting (desk, study, driving)" },
    mixed:    { f: 1.20, label: "On your feet part of the day (teaching, retail)" },
    field:    { f: 1.30, label: "Moving most of the day (field work, nursing)" },
    manual:   { f: 1.45, label: "Heavy physical work (construction, farming, loading)" }
  };
  const EXERCISE = {
    none:     { met: 0,   label: "No planned exercise" },
    yoga:     { met: 3.0, label: "Yoga / stretching" },
    walk:     { met: 3.8, label: "Brisk walking" },
    strength: { met: 5.0, label: "Gym / strength training" },
    sport:    { met: 6.5, label: "Cricket, football, badminton" },
    cycle:    { met: 7.0, label: "Cycling" },
    dance:    { met: 5.5, label: "Dance / Zumba" },
    run:      { met: 9.0, label: "Running" }
  };
  const REGION = {
    north: { label: "North", staple: "wheat rotis", swap: "Swap one roti a meal for a bajra or jowar roti, and add a bowl of dal or paneer." },
    south: { label: "South", staple: "rice", swap: "Make half the rice plate sambar, kootu or poriyal; swap the second helping of rice for ragi or millets." },
    east:  { label: "East",  staple: "rice and fish", swap: "Keep the fish, trim the second rice helping, and add a dal and a leafy saag." },
    west:  { label: "West",  staple: "rotli, rice and farsan", swap: "Keep farsan for weekends; add sprouts or curd to dal-rice-shaak." },
    ne:    { label: "North East", staple: "rice", swap: "Lean into boiled greens and meat or fish; keep rice to one cup a meal." }
  };
  const CLIMATE = {
    hot_humid: { label: "Hot and humid (Chennai, Mumbai, Kolkata)", water: 600, energy: 0 },
    hot_dry:   { label: "Hot and dry (Delhi summer, Rajasthan)", water: 800, energy: 0 },
    moderate:  { label: "Moderate (Bengaluru, Pune)", water: 250, energy: 0 },
    cold:      { label: "Cold (hills, North Indian winter)", water: 0, energy: 0.03 }
  };

  // Body-fat estimate. RFM (Woolcott & Bergman 2018) when waist is known; otherwise
  // Deurenberg BMI equation with a South Asian offset (+2.5 points), since Indians carry
  // more fat at the same BMI than the European groups the equation was built on.
  function bodyFat(p) {
    const bmi = p.weight / Math.pow(p.height / 100, 2);
    if (p.waist && p.waist > 40) {
      const rfm = 64 - 20 * (p.height / p.waist) + (p.sex === "f" ? 12 : 0);
      return { pct: clamp(rfm, 5, 55), method: "Relative Fat Mass (height ÷ waist)" };
    }
    const d = 1.2 * bmi + 0.23 * p.age - 10.8 * (p.sex === "m" ? 1 : 0) - 5.4 + 2.5;
    return { pct: clamp(d, 5, 55), method: "BMI-based estimate with South Asian adjustment" };
  }

  // Asian-Indian BMI cut-offs (Misra et al., Indian consensus 2009).
  function bmiBand(bmi) {
    if (bmi < 18.5) return { key: "under", label: "Underweight" };
    if (bmi < 23) return { key: "normal", label: "Healthy range (Asian Indian scale)" };
    if (bmi < 25) return { key: "over", label: "Overweight (Asian Indian scale)" };
    return { key: "obese", label: "Obesity range (Asian Indian scale)" };
  }

  function lutealDay(p, now) {
    if (p.sex !== "f" || !p.cycleTrack || !p.lastPeriod) return false;
    const d = Math.floor((now - new Date(p.lastPeriod).getTime()) / 864e5);
    const len = p.cycleLen || 28;
    const day = ((d % len) + len) % len + 1;
    return day > len - 14 && day <= len;
  }

  function compute(p, opts = {}) {
    const now = opts.now || Date.now();
    const steps = [];
    const hM = p.height / 100;
    const bmi = p.weight / (hM * hM);
    const band = bmiBand(bmi);
    const bf = bodyFat(p);
    const lbm = p.weight * (1 - bf.pct / 100);
    const whtr = p.waist ? p.waist / p.height : null;
    const central = whtr ? whtr >= 0.5 : (band.key === "over" || band.key === "obese");

    // 1. Resting energy: blend Mifflin–St Jeor (trimmed 5%: it reads high for Indian adults)
    //    with Katch–McArdle (lean-mass driven). The blend lets body composition matter.
    const mifflin = 10 * p.weight + 6.25 * p.height - 5 * p.age + (p.sex === "m" ? 5 : -161);
    const katch = 370 + 21.6 * lbm;
    let bmr = 0.5 * mifflin * 0.95 + 0.5 * katch;
    let bmrNote = "Average of Mifflin–St Jeor (minus 5% for Indian metabolism) and Katch–McArdle from lean mass";
    if (p.health === "hypo") { bmr *= 0.95; bmrNote += "; −5% for hypothyroidism"; }
    const luteal = lutealDay(p, now);
    if (luteal) { bmr *= 1.05; bmrNote += "; +5% luteal phase"; }
    steps.push({ k: "Resting burn", v: bmr, d: bmrNote });

    // 2. Daily life: occupation multiplier applied to resting burn
    const occ = OCCUPATION[p.occupation] || OCCUPATION.desk;
    const daily = bmr * (occ.f - 1);
    steps.push({ k: "Work and chores", v: daily, d: occ.label });

    // 3. Steps above a 3,000 baseline (≈0.0005 kcal per step per kg)
    const extraSteps = Math.max(0, (p.steps || 0) - 3000);
    const neat = extraSteps * p.weight * 0.0005;
    steps.push({ k: "Walking", v: neat, d: `${(p.steps || 0).toLocaleString("en-IN")} steps a day` });

    // 4. Planned exercise, averaged over the week (net MET)
    const ex = EXERCISE[p.exercise] || EXERCISE.none;
    const exMin = (p.exDays || 0) * (p.exMins || 0);
    const eat = ex.met > 0 ? ((ex.met - 1) * 3.5 * p.weight / 200) * exMin / 7 : 0;
    steps.push({ k: "Exercise", v: eat, d: ex.met ? `${ex.label}, ${p.exDays}×${p.exMins} min a week` : ex.label });

    // 5. Digestion (thermic effect). Lower for cereal-heavy vegetarian plates, higher with more protein.
    const tefPct = { vg: 0.08, v: 0.085, jain: 0.08, e: 0.09, n: 0.095 }[p.diet] || 0.09;
    let sub = bmr + daily + neat + eat;
    const climate = CLIMATE[p.climate] || CLIMATE.moderate;
    const tef = sub * tefPct;
    steps.push({ k: "Digestion", v: tef, d: `${Math.round(tefPct * 1000) / 10}% for a ${dietLabel(p.diet).toLowerCase()} plate` });
    let tdee = sub + tef;
    if (climate.energy) { steps.push({ k: "Cold climate", v: tdee * climate.energy, d: "+3% to keep warm" }); tdee *= 1 + climate.energy; }

    // 6. Goal. Deficit size scales with body fat, and shrinks with short sleep or high stress,
    //    which raise hunger and muscle loss on a diet.
    let adj = 0, goalNote = "";
    const sleepPenalty = p.sleep < 6 ? 0.05 : p.sleep < 7 ? 0.02 : 0;
    const stressPenalty = p.stress >= 4 ? 0.04 : p.stress === 3 ? 0.01 : 0;
    if (p.goal === "lose") {
      const base = clamp(0.12 + (bf.pct - (p.sex === "f" ? 25 : 15)) * 0.006, 0.12, 0.25);
      const pace = p.pace === "fast" ? 0.04 : p.pace === "slow" ? -0.04 : 0;
      const deficit = clamp(base + pace - sleepPenalty - stressPenalty, 0.08, 0.27);
      adj = -tdee * deficit;
      goalNote = `${Math.round(deficit * 100)}% deficit, sized to your body fat` + (sleepPenalty || stressPenalty ? ", eased for sleep and stress" : "");
    } else if (p.goal === "gain") {
      const surplus = p.pace === "fast" ? 0.15 : p.pace === "slow" ? 0.07 : 0.10;
      adj = tdee * surplus; goalNote = `${Math.round(surplus * 100)}% surplus for lean gain`;
    } else if (p.goal === "recomp") {
      adj = -tdee * 0.05; goalNote = "Small 5% deficit with high protein to trade fat for muscle";
    } else goalNote = "Maintain current weight";
    if (adj) steps.push({ k: "Goal", v: adj, d: goalNote });

    let target = tdee + adj;
    // Pregnancy / lactation (ICMR-NIN 2020 increments) override weight-loss deficits.
    if (p.life === "preg") { target = tdee + 350; steps.push({ k: "Pregnancy", v: 350, d: "ICMR +350 kcal (2nd–3rd trimester); deficit removed" }); }
    if (p.life === "lact") { target = tdee + 600; steps.push({ k: "Breastfeeding", v: 600, d: "ICMR +600 kcal (0–6 months); deficit removed" }); }

    // Safety floors
    const floor = Math.max(bmr * 1.0, p.sex === "f" ? 1200 : 1500);
    let floored = false;
    if (target < floor) { target = floor; floored = true; }
    target = round(target, 10);

    // Macros
    const refWeight = bmi > 25 ? 23 * hM * hM : p.weight; // protein on a healthy-BMI weight
    let pPerKg = { lose: 1.4, maintain: 1.0, gain: 1.6, recomp: 1.7 }[p.goal] || 1.0;
    if (p.exercise === "strength") pPerKg += 0.2;
    if (p.age >= 60) pPerKg += 0.1;
    if (p.life === "preg" || p.life === "lact") pPerKg = Math.max(pPerKg, 1.2);
    const protein = round(refWeight * pPerKg, 1);
    const carbCap = (central || p.health === "diabetes" || p.health === "pcos") ? 0.45 : 0.55;
    let fatPct = 0.27;
    let fat = round(target * fatPct / 9, 1);
    let carbs = round((target - protein * 4 - fat * 9) / 4, 1);
    if (carbs * 4 / target > carbCap) {
      carbs = round(target * carbCap / 4, 1);
      fat = round((target - protein * 4 - carbs * 4) / 9, 1);
    }
    const fibre = round(target / 1000 * 15, 1);              // ICMR: ~15 g per 1000 kcal
    const sugar = round(target * 0.05 / 4, 1);               // added sugar under 5% of energy
    const sodium = p.health === "bp" ? 1500 : 2000;          // <5 g salt
    const iron = p.sex === "f" ? (p.life === "preg" ? 27 : 29) : 19; // ICMR-NIN 2020 RDA
    const calcium = p.age >= 50 && p.sex === "f" ? 1200 : 1000;

    // Water: 35 ml/kg + exercise + climate
    const water = round(33 * refWeight + (exMin / 7) * 10 + climate.water + (p.life === "lact" ? 700 : p.life === "preg" ? 300 : 0), 50);

    return {
      target, tdee: round(tdee, 10), bmr: round(bmr, 10), floored, steps,
      bmi: Math.round(bmi * 10) / 10, band, bf: Math.round(bf.pct * 10) / 10, bfMethod: bf.method,
      lbm: Math.round(lbm * 10) / 10, whtr: whtr ? Math.round(whtr * 100) / 100 : null, central, luteal,
      macros: { protein, carbs, fat, fibre, sugar, sodium, iron, calcium },
      carbCap, water, region: REGION[p.region] || REGION.north,
      sleepNote: p.sleep < 7 ? "Under 7 hours of sleep raises hunger; your deficit was eased." : null
    };
  }

  function dietLabel(d) {
    return { vg: "Vegan", v: "Vegetarian", jain: "Jain", e: "Eggetarian", n: "Non-vegetarian" }[d] || "Mixed";
  }

  // Thali Score: 0–100 for a day. Rewards accuracy and balance; under-eating scores as badly as over-eating.
  function thaliScore(day, t, waterTarget) {
    const s = sumDay(day);
    if (!day || !day.items || day.items.length === 0) return { total: 0, parts: null, s };
    const r = s.kcal / t.target;
    const dev = Math.abs(r - 1);
    const energy = dev <= 0.07 ? 35 : dev >= 0.35 ? 0 : 35 * (1 - (dev - 0.07) / 0.28);
    const protein = 20 * clamp(s.protein / t.macros.protein, 0, 1);
    const fibre = 10 * clamp(s.fibre / t.macros.fibre, 0, 1);
    const water = 15 * clamp((day.water || 0) / waterTarget, 0, 1);
    const sugarPart = s.sugar <= t.macros.sugar * 1.6 ? 5 : s.sugar >= t.macros.sugar * 3 ? 0 : 5 * (1 - (s.sugar - t.macros.sugar * 1.6) / (t.macros.sugar * 1.4));
    const naPart = s.sodium <= t.macros.sodium ? 5 : s.sodium >= t.macros.sodium * 1.8 ? 0 : 5 * (1 - (s.sodium - t.macros.sodium) / (t.macros.sodium * 0.8));
    const slots = new Set(day.items.map(i => i.meal)).size;
    const logging = Math.min(10, slots * 3.4);
    const parts = { energy, protein, fibre, water, limits: sugarPart + naPart, logging };
    const total = Math.round(Object.values(parts).reduce((a, b) => a + b, 0));
    return { total: clamp(total, 0, 100), parts, s };
  }

  function sumDay(day) {
    const s = { kcal: 0, protein: 0, carbs: 0, fat: 0, fibre: 0, sugar: 0, sodium: 0, iron: 0, calcium: 0 };
    if (!day || !day.items) return s;
    for (const i of day.items) for (const k in s) s[k] += (i[k] || 0) * (i.qty || 1);
    return s;
  }

  // Fasting bonus XP for a completed fast
  function fastXp(f) {
    if (!f || !f.end) return 0;
    const h = (f.end - f.start) / 36e5;
    if (h < 12 || h < f.target * 0.9) return 0;
    return Math.min(80, Math.round(20 + Math.max(0, h - 12) * 5));
  }

  const LEVELS = ["Chai Rookie", "Poha Starter", "Idli Regular", "Dal Devotee", "Roti Ranger", "Sabzi Sage", "Thali Builder", "Millet Maven", "Masala Master", "Dabba Legend"];
  function levelFor(xp) {
    let lvl = 0, need = 300;
    let acc = 0;
    while (xp >= acc + need && lvl < 99) { acc += need; lvl++; need = Math.round(need * 1.25); }
    return { n: lvl + 1, name: LEVELS[Math.min(lvl, LEVELS.length - 1)], into: xp - acc, need, pct: (xp - acc) / need };
  }

  const API = { compute, thaliScore, sumDay, fastXp, levelFor, bodyFat, bmiBand, dietLabel, OCCUPATION, EXERCISE, REGION, CLIMATE, LEVELS };
  if (typeof module !== "undefined" && module.exports) module.exports = API; else root.DabbaEngine = API;
})(typeof window !== "undefined" ? window : globalThis);
