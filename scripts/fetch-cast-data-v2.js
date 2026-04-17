/**
 * fetch-cast-data-v2.js
 *
 * Fetches cast data from the TMDB API for a list of animated shows and movies
 * and appends results to data/database.json.
 *
 * Usage:
 *   export TMDB_API_KEY=your_key_here
 *   node scripts/fetch-cast-data-v2.js
 *
 * Input:  scripts/shows-to-fetch.txt (title|tmdb_id|type, one per line)
 * Output: data/database.json (appended, never overwritten from scratch)
 *
 * Safe to re-run — already-processed shows are skipped automatically.
 * If interrupted, just run again and it picks up where it left off.
 *
 * Security notes:
 *   - API key is read from environment variable only, never from disk or args
 *   - API key is never logged, printed, or included in error messages
 *   - No data is sent anywhere except api.themoviedb.org
 *   - All file writes go only to data/database.json inside this repo
 *   - Input lines are validated before use
 *   - TMDB IDs are cast to integers to prevent injection
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Configuration ────────────────────────────────────────────────────────────

const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w185';
const DB_PATH = path.resolve(__dirname, '../data/database.json');
const SHOWS_PATH = path.resolve(__dirname, 'shows-to-fetch.txt');
const DELAY_BETWEEN_REQUESTS_MS = 1000;
const RATE_LIMIT_WAIT_MS = 30000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 3000;

// ─── API key validation ───────────────────────────────────────────────────────

const API_KEY = process.env.TMDB_API_KEY;

if (!API_KEY) {
  console.error('\n❌ ERROR: TMDB_API_KEY environment variable is not set.');
  console.error('   Run: export TMDB_API_KEY=your_key_here\n');
  process.exit(1);
}

// Basic sanity check — TMDB keys are 32-character hex strings
if (!/^[a-f0-9]{32}$/i.test(API_KEY)) {
  console.error('\n❌ ERROR: TMDB_API_KEY does not look like a valid TMDB API key.');
  console.error('   Expected a 32-character hex string.\n');
  process.exit(1);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Sleep for a given number of milliseconds.
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Render a progress bar to stdout without a newline (overwrites same line).
 */
function printProgress(current, total, label) {
  const pct = total === 0 ? 100 : Math.round((current / total) * 100);
  const filled = Math.floor(pct / 2);
  const bar = '█'.repeat(filled) + '░'.repeat(50 - filled);
  const safeLabel = label.substring(0, 28).padEnd(28);
  process.stdout.write(`\r[${bar}] ${String(pct).padStart(3)}% (${current}/${total}) ${safeLabel}`);
}

/**
 * Load the database from disk, or return an empty structure if it doesn't exist.
 */
function loadDatabase() {
  if (fs.existsSync(DB_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    } catch {
      console.error('\n❌ ERROR: data/database.json exists but could not be parsed.');
      console.error('   Fix or delete the file and try again.\n');
      process.exit(1);
    }
  }
  return { shows: [] };
}

/**
 * Save the database to disk atomically using a temp file + rename
 * to prevent data corruption if the process is interrupted mid-write.
 */
function saveDatabase(db) {
  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DB_PATH);
}

/**
 * Validate a single line from shows-to-fetch.txt.
 * Returns { title, tmdb_id, type } or null if invalid.
 */
function parseLine(line) {
  const parts = line.split('|');
  if (parts.length !== 3) return null;

  const title = parts[0].trim();
  const tmdb_id = parseInt(parts[1].trim(), 10);
  const type = parts[2].trim().toLowerCase();

  if (!title) return null;
  if (isNaN(tmdb_id) || tmdb_id <= 0) return null;
  if (type !== 'movie' && type !== 'tv') return null;

  return { title, tmdb_id, type };
}

/**
 * Fetch a URL with retry logic and rate limit handling.
 * The API key is appended here and never logged.
 */
