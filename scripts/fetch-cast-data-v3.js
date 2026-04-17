/**
 * fetch-cast-data-v2.js
 *
 * Fetches cast data from TMDB for a list of animated shows and movies.
 * Accepts titles only — auto-resolves TMDB IDs via search.
 * Logs every match so you can verify correctness before trusting the data.
 *
 * Usage:
 *   export TMDB_API_KEY=your_key_here
 *   node scripts/fetch-cast-data-v2.js
 *
 * Input:  scripts/shows-to-fetch.txt (one title per line)
 * Output: data/database.json (appended, never overwritten from scratch)
 *         scripts/match-log.txt (every title → TMDB match, for your review)
 *
 * Safe to re-run — already-processed titles are skipped automatically.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Configuration ────────────────────────────────────────────────────────────

const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w185';
const DB_PATH = path.resolve(__dirname, '../data/database.json');
const SHOWS_PATH = path.resolve(__dirname, 'shows-to-fetch.txt');
const LOG_PATH = path.resolve(__dirname, 'match-log.txt');
const DELAY_MS = 1000;
const RATE_LIMIT_WAIT_MS = 30000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 3000;
const ANIMATION_GENRE_ID = 16;

// ─── API key validation ───────────────────────────────────────────────────────

const API_KEY = process.env.TMDB_API_KEY;

if (!API_KEY) {
  console.error('\n❌ ERROR: TMDB_API_KEY environment variable is not set.');
  console.error('   Run: export TMDB_API_KEY=your_key_here\n');
  process.exit(1);
}

if (!/^[a-f0-9]{32}$/i.test(API_KEY)) {
  console.error('\n❌ ERROR: TMDB_API_KEY does not look like a valid TMDB API key.\n');
  process.exit(1);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function loadDatabase() {
  if (fs.existsSync(DB_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    } catch {
      console.error('\n❌ ERROR: data/database.json could not be parsed.\n');
      process.exit(1);
    }
  }
  return { shows: [] };
}

function saveDatabase(db) {
  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DB_PATH);
}

async function fetchWithRetry(url) {
  const fullUrl = `${url}&api_key=${API_KEY}`;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(fullUrl);
      if (res.status === 429 || res.status === 503) {
        process.stdout.write('\n  ⏳ Rate limited — waiting 30s...');
        await sleep(RATE_LIMIT_WAIT_MS);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.json();
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err;
      await sleep(RETRY_DELAY_MS);
    }
  }
}

/**
 * Search TMDB for a title.
 * Tries movies first, then TV shows.
 * Prefers results that have animation genre (id 16).
 * Returns { tmdb_id, tmdb_type, matched_title, matched_year } or null.
 */
async function searchTitle(title) {
  for (const type of ['movie', 'tv']) {
    const endpoint = `${TMDB_BASE_URL}/search/${type}?query=${encodeURIComponent(title)}&language=en-US&page=1`;
    const data = await fetchWithRetry(endpoint);
    const results = data.results || [];
    if (results.length === 0) continue;

    // Prefer animation genre match
    const animated = results.find(r => (r.genre_ids || []).includes(ANIMATION_GENRE_ID));
    const best = animated || results[0];

    return {
      tmdb_id: best.id,
      tmdb_type: type,
      matched_title: best.title || best.name || 'Unknown',
      matched_year: (best.release_date || best.first_air_date || '').substring(0, 4)
    };
  }
  return null;
}

async function fetchCast(tmdbId, type) {
  const endpoint = type === 'tv'
    ? `${TMDB_BASE_URL}/tv/${tmdbId}/aggregate_credits?language=en-US`
    : `${TMDB_BASE_URL}/movie/${tmdbId}/credits?language=en-US`;

  const data = await fetchWithRetry(endpoint);
  const rawCast = data.cast || [];

  return rawCast
    .map(member => ({
      character_name: (
        member.roles?.[0]?.character ||
        member.character ||
        ''
      ).replace(/\s*\(voice\)/gi, '').trim(),
      voice_actor: (member.name || '').trim(),
      voice_actor_tmdb_id: member.id,
      voice_actor_photo: member.profile_path
        ? `${TMDB_IMAGE_BASE}${member.profile_path}`
        : null,
      character_image: null,
      character_image_placeholder: true
    }))
    .filter(m => m.character_name && m.voice_actor);
}

