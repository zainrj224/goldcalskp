# Gold Rate Live Trading Board

Static HTML/CSS/JS site — no build step needed.

## Deploy to Vercel

**Option A — Vercel CLI (fastest)**
```bash
npm i -g vercel
cd gold-rate-board
vercel
```
Follow the prompts (link/create project, accept defaults). Then run `vercel --prod` to publish.

**Option B — GitHub + Vercel dashboard**
1. Push this folder to a GitHub repo.
2. Go to https://vercel.com/new and import the repo.
3. Framework Preset: **Other**. Leave Build Command empty (or use the default `npm run build`, which just echoes since this is static). Output Directory: `.` (root).
4. Click Deploy.

That's it — `index.html` is served directly.
