
# VoiceCast — Session Handoff Document

## Project Overview
VoiceCast is a Chrome extension that replaces Google's native cast panel for animated shows and movies with a richer panel showing each animated character alongside their real voice actor's photo and name. For example, searching "shrek cast" on Google shows Shrek's face next to Mike Myers.

## Key People & Accounts
- **GitHub username:** matanrotman
- **GitHub repo:** https://github.com/matanrotman/VoiceCast
- **Vercel project:** https://voice-cast-eight.vercel.app
- **OS:** Mac

## Project Location
- **Local folder:** `/Users/matanrotman/Desktop/VoiceCast`
- **Active branch:** `dev` (main is protected, merge via PR)
- **Extension folder:** `/Users/matanrotman/Desktop/VoiceCast/extension`

## Architecture

### Chrome Extension (Manifest V3)
- `extension/manifest.json` — MV3 manifest, minimum permissions
- `extension/content.js` — detects "cast" queries, MutationObserver, injects panel
- `extension/background.js` — service worker, caching, network requests
- `extension/options.html/js` — options page
- `extension/styles/panel.css` — mimics Google cast panel, light/dark mode
- `extension/data/shows.json` — Layer 1 bundled database (top shows, JSON only, no images)

### Three-Layer Data System
- **Layer 1:** `extension/data/shows.json` — bundled, works offline, top ~30 shows
- **Layer 2:** `data/database.json` — GitHub-hosted, fetched at runtime, cached 7 days
- **Layer 3:** TMDB API via Vercel proxy — fallback for unknown shows

### Database Schema (data/database.json)
Each show entry looks like:
```json
{
  "title": "Frozen",
  "matched_title": "Frozen",
  "tmdb_id": 109445,
  "tmdb_type": "movie",
  "fandom_wiki": "disney",
  "characters": [
    {
      "character_name": "Elsa",
      "fandom_page_name": "Elsa",
      "voice_actor": "Idina Menzel",
      "voice_actor_tmdb_id": 19394,
      "voice_actor_photo": "https://image.tmdb.org/t/p/w185/...",
      "character_image": "https://raw.githubusercontent.com/matanrotman/VoiceCast/main/data/images/frozen/elsa.png",
      "character_image_placeholder": false,
      "character_image_source": "https://disney.fandom.com/..."
    }
  ]
}
```