function printProgress(current, total, label) {
  const pct = total === 0 ? 100 : Math.round((current / total) * 100);
  const filled = Math.floor(pct / 2);
  const bar = '█'.repeat(filled) + '░'.repeat(50 - filled);
  const safeLabel = label.substring(0, 28).padEnd(28);
  process.stdout.write(`\r[${bar}] ${String(pct).padStart(3)}% (${current}/${total}) ${safeLabel}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(SHOWS_PATH)) {
    console.error(`\n❌ ERROR: ${SHOWS_PATH} not found.\n`);
    process.exit(1);
  }

  const titles = fs.readFileSync(SHOWS_PATH, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .map(l => l.replace(/^\d+\.\s*/, '').trim())
    .filter(l => l);

  console.log(`\n📋 Found ${titles.length} title(s) to process.\n`);

  const db = loadDatabase();
  const existingTitles = new Set(db.shows.map(s => s.title.toLowerCase()));

  const toFetch = titles.filter(t => !existingTitles.has(t.toLowerCase()));
  const skipped = titles.length - toFetch.length;

  console.log(`✅ Already in database: ${skipped}`);
  console.log(`🔄 To fetch: ${toFetch.length}\n`);

  const matchLog = [];
  const fetchErrors = [];
  const noMatchErrors = [];
  let done = 0;

  for (let i = 0; i < titles.length; i++) {
    const title = titles[i];
    printProgress(i, titles.length, title);

    if (existingTitles.has(title.toLowerCase())) continue;

    try {
      // Step 1: Search for the title
      const match = await searchTitle(title);
      await sleep(DELAY_MS);

      if (!match) {
        noMatchErrors.push({ index: i + 1, title });
        matchLog.push(`${i + 1}. "${title}" = NO MATCH FOUND`);
        continue;
      }

      // Log the match for user review
      matchLog.push(
        `${i + 1}. "${title}" = "${match.matched_title}" (${match.matched_year}, ${match.tmdb_type}, id=${match.tmdb_id})`
      );

      // Step 2: Fetch cast
      const cast = await fetchCast(match.tmdb_id, match.tmdb_type);
      await sleep(DELAY_MS);

      db.shows.push({
        title,
        matched_title: match.matched_title,
        tmdb_id: match.tmdb_id,
        tmdb_type: match.tmdb_type,
        characters: cast
      });

      existingTitles.add(title.toLowerCase());
      saveDatabase(db);
      done++;

    } catch (err) {
      const safeError = API_KEY ? err.message.replace(API_KEY, '[REDACTED]') : err.message;
      fetchErrors.push({ index: i + 1, title, error: safeError });
      matchLog.push(`${i + 1}. "${title}" = ERROR: ${safeError}`);
    }
  }

  // Write match log to file
fs.writeFileSync(LOG_PATH, matchLog.join('\n') + '\n', 'utf8');


  printProgress(titles.length, titles.length, 'Complete');
  console.log('\n');
  console.log('─'.repeat(60));
  console.log('📊 Summary');
  console.log('─'.repeat(60));
  console.log(`  Total in file:       ${titles.length}`);
  console.log(`  Already in database: ${skipped}`);
  console.log(`  Newly added:         ${done}`);
  console.log(`  No match found:      ${noMatchErrors.length}`);
  console.log(`  Errors:              ${fetchErrors.length}`);
  console.log('─'.repeat(60));
  console.log(`\n📄 Full match log saved to: scripts/match-log.txt`);
  console.log('   Review it to verify TMDB matched the right shows.\n');

  if (noMatchErrors.length > 0) {
    console.log('⚠️  No TMDB match found for:');
    noMatchErrors.forEach(e => console.log(`  ${e.index}. ${e.title}`));
    console.log();
  }

  if (fetchErrors.length > 0) {
    console.log('⚠️  Fetch errors:');
    fetchErrors.forEach(e => console.log(`  ${e.index}. ${e.title}: ${e.error}`));
    console.log();
  }

  if (fetchErrors.length === 0 && noMatchErrors.length === 0) {
    console.log('✅ All shows processed successfully.\n');
  }
}

main().catch(err => {
  const safeMessage = API_KEY ? err.message.replace(API_KEY, '[REDACTED]') : err.message;
  console.error(`\n❌ Fatal error: ${safeMessage}\n`);
  process.exit(1);
});