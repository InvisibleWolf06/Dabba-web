# Dabba website (GitHub Pages)

This is the public website. "Get the app" sends phones to your Dabba app hosted on Firebase, where the install step opens automatically.

## 1. Connect it to your app

Deploy the **dabba-app-firebase** zip first (see its README). Then open `index.html`, search for `APP_URL` and paste your app's address:

```js
const APP_URL = "https://your-project.web.app/";
```

Keep the `/` at the end.

## 2. Upload to GitHub

1. **Create the repository.** On github.com, click **New repository**, name it `dabba`, make it **Public**, then **Create repository**.
2. **Upload the files.** Click **uploading an existing file** and drag in **everything in this folder**: `index.html`, `engine.js`, `forecast.js`, `privacy.html`, `delete-account.html`, `style.css`, the `icons` and `vendor` folders, and the hidden `.nojekyll` file. Then **Commit changes**.
3. **Turn on Pages.** Go to **Settings → Pages**, set Source to **Deploy from a branch**, Branch to `main` / `(root)`, then **Save**.
4. **Check it.** After 1 to 2 minutes the site is live at `https://<your-username>.github.io/dabba/`.

## What "Get the app" does

| Visitor | Result |
|---|---|
| Android | Opens your app with `?install=1`. In Chrome, one tap on **Install now** installs it with its own icon. |
| iPhone | Opens your app, which shows the Safari steps: Share → Add to Home Screen |
| Laptop | Shows a QR code to scan with the phone |

The link to share on WhatsApp or Instagram is `https://your-project.web.app/?install=1`, or simply your GitHub site.

## Optional: an .apk download

1. **Make the file.** Go to pwabuilder.com, enter your `APP_URL`, then **Package for stores → Android**. Keep the signing key it gives you.
2. **Publish it.** Upload the `.apk` to your repo's **Releases**, named `dabba.apk`.
3. **Link it.** Set `APK_URL` in `index.html` to `https://github.com/<you>/dabba/releases/latest/download/dabba.apk`.

People installing the APK will see "unknown app" warnings. That's why the browser install is the main path.

Before publishing, fill in every [BRACKETED] value in `privacy.html` and `delete-account.html`.
