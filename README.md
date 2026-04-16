# VoiceCast

A Chrome extension that replaces Google's cast panel for animated shows and movies with a richer panel showing each animated character alongside their real voice actor's photo and name.

**Search "shrek cast" on Google → see Shrek's face next to Mike Myers.**

---

## How It Works

When you search Google for `[show name] cast` (e.g. "toy story cast"), VoiceCast:

1. Detects the query and extracts the show title
2. Confirms the show is animated (via TMDB)
3. Waits for Google's cast panel to appear
4. Replaces it with a horizontal scrollable card row — one card per character, showing:
   - The animated character's image
   - The character's name
   - The voice actor's photo
   - The voice actor's name

If the show isn't in the database yet, VoiceCast anonymously reports it and the daily auto-scraper adds it within 24 hours.

---

## Three-Layer Data Architecture

| Layer | Source | Speed | Coverage |
|-------|--------|-------|----------|
| 1 — Bundled | `extension/data/shows.json` | Instant, offline | Top ~100 shows |
| 2 — GitHub | `data/database.json` (this repo) | Fast (cached 7 days) | Growing via automation |
| 3 — TMDB proxy | Vercel serverless function | Network call | Any animated show |

Layer 2 overrides Layer 1 for the same show. Layer 3 is used only when a show isn't in Layers 1 or 2.

---

## Platform Support

| Platform | Status |
|----------|--------|
| Chrome desktop (Mac, Windows, Linux) | ✅ Full support |
| Android Chrome 128+ | ✅ Supported |
| Chrome for iOS | ❌ Not supported — Apple does not allow Chrome extensions on iOS |
| Other Chromium browsers (Edge, Brave) | ✅ Should work |

---

## Project Structure

```
VoiceCast/
├── extension/              # Chrome extension (load this folder in Chrome)
│   ├── manifest.json       # MV3 manifest
│   ├── content.js          # Content script: query detection + panel injection
│   ├── background.js       # Service worker: caching + network requests
│   ├── options.html/js     # Options page: cache management
│   ├── data/shows.json     # Layer 1 bundled database
│   ├── styles/panel.css    # Panel styles
│   └── assets/icons/       # Extension icons
├── data/
│   ├── database.json       # Layer 2 master database
│   ├── images/             # Re-hosted character images (200px wide)
│   ├── schema.md           # JSON schema documentation
│   └── CREDITS.md          # CC-BY-SA attribution for Fandom images
├── api/
│   ├── tmdb-proxy.js       # Vercel: proxied TMDB lookups
│   └── report-missing.js   # Vercel: anonymous missing-show reports
├── scripts/
│   └── scraper.js          # CLI: scrape Fandom + TMDB for a new show
├── .github/workflows/
│   ├── scrape-missing.yml  # Daily: process missing-show GitHub Issues
│   └── ci.yml              # PR gate: run tests
└── tests/                  # Jest test suite
```

---

## Git Setup for Mac (First Time)

If you've never used Git on this Mac:

```bash
# 1. Install Homebrew (if not installed)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# 2. Install Git
brew install git

# 3. Configure your identity
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
```

