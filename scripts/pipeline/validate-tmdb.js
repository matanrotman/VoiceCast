#!/usr/bin/env node
'use strict';

/**
 * validate-tmdb.js
 *
 * Two-phase TMDB entry validator + fixer for data/database.json.
 *
 * Phase 1 (default, no flag):
 *   Scans every show, flags suspicious ones using four heuristics:
 *     - self_chars       — character names like "Self" / "Self - Host"
 *     - non_english      — non-Latin script in char names OR non-en original_language
 *     - low_char_count   — show has 1-3 characters total
 *     - genre_mismatch   — TMDB record isn't tagged as Animation (genre 16)
 *   For each flagged show, searches TMDB for animated alternatives and writes
 *   the top 3 candidates to data/tmdb-fix-report.json for user review.
 *
 * Phase 2 (--apply):
 *   Reads data/tmdb-fix-report.json and applies any "decision" blocks the user added:
 *     - replace — swap tmdb_id/tmdb_type, re-fetch cast, clear stale fandom_wiki
 *     - keep    — record in allowlist so future scans skip this show
 *     - remove  — drop the show from the DB
 *   Always backs up data/database.json before writing.
 *
 * Usage:
 *   export TMDB_API_KEY=your_key_here
 *   node scripts/pipeline/validate-tmdb.js                           # scan
 *   node scripts/pipeline/validate-tmdb.js --show "Dungeons and Dragons"
 *   node scripts/pipeline/validate-tmdb.js --apply --dry-run         # preview fixes
 *   node scripts/pipeline/validate-tmdb.js --apply                   # write fixes
 */

const fs = require('fs');
const path = require('path');

// ─── Paths ────────────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '../..');
const DB_PATH = path.join(ROOT, 'data/database.json');
const REPORT_PATH = path.join(ROOT, 'data/tmdb-fix-report.json');
const ALLOWLIST_PATH = path.join(ROOT, 'data/tmdb-validator-allowlist.json');
const BACKUPS_DIR = path.join(ROOT, 'data/backups');

// ─── Config ───────────────────────────────────────────────────────────────────

const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w185';
const ANIMATION_GENRE_ID = 16;
const MAX_CHARACTERS = 50;
const DELAY_MS = 250;
const RATE_LIMIT_WAIT_MS = 30000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 3000;

// Junk character names (mirrors cleanup-database.js)
const SKIP_PATTERNS = [
  /^self$/i,
  /^self\s*[-–—]/i,
  /\(uncredited\)/i,
  /^additional voices?$/i,
  /^various$/i,
  /^uncredited$/i,
  /^voice$/i,
  /^misc\.?\s*voices?$/i,
  /^background voices?$/i,
  /^ensemble$/i,
  /^and more$/i,
  /^others?$/i,
  /^narrator$/i,
];

