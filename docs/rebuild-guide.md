# VoiceCast Database Rebuild Guide

Step-by-step guide to rebuild the character image database from scratch. You can paste this into Claude Chat for guided execution.

---

## Prerequisites

```bash
cd /Users/matanrotman/Desktop/VoiceCast
export TMDB_API_KEY=your_key_here    # must be set
node -v                               # should be v25+
npm install                            # ensure sharp is installed
```

---

## Step 0: Validate TMDB Entries (optional but recommended)

Some shows in `data/database.json` are matched to the wrong TMDB record. The image pipeline can't recover from a bad `tmdb_id`, so audit first. This is a two-phase process: **scan → review → apply**.

### Step 0a: Scan

```bash
node scripts/pipeline/validate-tmdb.js
```

**What it does:**
- Scans all 942 shows with four heuristics:
  - `self_chars` — characters like "Self" / "Self - Host" (~30 shows, usually talk/panel mismatches)
  - `non_english` — non-Latin script in names OR majority of names use Spanish/Portuguese diacritics (~7 shows)
  - `low_char_count` — shows with 1–3 characters (~48 shows, often obscure or wrong match)
  - `genre_mismatch` — TMDB record not tagged as Animation (requires `TMDB_API_KEY`)
- For each flagged show, searches TMDB for up to 3 animated replacement candidates with scoring.
- Writes `data/tmdb-fix-report.json`.

**Expected runtime:** ~10 minutes for a full scan with TMDB enabled, ~30 seconds with `--no-tmdb-refetch`.

**Useful flags:**
```bash
node scripts/pipeline/validate-tmdb.js --show "Dungeons"            # single-show diagnostic
node scripts/pipeline/validate-tmdb.js --no-tmdb-refetch            # offline (skip genre heuristic)
node scripts/pipeline/validate-tmdb.js --heuristics self,low_chars  # only these two heuristics
node scripts/pipeline/validate-tmdb.js --offset 200 --limit 200     # partial range
```

### Step 0b: Review the report

Open `data/tmdb-fix-report.json`. Each flagged entry looks like:

```json
{
  "title": "Dungeons and Dragons",
  "current_tmdb_id": 2326,
  "current_tmdb_type": "tv",
  "current_character_count": 1,
  "reasons": ["self_chars", "low_char_count"],
  "sample_characters": ["Self - Host"],
  "candidates": [
    { "tmdb_id": 2847, "tmdb_type": "tv", "name": "Dungeons & Dragons", "score": 12, "recommended": true },
    ...
  ]
}
```

For each flagged show, **add a `decision` field**. Three valid actions:

```json
// Case 1: The current entry is wrong, and we've found a better one
"decision": { "action": "replace", "tmdb_id": 2847, "tmdb_type": "tv" }

// Case 2: False positive — the entry is actually fine, skip it on future scans
"decision": { "action": "keep" }

// Case 3: No good candidate and we don't want this show
"decision": { "action": "remove" }
```

**Common patterns for deciding:**
- Show only has `"Self"` characters → usually `replace` (pick the animated candidate with the matching year)
- Spanish/Portuguese names for an American cartoon → `replace` (find the English candidate)
- Low character count on a legitimate short film → `keep`
- Low character count on an obscure anime that's not actually animated → check; if wrong, `replace`; if the TMDB record simply has minimal credits, `keep`

**Tip:** If you're unsure, paste the flagged entry (with its candidates) into Claude Chat and ask which to pick. The `score`, `original_language`, `release_date`, and `overview` fields are there to help decide.

### Step 0c: Apply the decisions

```bash
# Preview first
node scripts/pipeline/validate-tmdb.js --apply --dry-run

# Then apply for real
node scripts/pipeline/validate-tmdb.js --apply
```

**What it does:**
- Backs up `data/database.json` to `data/backups/database-pre-tmdb-fix-{timestamp}.json`
- For each `replace` decision: swaps `tmdb_id`/`tmdb_type`, refetches cast from TMDB, caps at 50, filters junk characters, clears stale `fandom_wiki` slug
- For each `keep` decision: adds the `tmdb_id` to `data/tmdb-validator-allowlist.json` so future scans skip it
- For each `remove` decision: removes the show from the DB
- Clears the `decision` marker from applied entries (re-running `--apply` is a no-op)

