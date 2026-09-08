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
   - `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` — see below. Without these, the
     server falls back to a local SQLite file, which **will get wiped** on Render's
     free tier (see below).
   - Render sets `PORT` automatically — don't set it yourself.
6. Deploy. Your site (marketing pages + `/tournaments.html` + `/admin.html`) will
   be live at the `.onrender.com` URL Render gives you.

## Data persistence (Turso)

Render's free tier has an ephemeral filesystem — it resets on every redeploy and
on periodic restarts, silently wiping any local file. The database was migrated
to [Turso](https://turso.tech) (a free hosted SQLite-compatible database) to fix
this. To set it up:

1. Sign up at [turso.tech](https://turso.tech) (free tier is generous for this).
2. Create a database (via their dashboard or the `turso` CLI).
3. Get its connection URL and an auth token from the dashboard.
4. In Render's Environment Variables, add:
   - `TURSO_DATABASE_URL` = the `libsql://...` URL from Turso
   - `TURSO_AUTH_TOKEN` = the auth token from Turso
5. Redeploy. From then on, tournament data survives restarts/redeploys.

Locally, leave these two unset — `server/db.js` automatically falls back to a
plain local `data.db` file when they're not present, so local dev needs no Turso
account at all.

## Updating the site later

Any time you push new commits to `main`, Render redeploys automatically (if
auto-deploy is on, which is the default).

## Custom domain (optional)

Render supports adding a custom domain under the service's Settings → Custom
Domains, once you're ready to point your own domain at it.