// Regex for "Self" / "Self - Host" heuristic
const SELF_RE = /^self(\s*[-–—(].+)?$/i;

// Non-Latin scripts that almost always mean wrong-language TMDB record:
// Cyrillic, CJK, Hangul, Hiragana, Katakana, Arabic, Thai, Hebrew, Devanagari
const NON_LATIN_RE = /[\u0400-\u04FF\u0600-\u06FF\u0590-\u05FF\u0900-\u097F\u0E00-\u0E7F\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF\u3400-\u4DBF]/;

// Diacritics / extended Latin common in Spanish/Portuguese/French.
// We only flag on these when >50% of chars use them (heuristic for non-en cast).
const EXT_LATIN_RE = /[À-ÿĀ-žȀ-ɏ]/;

// ─── CLI ──────────────────────────────────────────────────────────────────────

const ARGS = process.argv.slice(2);

function argVal(flag) {
  const i = ARGS.indexOf(flag);
  return i >= 0 ? ARGS[i + 1] : null;
}
function argHas(flag) {
  return ARGS.includes(flag);
}

const FLAG_APPLY = argHas('--apply');
const FLAG_DRY = argHas('--dry-run');
const FLAG_NO_REFETCH = argHas('--no-tmdb-refetch');
const FLAG_SHOW = argVal('--show');
const FLAG_OFFSET = parseInt(argVal('--offset') || '0', 10);
const FLAG_LIMIT = parseInt(argVal('--limit') || '0', 10);
const FLAG_HEURISTICS = (argVal('--heuristics') || 'self,non_english,low_chars,genre')
  .split(',').map(s => s.trim()).filter(Boolean);

// ─── API key ──────────────────────────────────────────────────────────────────

const API_KEY = process.env.TMDB_API_KEY;
if (API_KEY && !/^[a-f0-9]{32}$/i.test(API_KEY)) {
  console.error('\n  ERROR: TMDB_API_KEY does not look valid.\n');
  process.exit(1);
}

function requireApiKey(reason) {
  if (!API_KEY) {
    console.error(`\n  ERROR: TMDB_API_KEY is not set (${reason}).`);
    console.error('  Run: export TMDB_API_KEY=your_key_here');
    console.error('  Or run with --no-tmdb-refetch to skip TMDB calls.\n');
    process.exit(1);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadJSON(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJSON(p, data) {
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

function shouldSkipChar(name) {
  const trimmed = (name || '').trim();
  return !trimmed || SKIP_PATTERNS.some(pat => pat.test(trimmed));
}

async function fetchWithRetry(url) {
  const fullUrl = `${url}${url.includes('?') ? '&' : '?'}api_key=${API_KEY}`;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(fullUrl);
      if (res.status === 429 || res.status === 503) {
        process.stdout.write('  [rate limited — waiting 30s]\n');
        await sleep(RATE_LIMIT_WAIT_MS);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err;
      await sleep(RETRY_DELAY_MS);
    }
  }
}

// ─── Heuristics ───────────────────────────────────────────────────────────────

function detectSelfChars(show) {
  const chars = show.characters || [];
  return chars.some(c => SELF_RE.test((c.character_name || '').trim()));
}

function detectNonEnglish(show, tmdbDetail) {
  const chars = show.characters || [];
  if (chars.length === 0) return false;

  // Strong signal: non-Latin script anywhere
  if (chars.some(c => NON_LATIN_RE.test(c.character_name || ''))) return true;

  // Moderate signal: majority of chars have extended-Latin diacritics.
  // This catches Spanish/Portuguese-language records without flagging single
  // accented names like "Héctor" in an English cast.
  const withDiacritics = chars.filter(c => EXT_LATIN_RE.test(c.character_name || '')).length;
  if (withDiacritics / chars.length > 0.5) return true;

  // TMDB detail signal: original_language is not English.
  if (tmdbDetail && tmdbDetail.original_language && tmdbDetail.original_language !== 'en') {
    return true;
  }

  return false;
}

function detectLowCharCount(show) {
  const n = (show.characters || []).length;
  return n >= 1 && n <= 3;
}

function detectGenreMismatch(tmdbDetail) {
  if (!tmdbDetail) return false;
  const genres = tmdbDetail.genres || [];
  return !genres.some(g => g.id === ANIMATION_GENRE_ID);
}

// ─── TMDB calls ───────────────────────────────────────────────────────────────

async function fetchShowDetail(tmdbId, tmdbType) {
  try {
    const url = `${TMDB_BASE_URL}/${tmdbType}/${tmdbId}?language=en-US`;
    return await fetchWithRetry(url);
  } catch (err) {
    return null;
  }
}

async function searchCandidates(title) {
  const candidates = [];
  for (const type of ['tv', 'movie']) {
    try {
      const url = `${TMDB_BASE_URL}/search/${type}?query=${encodeURIComponent(title)}&language=en-US&page=1`;
      const data = await fetchWithRetry(url);
      const results = (data.results || []).slice(0, 10);
      for (const r of results) {
        candidates.push({
          tmdb_id: r.id,
          tmdb_type: type,
          name: r.title || r.name || '',
          original_language: r.original_language || '',
          release_date: (r.release_date || r.first_air_date || '').slice(0, 4),
          genre_ids: r.genre_ids || [],
          popularity: r.popularity || 0,
          overview: r.overview || '',
        });
      }
      await sleep(DELAY_MS);
    } catch (err) {
      // ignore one type failure, try the other
    }
  }
  return candidates;
}

function scoreCandidate(candidate, currentTitle, currentYear) {
  let score = 0;
  const normA = (candidate.name || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  const normB = (currentTitle || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();

  if (normA === normB) score += 3;
  if ((candidate.genre_ids || []).includes(ANIMATION_GENRE_ID)) score += 2;
  if (candidate.original_language === 'en') score += 2;
  score += Math.min(Math.floor((candidate.popularity || 0) / 10), 5);
  if (currentYear && candidate.release_date) {
    const diff = Math.abs(parseInt(candidate.release_date, 10) - parseInt(currentYear, 10));
    if (!Number.isNaN(diff) && diff <= 1) score += 1;
  }
  if (!candidate.overview || candidate.overview.trim() === '') score -= 5;

  return score;
}

async function fetchCast(tmdbId, tmdbType) {
  const url = tmdbType === 'tv'
    ? `${TMDB_BASE_URL}/tv/${tmdbId}/aggregate_credits?language=en-US`
    : `${TMDB_BASE_URL}/movie/${tmdbId}/credits?language=en-US`;
  const data = await fetchWithRetry(url);
  const rawCast = data.cast || [];

  return rawCast
    .map(m => ({
      character_name: (m.roles?.[0]?.character || m.character || '').replace(/\s*\(voice\)/gi, '').trim(),
      character_image: '',
      character_image_placeholder: true,
      voice_actor: (m.name || '').trim(),
      voice_actor_tmdb_id: m.id,
      voice_actor_photo: m.profile_path ? `${TMDB_IMAGE_BASE}${m.profile_path}` : null,
    }))
    .filter(c => c.character_name && c.voice_actor && !shouldSkipChar(c.character_name))
    .slice(0, MAX_CHARACTERS);
}

// ─── Scan phase ───────────────────────────────────────────────────────────────

async function scan() {
  const db = loadJSON(DB_PATH, { shows: [] });
  const allowlist = loadJSON(ALLOWLIST_PATH, { tmdb_ids: [] });
  const allowSet = new Set(allowlist.tmdb_ids || []);
  const allShows = db.shows;

  let shows = allShows;
  if (FLAG_SHOW) {
    const needle = FLAG_SHOW.toLowerCase();
    shows = allShows.filter(s => (s.title || '').toLowerCase().includes(needle));
    if (shows.length === 0) {
      console.error(`  No show matches --show "${FLAG_SHOW}"`);
      process.exit(1);
    }
  } else {
    if (FLAG_OFFSET) shows = shows.slice(FLAG_OFFSET);
    if (FLAG_LIMIT) shows = shows.slice(0, FLAG_LIMIT);
  }

  // Check if TMDB is needed for any heuristic in this scan
  const needsTmdb = !FLAG_NO_REFETCH
    && (FLAG_HEURISTICS.includes('non_english') || FLAG_HEURISTICS.includes('genre'));
  if (needsTmdb) requireApiKey('scan with non_english/genre heuristics or candidate search');

  console.log(`\n  Scanning ${shows.length} show(s) (heuristics: ${FLAG_HEURISTICS.join(', ')})\n`);

  const byReason = { self_chars: 0, non_english: 0, low_char_count: 0, genre_mismatch: 0 };
  const flagged = [];
  const startTime = Date.now();

  for (let i = 0; i < shows.length; i++) {
    const show = shows[i];

    if (allowSet.has(show.tmdb_id)) {
      process.stdout.write(`\r  [${i + 1}/${shows.length}] ${truncate(show.title, 40)} (allowlisted)        `);
      continue;
    }

    const reasons = [];

    if (FLAG_HEURISTICS.includes('self') && detectSelfChars(show)) reasons.push('self_chars');
    if (FLAG_HEURISTICS.includes('low_chars') && detectLowCharCount(show)) reasons.push('low_char_count');

    // For non_english and genre: we may need TMDB detail
    let tmdbDetail = null;
    const wantsDetail =
      (FLAG_HEURISTICS.includes('non_english') || FLAG_HEURISTICS.includes('genre'))
      && !FLAG_NO_REFETCH
      && show.tmdb_id && show.tmdb_type;

    if (wantsDetail) {
      tmdbDetail = await fetchShowDetail(show.tmdb_id, show.tmdb_type);
      await sleep(DELAY_MS);
    }

    if (FLAG_HEURISTICS.includes('non_english') && detectNonEnglish(show, tmdbDetail)) reasons.push('non_english');
    if (FLAG_HEURISTICS.includes('genre') && detectGenreMismatch(tmdbDetail)) reasons.push('genre_mismatch');

    const elapsed = (Date.now() - startTime) / 1000;
    const rate = (i + 1) / elapsed;
    const etaSec = Math.max(0, Math.round((shows.length - (i + 1)) / rate));
    process.stdout.write(
      `\r  [${i + 1}/${shows.length}] ${truncate(show.title, 30).padEnd(30)} ` +
      `| flagged: ${flagged.length} | ETA: ${formatEta(etaSec)}      `
    );

    if (reasons.length === 0) continue;

    reasons.forEach(r => { byReason[r] = (byReason[r] || 0) + 1; });

    // Search for replacement candidates
    process.stdout.write(`\n    ${show.title} — flagged (${reasons.join(', ')})\n`);
    let candidates = [];
    if (!FLAG_NO_REFETCH) {
      const currentYear = tmdbDetail
        ? ((tmdbDetail.release_date || tmdbDetail.first_air_date || '').slice(0, 4) || null)
        : null;
      const raw = await searchCandidates(show.title);
      candidates = raw
        .map(c => ({ ...c, score: scoreCandidate(c, show.title, currentYear) }))
        .filter(c => c.tmdb_id !== show.tmdb_id || c.tmdb_type !== show.tmdb_type)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);
      if (candidates.length > 0) candidates[0].recommended = true;
      process.stdout.write(`    Top candidates: ${candidates.length}\n`);
    }

    flagged.push({
      title: show.title,
      current_tmdb_id: show.tmdb_id,
      current_tmdb_type: show.tmdb_type,
      current_original_language: tmdbDetail?.original_language || null,
      current_character_count: (show.characters || []).length,
      reasons,
      sample_characters: (show.characters || []).slice(0, 4).map(c => c.character_name),
      candidates,
    });
  }

  process.stdout.write('\n\n');

  const report = {
    generated_at: new Date().toISOString(),
    summary: {
      scanned: shows.length,
      flagged: flagged.length,
      by_reason: byReason,
    },
    flagged,
  };

  if (!FLAG_SHOW && !FLAG_DRY) {
    saveJSON(REPORT_PATH, report);
    console.log(`  Report saved: ${path.relative(ROOT, REPORT_PATH)}\n`);
  } else if (FLAG_SHOW) {
    console.log(JSON.stringify(report, null, 2));
  }

  console.log('  ┌──────────────────────────────────────┐');
  console.log('  │           Scan Summary               │');
  console.log('  ├──────────────────────────────────────┤');
  console.log(`  │  Scanned:        ${String(shows.length).padStart(18)} │`);
  console.log(`  │  Flagged:        ${String(flagged.length).padStart(18)} │`);
  console.log(`  │  self_chars:     ${String(byReason.self_chars || 0).padStart(18)} │`);
  console.log(`  │  non_english:    ${String(byReason.non_english || 0).padStart(18)} │`);
  console.log(`  │  low_char_count: ${String(byReason.low_char_count || 0).padStart(18)} │`);
  console.log(`  │  genre_mismatch: ${String(byReason.genre_mismatch || 0).padStart(18)} │`);
  console.log('  └──────────────────────────────────────┘');
  if (!FLAG_SHOW && !FLAG_DRY) {
    console.log(`\n  Next: open ${path.relative(ROOT, REPORT_PATH)}, add "decision" blocks,`);
    console.log('        then run: node scripts/pipeline/validate-tmdb.js --apply\n');
  }
}

// ─── Apply phase ──────────────────────────────────────────────────────────────

async function apply() {
  if (!fs.existsSync(REPORT_PATH)) {
    console.error(`\n  ERROR: ${REPORT_PATH} not found. Run the scan phase first.\n`);
    process.exit(1);
  }

  const report = loadJSON(REPORT_PATH, null);
  if (!report || !Array.isArray(report.flagged)) {
    console.error('\n  ERROR: Report file is malformed.\n');
    process.exit(1);
  }

  const withDecisions = report.flagged.filter(f => f.decision && f.decision.action);
  if (withDecisions.length === 0) {
    console.error('\n  No "decision" blocks found in the report.');
    console.error('  Add { "action": "replace|keep|remove", ... } to the shows you want to fix.\n');
    process.exit(1);
  }

  console.log(`\n  Found ${withDecisions.length} decision(s):`);
  const byAction = { replace: 0, keep: 0, remove: 0 };
  withDecisions.forEach(f => { byAction[f.decision.action] = (byAction[f.decision.action] || 0) + 1; });
  console.log(`    replace: ${byAction.replace}  keep: ${byAction.keep}  remove: ${byAction.remove}\n`);

  if (FLAG_DRY) console.log('  DRY RUN — no files will be written\n');

  const db = loadJSON(DB_PATH, { shows: [] });
  const allowlist = loadJSON(ALLOWLIST_PATH, { tmdb_ids: [] });
  const allowSet = new Set(allowlist.tmdb_ids || []);

  // Backup
  if (!FLAG_DRY) {
    if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(BACKUPS_DIR, `database-pre-tmdb-fix-${ts}.json`);
    fs.writeFileSync(backupPath, JSON.stringify(db, null, 2), 'utf8');
    console.log(`  Backup: ${path.relative(ROOT, backupPath)}\n`);
  }

  const stats = { replaced: 0, kept: 0, removed: 0, failed: 0 };

  // Build a map from current_tmdb_id to show index for quick lookup.
  const showIdx = new Map();
  db.shows.forEach((s, i) => showIdx.set(`${s.tmdb_type}:${s.tmdb_id}`, i));

  // Collect indices to remove at the end (in reverse order)
  const toRemove = [];
  // Decisions whose "decision" we should clear on success (so --apply is idempotent)
  const appliedIndices = [];

  for (let i = 0; i < withDecisions.length; i++) {
    const entry = withDecisions[i];
    const d = entry.decision;
    const key = `${entry.current_tmdb_type}:${entry.current_tmdb_id}`;
    const idx = showIdx.get(key);

    process.stdout.write(`  [${i + 1}/${withDecisions.length}] ${truncate(entry.title, 40).padEnd(40)} `);

    if (idx === undefined) {
      process.stdout.write(`  SKIP (not in DB)\n`);
      stats.failed++;
      continue;
    }

    try {
      if (d.action === 'keep') {
        if (!FLAG_DRY) allowSet.add(entry.current_tmdb_id);
        process.stdout.write(`  keep (allowlisted)\n`);
        stats.kept++;
        appliedIndices.push(report.flagged.indexOf(entry));
      }
      else if (d.action === 'remove') {
        if (!FLAG_DRY) toRemove.push(idx);
        process.stdout.write(`  remove\n`);
        stats.removed++;
        appliedIndices.push(report.flagged.indexOf(entry));
      }
      else if (d.action === 'replace') {
        if (!d.tmdb_id || !d.tmdb_type) {
          process.stdout.write(`  SKIP (replace requires tmdb_id + tmdb_type)\n`);
          stats.failed++;
          continue;
        }
        if (!FLAG_DRY) requireApiKey('replace action needs to re-fetch cast');
        process.stdout.write(`\n    Re-fetching ${d.tmdb_type}/${d.tmdb_id} cast...`);
        let newCast = [];
        let newDetail = null;
        if (!FLAG_DRY) {
          newDetail = await fetchShowDetail(d.tmdb_id, d.tmdb_type);
          await sleep(DELAY_MS);
          newCast = await fetchCast(d.tmdb_id, d.tmdb_type);
          await sleep(DELAY_MS);
        }
        process.stdout.write(` ${newCast.length} chars\n`);

        if (!FLAG_DRY) {
          const show = db.shows[idx];
          show.tmdb_id = d.tmdb_id;
          show.tmdb_type = d.tmdb_type;
          if (newDetail) {
            show.title = newDetail.title || newDetail.name || show.title;
          }
          show.characters = newCast;
          // Stale fandom slug — clear it so discover-wikis re-resolves.
          if (show.fandom_wiki) delete show.fandom_wiki;
          // Update key map in case the same replacement appears twice
          showIdx.delete(key);
          showIdx.set(`${d.tmdb_type}:${d.tmdb_id}`, idx);
        }
        stats.replaced++;
        appliedIndices.push(report.flagged.indexOf(entry));
      }
      else {
        process.stdout.write(`  SKIP (unknown action "${d.action}")\n`);
        stats.failed++;
      }
    } catch (err) {
      process.stdout.write(`  FAILED: ${err.message}\n`);
      stats.failed++;
    }
  }

  // Apply removals (reverse order to preserve indices)
  if (!FLAG_DRY && toRemove.length > 0) {
    toRemove.sort((a, b) => b - a);
    for (const idx of toRemove) db.shows.splice(idx, 1);
  }

  // Write DB + allowlist + updated report
  if (!FLAG_DRY) {
    db.updated_at = new Date().toISOString();
    saveJSON(DB_PATH, db);

    saveJSON(ALLOWLIST_PATH, { tmdb_ids: Array.from(allowSet).sort((a, b) => a - b) });

    // Clear applied decisions so re-runs are idempotent
    const appliedSet = new Set(appliedIndices);
    report.flagged = report.flagged.map((f, i) => {
      if (appliedSet.has(i)) {
        const { decision, ...rest } = f;
        return { ...rest, applied_at: new Date().toISOString() };
      }
      return f;
    });
    saveJSON(REPORT_PATH, report);
  }

  console.log('\n  ┌──────────────────────────────────────┐');
  console.log('  │           Apply Summary              │');
  console.log('  ├──────────────────────────────────────┤');
  console.log(`  │  Replaced: ${String(stats.replaced).padStart(24)} │`);
  console.log(`  │  Kept:     ${String(stats.kept).padStart(24)} │`);
  console.log(`  │  Removed:  ${String(stats.removed).padStart(24)} │`);
  console.log(`  │  Failed:   ${String(stats.failed).padStart(24)} │`);
  console.log('  └──────────────────────────────────────┘');
  if (FLAG_DRY) console.log('\n  DRY RUN — no files were written.\n');
  else console.log('\n  Done.\n');
}

// ─── Misc ─────────────────────────────────────────────────────────────────────

function truncate(s, n) {
  const str = String(s || '');
  return str.length <= n ? str : str.slice(0, n - 1) + '…';
}

function formatEta(sec) {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m${s}s`;
}

// ─── Entry point ──────────────────────────────────────────────────────────────

(async () => {
  try {
    if (FLAG_APPLY) await apply();
    else await scan();
  } catch (err) {
    console.error('\n  ERROR:', err.message);
    process.exit(1);
  }
})();