**Idempotent:** Safe to run multiple times. If you add more decisions later, re-run `--apply` and only the new ones get applied.

---

## Step 1: Clean the Database

This backs up the current database, removes junk characters, caps at 50 per show, and resets all image fields.

```bash
node scripts/pipeline/cleanup-database.js
```

**What to expect:**
- Backup saved to `data/backups/database-pre-rebuild-{timestamp}.json`
- ~44K characters reduced to ~19K after filtering
- All image folders and checkpoint DB deleted
- A list of "flagged" shows with >100 characters (these are likely correct — anime/long-running series have large casts, capped at 50)

**Verify:** Run `node -e "const d=require('./data/database.json'); const c=d.shows.flatMap(s=>s.characters||[]); console.log('Shows:', d.shows.length, 'Chars:', c.length, 'With images:', c.filter(x=>x.character_image&&x.character_image!=='').length)"` — should show 942 shows, ~19K chars, 0 with images.

---

## Step 2: Discover Wikis

Find the correct Fandom wiki for each show. Run in batches of ~200:

```bash
# Batch 1: shows 1-200
node scripts/pipeline/discover-wikis.js --limit 200

# Batch 2: shows 201-400
node scripts/pipeline/discover-wikis.js --offset 200 --limit 200

# Batch 3: shows 401-600
node scripts/pipeline/discover-wikis.js --offset 400 --limit 200

# Batch 4: shows 601-800
node scripts/pipeline/discover-wikis.js --offset 600 --limit 200

# Batch 5: shows 801-942
node scripts/pipeline/discover-wikis.js --offset 800
```

**What to expect:**
- Each run takes 15-30 minutes (depending on how many shows need web search fallback)
- Output: `data/wiki-mappings.json` with discovered wiki slugs
- ~60-70% of shows should get a wiki via slug guessing
- Additional 10-20% found via DuckDuckGo search
- Remaining shows are flagged as "not found"

**Estimated total time:** 2-3 hours for all 942 shows.

**Tip:** If DuckDuckGo starts blocking requests, run with `--no-search` to skip web search and only use slug guessing. You can retry failed shows later with `--recheck-failed`.

### Reviewing wiki-mappings.json

After discovery, open `data/wiki-mappings.json` and check:

1. **High confidence entries** (confidence: "high") — these have 5+ characters in `Category:Characters`. Usually correct.
2. **Medium confidence** — wiki exists but fewer characters. May be a wrong wiki or a small wiki.
3. **Low confidence** — wiki exists but no character category found. Likely wrong.
4. **Failed** — no wiki found. You can manually add the wiki slug if you know it.

To manually fix an entry, edit the JSON:
```json
{
  "title": "Some Show",
  "wiki_slug": "correct-wiki-slug",   // <-- change this
  "confidence": "high",
  "verified": true                      // <-- set to true
}
```

### Retry failed shows

After manual fixes, retry only failed shows:
```bash
node scripts/pipeline/discover-wikis.js --recheck-failed
```

Or test a single show:
```bash
node scripts/pipeline/discover-wikis.js --show "Frozen"
```

---

## Step 3: Fetch Character Images (in batches)

Process 100 shows at a time, verify between batches.

```bash
# Batch 1 (shows 1-100)
node scripts/pipeline/fetch-images.js --batch 1

# Check results before continuing
node scripts/pipeline/serve-verify.js
# Open http://localhost:3456 in browser, review batch 1
# Press Ctrl+C to stop server

# Batch 2 (shows 101-200)
node scripts/pipeline/fetch-images.js --batch 2

# Continue for batches 3-10...
```

**What to expect per batch:**
- 5-10 minutes per batch of 100 shows
- For each show: finds cast section on wiki, parses wikitext, downloads character images
- Images resized to 200px width and saved as PNG
- Database updated with relative paths like `data/images/shrek/shrek.png`
- Progress saved after each show — safe to Ctrl+C and resume

**Resume after interruption:**
```bash
node scripts/pipeline/fetch-images.js --batch 3 --resume
```

**Reprocess a single show:**
```bash
node scripts/pipeline/fetch-images.js --show "Frozen"
```