### Backend (Vercel Serverless)
- `api/tmdb-proxy.js` — proxies TMDB API calls (user doesn't need their own key for basic use)
- `api/report-missing.js` — receives anonymous show title reports, opens GitHub Issues

### Self-Growing Database
- When a user searches an animated show not in the database, the extension sends the title anonymously to the Vercel function
- Vercel opens a GitHub Issue labeled `missing-show`
- GitHub Actions workflow (`.github/workflows/scrape-missing.yml`) runs daily, processes issues, adds shows to database
- This is already working — GitHub issues are being created automatically

### Image Storage
- Character images are downloaded and stored in `data/images/[show-slug]/[character-slug].ext`
- Served via GitHub raw URLs: `https://raw.githubusercontent.com/matanrotman/VoiceCast/main/data/images/...`
- Actor photos come from TMDB CDN directly (stable URLs, no download needed)
- Images are NOT bundled in the extension to stay under Chrome's size limits

## Environment Variables

### Vercel (already set)
- `TMDB_API_KEY` — TMDB API v3 key
- `UPSTASH_REDIS_REST_URL` — Upstash Redis for rate limiting
- `UPSTASH_REDIS_REST_TOKEN` — Upstash Redis token
- `GITHUB_PAT` — GitHub Personal Access Token with repo scope
- `GITHUB_REPO` — `matanrotman/VoiceCast`

### Local (for running scripts)
- `export TMDB_API_KEY=...` — needed before running any data scripts

### GitHub Actions Secrets (already set)
- `TMDB_API_KEY`

## Current Database State (as of this session)
- **Total shows:** 942
- **Shows with fandom_wiki saved:** ~105 (growing as script runs)
- **Shows with character images:** ~93
- **Total characters:** ~44,000+
- **Characters with actor photos:** ~36,000+
- **Characters with character images:** growing

## Scripts

### Data Scripts (run from project root with TMDB_API_KEY set)
- `scripts/build-show-database.js` — **MAIN SCRIPT** — unified builder combining Fandom + TMDB
  - `--show "Title"` — process one show
  - `--all` — process all shows
  - `--force` — reprocess shows that already have character images
  - Saves progress after each show, safe to stop and restart
  - Already saves `fandom_wiki` field per show so rediscovery is skipped on rerun
- `scripts/fetch-cast-data-v3.js` — old cast fetcher (still works, kept for reference)
- `scripts/fetch-character-images-v2.js` — old image fetcher (superseded by build-show-database.js)
- `scripts/patch-actor-photos.js` — patches missing actor photos by re-fetching TMDB
- `scripts/report.js` — generates a report of database coverage
- `scripts/shows-to-fetch.txt` — list of 1000 show titles (numbered, one per line)
- `scripts/match-log.txt` — log of TMDB title matches from last fetch run

### Running the Main Script
```bash
export TMDB_API_KEY=your_key
caffeinate -i node scripts/build-show-database.js --all 2>&1 | tee scripts/run-log.txt
```
Use `caffeinate` to prevent Mac sleep. `tee` saves log to file.

## Fandom Wiki Discovery — How It Works
The `build-show-database.js` script finds the best Fandom wiki for each show by:
1. Generating candidate wiki slugs (e.g. `frozen`, `disney`, `pixar`) and page title variations (e.g. `Frozen`, `Frozen_(film)`)
2. Trying each combination, counting cast section links
3. Picking the wiki with the most cast links
4. Saving the winner as `fandom_wiki` in the database — so future runs skip discovery for that show

### Wikitext Parsing — Supported Formats
The parser handles multiple cast section formats:
- **Bullet + "as":** `* '''[[Actor]]''' as [[Character]]` (Shrek style)
- **Bullet + "voiced by":** `* '''[[Character]]''' (voiced by [[Actor]])` (Rick and Morty style)
- **Wikitable rows:** `| [[Actor]] | [[Character]]` (Frozen/Disney style)

## Planned But Not Done — Iteration 2

### Category-Based Character Scraping
Many wikis don't have a cast section on the main show page. Instead they have a `Category:Characters` page listing all character pages individually. Examples:
- `castlevania.fandom.com/wiki/Category:Castlevania_(Animated_Series)_Characters`
- `rickandmorty.fandom.com/wiki/Category:Characters`
- `avatar.fandom.com/wiki/Category:Characters`
- `arcane.fandom.com/wiki/Category:Characters`

For these shows, the approach is:
1. Fetch all pages in `Category:Characters` (paginated — use `cmcontinue` for pagination)
2. For each character page, extract voice actor from infobox using flexible voice field regex
3. Voice field names vary: `|voice actor =`, `|english_voice =`, `| voice =`, `| Voice actor =`
4. Cross-reference actor name with TMDB photo map
5. Download character image from the page
6. Only keep characters that match a known voice actor (to filter out minor/background characters)

This script should be built as `scripts/build-show-database-v2.js` and run AFTER the current script, only for shows where `fandom_wiki` is set but character images are still missing or sparse.

### Shows That Need Category Approach
Based on testing:
- Rick and Morty (rickandmorty.fandom.com) — 1052 character pages in category
- Avatar The Last Airbender (avatar.fandom.com)
- Attack on Titan (attackontitan.fandom.com)
- Arcane (arcane.fandom.com)
- Castlevania (castlevania.fandom.com)
- Bob's Burgers (bobs-burgers.fandom.com)
- Naruto — special case, no voice field in infobox, needs different approach
- My Hero Academia — same issue as Naruto

### Report Script
`scripts/report.js` already exists and shows:
- Shows with no character images
- Shows with no fandom wiki found
- Coverage percentages

Run after each iteration to see what still needs work:
```bash
node scripts/report.js
```

## What's Working Well
- Extension correctly detects animated cast searches on Google
- Extension replaces Google's native cast panel with VoiceCast panel
- Actor photos from TMDB showing correctly for ~36,000 characters
- Character images showing for ~93 shows including Shrek, Frozen, Rick and Morty main cast
- Self-growing database — GitHub issues being created automatically for missing shows
- VoiceCast badge shows in panel
- Works on desktop Chrome

## Known Issues & TODO

### UX/UI
- Too many minor characters showing (e.g. "Additional Voices", "Ogre Hunter") — need better filtering
- Character cards show silhouette placeholder when image missing — acceptable for now
- TMDB attribution logo needs to be added to the panel (required by TMDB terms)
- Panel shows too many characters for shows with huge casts (Simpsons has hundreds)
- Consider showing only top N characters by prominence

### Data Quality
- Some false positives in parsing (e.g. "squanching" parsed as character name from Rick and Morty)
- Duplicate character entries possible when actor voices multiple characters
- Some shows matched to wrong TMDB entry — need to review match-log.txt
- Layer 1 (extension/data/shows.json) not yet synced with latest database improvements

### Security
- TMDB attribution not yet shown in UI (required by their terms)
- Content Security Policy should be reviewed
- Extension permissions should be audited

### Performance
- Wiki discovery takes ~3 minutes per show — too slow for full 942 show run
- Solution: `fandom_wiki` field is saved per show, so second run skips discovery
- Current run has processed ~133/942 shows after 7 hours

### Testing
- 78 Jest tests exist but may be failing due to schema changes
- Run `npm test` to check

## Next Steps After Database Is Solid
1. Build Iteration 2 category-based scraper
2. Run report to identify gaps
3. UX/UI polish (card design, filtering, TMDB attribution)
4. Security audit
5. Submit to Chrome Web Store

## Chrome Web Store Submission (Future)
- Need 128x128, 48x48, 16x16 icons (already exist in extension/assets/icons/)
- Need screenshots of extension in action
- Need privacy policy (no user data collected, only anonymous show titles reported)
- TMDB attribution required in UI before submission
- Review TMDB terms re: publishing as free extension

## Git Workflow
- All work on `dev` branch
- Merge to `main` via PR (protection rules relaxed — owner can merge directly now)
- Push images and database after each script run:
```bash
git add data/
git commit -m "Update database and images"
git push origin dev
# Then merge dev to main via GitHub PR
```

## Loading Extension in Chrome
1. Go to `chrome://extensions`
2. Enable Developer mode
3. Click Load unpacked
4. Select `/Users/matanrotman/Desktop/VoiceCast/extension` folder
5. After code changes: click reload icon on extension card + Cmd+Shift+R on Google tab

## Clearing Extension Cache
1. Go to `chrome://extensions`
2. Click "Service Worker" link on VoiceCast card
3. In console: `chrome.storage.local.clear(() => console.log('Cache cleared'))`
4. Hard refresh Google tab