async function fetchWithRetry(url, retries = MAX_RETRIES) {
  // Append API key — we build the URL here so it never appears in logs
  const fullUrl = `${url}&api_key=${API_KEY}`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(fullUrl);

      if (res.status === 429 || res.status === 503) {
        process.stdout.write('\n  ⏳ Rate limited — waiting 30s...');
        await sleep(RATE_LIMIT_WAIT_MS);
        continue;
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }

      return await res.json();

    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(RETRY_DELAY_MS);
    }
  }
}

/**
 * Fetch cast for a show from TMDB.
 * Returns an array of cast member objects.
 */
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
      actor_name: (member.name || '').trim(),
      actor_tmdb_id: member.id,
      actor_image: member.profile_path
        ? `${TMDB_IMAGE_BASE}${member.profile_path}`
        : null,
      character_image: null,
      character_image_placeholder: true
    }))
    .filter(m => m.character_name && m.actor_name);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Read and parse shows-to-fetch.txt
  if (!fs.existsSync(SHOWS_PATH)) {
    console.error(`\n❌ ERROR: ${SHOWS_PATH} not found.\n`);
    process.exit(1);
  }

  const rawLines = fs.readFileSync(SHOWS_PATH, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));

  const shows = [];
  const parseErrors = [];

  rawLines.forEach((line, i) => {
    const parsed = parseLine(line);
    if (parsed) {
      shows.push(parsed);
    } else {
      parseErrors.push(`  Line ${i + 1}: "${line}"`);
    }
  });

  if (parseErrors.length > 0) {
    console.warn(`\n⚠️  Skipped ${parseErrors.length} invalid line(s) in shows-to-fetch.txt:`);
    parseErrors.forEach(e => console.warn(e));
  }

  console.log(`\n📋 Found ${shows.length} valid show(s) to process.\n`);

  // Load existing database
  const db = loadDatabase();
  const existingIds = new Set(db.shows.map(s => String(s.tmdb_id)));

  const skipped = shows.filter(s => existingIds.has(String(s.tmdb_id))).length;
  const toFetch = shows.filter(s => !existingIds.has(String(s.tmdb_id)));

  console.log(`✅ Already in database: ${skipped}`);
  console.log(`🔄 To fetch: ${toFetch.length}\n`);

  const fetchErrors = [];
  let done = 0;

  for (let i = 0; i < shows.length; i++) {
    const { title, tmdb_id, type } = shows[i];
    printProgress(i, shows.length, title);

    // Skip if already processed
    if (existingIds.has(String(tmdb_id))) {
      continue;
    }

    try {
      const cast = await fetchCast(tmdb_id, type);
      db.shows.push({ title, tmdb_id, tmdb_type: type, cast });
      existingIds.add(String(tmdb_id));
      saveDatabase(db);
      done++;
    } catch (err) {
      // Never log the full URL as it contains the API key
      fetchErrors.push({ title, tmdb_id, error: err.message });
    }

    await sleep(DELAY_BETWEEN_REQUESTS_MS);
  }

  // Final progress bar at 100%
  printProgress(shows.length, shows.length, 'Complete');
  console.log('\n');

  // Summary
  console.log('─'.repeat(50));
  console.log(`📊 Summary`);
  console.log(`─'.repeat(50)`);
  console.log(`  Total in file:       ${shows.length}`);
  console.log(`  Already in database: ${skipped}`);
  console.log(`  Newly added:         ${done}`);
  console.log(`  Errors:              ${fetchErrors.length}`);
  console.log('─'.repeat(50));

  if (fetchErrors.length > 0) {
    console.log(`\n⚠️  The following shows failed and were skipped:`);
    fetchErrors.forEach(e => {
      console.log(`  - ${e.title} (TMDB ID: ${e.tmdb_id}): ${e.error}`);
    });
    console.log('\n  Re-run the script to retry failed shows.');
  } else {
    console.log('\n✅ All shows processed successfully.');
  }
}

main().catch(err => {
  // Sanitize error message in case it somehow contains the API key
  const safeMessage = API_KEY
    ? err.message.replace(API_KEY, '[REDACTED]')
    : err.message;
  console.error(`\n❌ Fatal error: ${safeMessage}\n`);
  process.exit(1);
});