Then create the GitHub repo:
1. Go to [github.com](https://github.com) → **New repository** → name it `VoiceCast`
2. Set to **Public**, do NOT check "Add a README"
3. Click **Create repository**

Then connect your local folder:
```bash
cd ~/Desktop/VoiceCast
git init
git remote add origin https://github.com/YOUR_USERNAME/VoiceCast.git
git add .
git commit -m "Initial commit: VoiceCast extension"
git branch -M main
git push -u origin main

# Create dev branch for all work
git checkout -b dev
git push -u origin dev
```

**Branching strategy:**
- `main` — always stable and deployable
- `dev` — all development happens here
- Merge to `main` via Pull Requests only
- CI runs tests on every PR

---

## Development Setup

```bash
# Install dependencies
npm install

# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Run scraper for a new show
TMDB_API_KEY=your_key node scripts/scraper.js --title "Shrek" --tmdb-id 808 --type movie
```

---

## Loading the Extension in Chrome

1. Open Chrome → navigate to `chrome://extensions`
2. Enable **Developer mode** (toggle top-right)
3. Click **Load unpacked**
4. Select the `extension/` folder inside your VoiceCast project
5. VoiceCast will appear in your extensions list

To reload after making changes:
- Click the **reload icon** (↺) on the VoiceCast card in `chrome://extensions`
- Then do a **hard refresh** (`Cmd+Shift+R`) on any Google tab

---

## Environment Variables

### Vercel (set in Vercel dashboard → Settings → Environment Variables)

| Variable | Description |
|----------|-------------|
| `TMDB_API_KEY` | Your TMDB API v3 key (get at themoviedb.org/settings/api) |
| `UPSTASH_REDIS_REST_URL` | From your Upstash Redis database dashboard |
| `UPSTASH_REDIS_REST_TOKEN` | From your Upstash Redis database dashboard |
| `GITHUB_PAT` | GitHub Personal Access Token with `repo` scope (for creating issues) |
| `GITHUB_REPO` | Your repo in `username/VoiceCast` format |

### GitHub Actions (set in repo → Settings → Secrets and variables → Actions)

| Secret | Description |
|--------|-------------|
| `TMDB_API_KEY` | Same TMDB key as above |

### Local `.env` (for running the scraper locally)

Create a `.env` file in the project root (it's gitignored):
```
TMDB_API_KEY=your_tmdb_key_here
```

Then run: `source .env && node scripts/scraper.js --title "Shrek" --tmdb-id 808 --type movie`

---

## Deploying to Vercel

1. Install Vercel CLI: `npm i -g vercel`
2. Run `vercel` in the project root and follow prompts
3. Set all environment variables in the Vercel dashboard
4. After deployment, copy your Vercel URL (e.g. `https://voicecast-abc123.vercel.app`)
5. Update `VERCEL_URL` in `extension/background.js`
6. Update `LAYER2_URL` and `GITHUB_RAW_ROOT` in `extension/background.js` with your GitHub username
7. Reload the extension in Chrome

---

## Debugging

### Content script logs

The content script tags all logs with `[VoiceCast]`:

1. Open `https://www.google.com/search?q=shrek+cast`
2. Right-click anywhere → **Inspect** → **Console** tab
3. Look for `[VoiceCast]` entries
4. To copy an error: right-click the error line → **Copy** → paste into Claude Code

### Service worker logs

The background service worker has its own console:

1. Go to `chrome://extensions`
2. Find VoiceCast → click **"Service worker"** link
3. A DevTools window opens showing the service worker console

### Network requests

To verify requests go to Vercel (not directly to TMDB):

1. Open DevTools → **Network** tab
2. Search `https://www.google.com/search?q=shrek+cast`
3. Look for requests to `voicecast.vercel.app` — you should see `/api/tmdb-proxy`
4. You should NOT see requests directly to `api.themoviedb.org`

### Testing specific queries

Use these URLs to test directly:
```
# Known show (Layer 1)
https://www.google.com/search?q=shrek+cast

# TV show
https://www.google.com/search?q=the+simpsons+cast

# False positive (should NOT trigger VoiceCast)
https://www.google.com/search?q=cast+iron+skillet
https://www.google.com/search?q=broadcast+news+cast

# Unknown show (hits TMDB proxy + files missing report)
https://www.google.com/search?q=spirited+away+cast
```

### Common issues

**Extension not triggering:**
- Check that the URL is `google.com/search` (not google.co.uk etc. — see manifest `host_permissions`)
- Verify "cast" appears as a separate word in the query
- Check the Console for `[VoiceCast]` logs — if there are none, the query didn't pass detection

**Panel not replacing Google's panel:**
- Google's DOM structure changes frequently. Check the Console for `[VoiceCast] injectPanel error`
- Google may not be showing a cast panel for this query — try a more popular show

**Images not loading:**
- The `GITHUB_RAW_ROOT` URL in `background.js` must point to your actual GitHub repo
- Character images must be committed and pushed to the `main` branch

---

## Adding Shows to the Database Manually

```bash
# Set your TMDB API key
export TMDB_API_KEY=your_key_here

# Add a movie
node scripts/scraper.js --title "Toy Story" --tmdb-id 862 --type movie

# Add a TV show (specify fandom wiki slug if different from title)
node scripts/scraper.js --title "The Simpsons" --tmdb-id 456 --type tv --fandom-wiki simpsons

# Then copy the updated database into the extension bundle
cp data/database.json extension/data/shows.json
```

Commit and push the changes — they go live as Layer 2 when users' 7-day cache expires.

---

## Self-Growing Database

When a user searches an animated show not in the database:

1. Extension sends anonymous report (title only) to `POST /api/report-missing`
2. Vercel function creates a GitHub Issue labeled `missing-show` (deduped + rate limited)
3. Daily GitHub Actions workflow processes up to 5 open issues:
   - Searches TMDB for the title, confirms animation genre
   - Runs the scraper to get cast + Fandom images
   - Commits to `data/database.json`, closes the issue

To trigger the workflow manually: GitHub → Actions → "Scrape Missing Shows" → **Run workflow**.

---

## Contributing

1. Fork the repo and create your feature branch from `dev`
2. Make changes, run `npm test` — all tests must pass
3. Submit a PR to `dev` (not `main`)
4. CI will run automatically; PRs with failing tests are blocked from merge
