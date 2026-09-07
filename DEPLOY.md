# Deploying this site

This repo is a static marketing site (`index.html` + `assets/`) plus a small Node
backend (`server/`) that runs the tournament system. One Render service serves
everything — the Node server hosts the static files itself.

## 1. Push to GitHub

```bash
cd ~/pdh2-website
git remote add origin https://github.com/<your-username>/<repo-name>.git
git branch -M main
git push -u origin main
```

(Create the empty repo on GitHub first if you haven't — no README/license/gitignore,
since this repo already has its own.)

## 2. Create the Render service

1. Go to Render → **New** → **Web Service** → connect the GitHub repo you just pushed.
2. **Root Directory**: leave blank (repo root).
3. **Build Command**: `npm install --prefix server`
4. **Start Command**: `node server/server.js`
5. **Environment Variables** — add:
   - `ADMIN_PASSWORD` = a real password (never reuse the one from local testing/`.env`)
   - `NODE_ENV` = `production`
   - Render sets `PORT` automatically — don't set it yourself.
6. Deploy. Your site (marketing pages + `/tournaments.html` + `/admin.html`) will
   be live at the `.onrender.com` URL Render gives you.

## Important: data persistence

Tournament data lives in a SQLite file (`server/data.db`) on the service's local
disk. **Render's free tier has an ephemeral filesystem** — it resets on every
redeploy and on periodic restarts, silently wiping all tournaments, signups, and
chat history. Fine for testing; if you want tournament data to survive real use,
add a Render persistent disk (paid) mounted at the `server/` directory, or move to
a real hosted database later.

## Updating the site later

Any time you push new commits to `main`, Render redeploys automatically (if
auto-deploy is on, which is the default).

## Custom domain (optional)

Render supports adding a custom domain under the service's Settings → Custom
Domains, once you're ready to point your own domain at it.