**Dry run (no downloads):**
```bash
node scripts/pipeline/fetch-images.js --batch 1 --dry-run
```

**Estimated total time:** ~60-90 minutes for all 10 batches.

---

## Step 4: Verify Results

Start the verification server:

```bash
node scripts/pipeline/serve-verify.js
```

Open `http://localhost:3456` in your browser. The page shows:

- **Summary bar** at top: total shows, coverage percentage
- **Filters**: by batch, by status (green/yellow/red), text search
- **Show cards**: click to expand and see character thumbnails
- **Actions**: "Copy re-fetch cmd" button, "Open wiki" link

### What to look for:
- **Green cards** (80%+ coverage) — these are good
- **Yellow cards** (partial) — check if the images match the correct characters
- **Red cards** (no images) — check if wiki mapping is correct
- **Gray cards** (no wiki) — these shows don't have a Fandom wiki

### Fixing problems:
1. Wrong wiki → edit `data/wiki-mappings.json`, change `wiki_slug`, re-run `--show "Title"`
2. Missing images → click "Copy re-fetch cmd" and run in terminal
3. Wrong character images → delete the image file in `data/images/{show-slug}/` and re-run

---

## Step 5: Final Checks

Run a quick audit:

```bash
node -e "
const d = require('./data/database.json');
const s = d.shows;
const chars = s.flatMap(x => x.characters || []);
const withImg = chars.filter(c => c.character_image && c.character_image !== '' && !c.character_image_placeholder);
const withWiki = s.filter(x => x.characters?.some(c => c.character_image && c.character_image !== ''));
console.log('Total shows:', s.length);
console.log('Shows with images:', withWiki.length);
console.log('Total characters:', chars.length);
console.log('Characters with images:', withImg.length);
console.log('Coverage:', Math.round(withImg.length / chars.length * 100) + '%');
// Check all paths are relative
const fullUrls = withImg.filter(c => c.character_image.startsWith('http'));
console.log('Full URL errors:', fullUrls.length, fullUrls.length > 0 ? '(NEEDS FIX)' : '(ok)');
"
```

---

## Troubleshooting

### "tmdb-fix-report.json not found" when running `--apply`
Run the scan phase first: `node scripts/pipeline/validate-tmdb.js`.

### `--apply` says "No decision blocks found"
Open `data/tmdb-fix-report.json` and add a `"decision": { "action": "..." }` field to each flagged show you want to fix. Entries without a decision are ignored.

### A flagged show really is fine
Add `"decision": { "action": "keep" }` and run `--apply`. The show's `tmdb_id` goes into `data/tmdb-validator-allowlist.json` and future scans skip it. To un-allowlist, remove the id from that file.

### "wiki-mappings.json not found"
Run `discover-wikis.js` first (Step 2).

### DuckDuckGo blocks requests
Use `--no-search` flag and rely on slug guessing. Retry with search later after a cooldown.

### "sharp" not found
Run `npm install` in the project root.

### Image download fails repeatedly
The Fandom wiki might be rate-limiting. Wait 5 minutes and retry with `--show "Title"`.

### Show has wrong characters
The TMDB match might be wrong (e.g., animated "Frozen" matched to the thriller "Frozen"). Check the `tmdb_id` and `tmdb_type` in `database.json`.

---

## File Reference

| File | Purpose |
|------|---------|
| `scripts/pipeline/validate-tmdb.js` | Step 0: Audit TMDB entries, apply fixes |
| `scripts/pipeline/cleanup-database.js` | Step 1: Reset database |
| `scripts/pipeline/discover-wikis.js` | Step 2: Find Fandom wikis |
| `scripts/pipeline/fetch-images.js` | Step 3: Download character images |
| `scripts/pipeline/serve-verify.js` | Step 4: Verification server |
| `tools/verify.html` | Step 4: Verification page |
| `data/database.json` | The database (modified by scripts) |
| `data/tmdb-fix-report.json` | Step 0: flagged shows + user decisions |
| `data/tmdb-validator-allowlist.json` | Step 0: shows marked as `keep` (skipped on rescan) |
| `data/wiki-mappings.json` | Wiki discovery results |
| `data/batch-progress.json` | Batch processing state |
| `data/backups/` | Automatic backups |
| `data/images/{show-slug}/` | Downloaded character images |
