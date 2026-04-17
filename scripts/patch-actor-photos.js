'use strict';

const fs = require('fs');
const path = require('path');

const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w185';
const DB_PATH = path.resolve(__dirname, '../data/database.json');
const DELAY_MS = 1000;
const MAX_RETRIES = 2;

const API_KEY = process.env.TMDB_API_KEY;

if (!API_KEY) {
  console.error('\n❌ ERROR: TMDB_API_KEY not set.\n');
  process.exit(1);
}

if (!/^[a-f0-9]{32}$/i.test(API_KEY)) {
  console.error('\n❌ ERROR: Invalid TMDB API key.\n');
  process.exit(1);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function loadDatabase() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch {
    console.error('\n❌ Could not load database.\n');
    process.exit(1);
  }
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
      if (res.status === 429) {
        console.log('\n  ⏳ Rate limited — waiting 30s...');
        await sleep(30000);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err;
      await sleep(3000);
    }
  }
}

function printProgress(current, total, label) {
  const pct = total === 0 ? 100 : Math.round((current / total) * 100);
  const filled = Math.floor(pct / 2);
  const bar = '█'.repeat(filled) + '░'.repeat(50 - filled);
  const safeLabel = label.substring(0, 28).padEnd(28);
  process.stdout.write(`\r[${bar}] ${String(pct).padStart(3)}% (${current}/${total}) ${safeLabel}`);
}

async function main() {
  const db = loadDatabase();

  // Find shows where any character is missing a voice_actor_photo
 const showsToFix = db.shows.filter(s =>
    (s.characters || []).every(c => !c.voice_actor_photo) &&
    (s.characters || []).length > 0
  );

  console.log(`\n🔧 Patching actor photos`);
  console.log(`📺 Shows needing patches: ${showsToFix.length}\n`);

  let fixed = 0;
  let errors = 0;

  for (let i = 0; i < showsToFix.length; i++) {
    const show = showsToFix[i];
    printProgress(i, showsToFix.length, show.title);

    try {
      const endpoint = show.tmdb_type === 'tv'
        ? `${TMDB_BASE_URL}/tv/${show.tmdb_id}/aggregate_credits?language=en-US`
        : `${TMDB_BASE_URL}/movie/${show.tmdb_id}/credits?language=en-US`;

      const data = await fetchWithRetry(endpoint);
      const rawCast = data.cast || [];

      // Build a lookup map from actor name to photo URL
      const photoMap = {};
      rawCast.forEach(member => {
        const name = (member.name || '').trim();
        if (name && member.profile_path) {
          photoMap[name] = `${TMDB_IMAGE_BASE}${member.profile_path}`;
        }
      });

      // Patch each character in this show
      let patched = 0;
      (show.characters || []).forEach(character => {
        if (!character.voice_actor_photo && character.voice_actor) {
          const photo = photoMap[character.voice_actor];
          if (photo) {
            character.voice_actor_photo = photo;
            patched++;
          }
        }
      });

      if (patched > 0) {
        saveDatabase(db);
        fixed++;
      }

      await sleep(DELAY_MS);

    } catch (err) {
      const safeError = API_KEY ? err.message.replace(API_KEY, '[REDACTED]') : err.message;
      errors++;
    }
  }

  printProgress(showsToFix.length, showsToFix.length, 'Complete');
  console.log('\n');
  console.log('─'.repeat(60));
  console.log('📊 Summary');
  console.log('─'.repeat(60));
  console.log(`  Shows patched:  ${fixed}`);
  console.log(`  Errors:         ${errors}`);
  console.log('─'.repeat(60));

  if (errors === 0) {
    console.log('\n✅ All actor photos patched successfully.\n');
  } else {
    console.log(`\n⚠️  ${errors} show(s) failed. Re-run to retry.\n`);
  }
}

main().catch(err => {
  const safeMsg = API_KEY ? err.message.replace(API_KEY, '[REDACTED]') : err.message;
  console.error(`\n❌ Fatal error: ${safeMsg}\n`);
  process.exit(1);
});