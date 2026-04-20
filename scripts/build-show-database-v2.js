/**
 * build-show-database-v2.js
 *
 * Faster, crash-safe replacement for build-show-database.js.
 *
 * What's different:
 * - SQLite checkpoint: resumes exactly where it left off after a crash
 * - 5 shows processed in parallel (was 1)
 * - Character images fetched 3 at a time per show (was 1)
 * - Bottleneck rate limiter: 1 concurrent request per wiki, 5 globally
 * - All existing logic preserved: same parser, same TMDB enrichment, same output format
 *
 * Usage:
 *   export TMDB_API_KEY=your_key
 *   node scripts/build-show-database-v2.js --all
 *   node scripts/build-show-database-v2.js --show "Frozen"
 *   node scripts/build-show-database-v2.js --all --force
 *
 * Safe to stop with Ctrl+C and restart — it resumes automatically.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const Database = require('better-sqlite3');
const Bottleneck = require('bottleneck');

// ─── Configuration ────────────────────────────────────────────────────────────

const DB_PATH = path.resolve(__dirname, '../data/database.json');
const IMAGES_DIR = path.resolve(__dirname, '../data/images');
const CREDITS_PATH = path.resolve(__dirname, '../data/CREDITS.md');
const CHECKPOINT_PATH = path.resolve(__dirname, '../data/build-checkpoint.db');
const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com/matanrotman/VoiceCast/main';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w185';

const DELAY_MS = 1000;            // min ms between requests to same wiki
const MAX_RETRIES = 3;
const MIN_CAST_LINKS = 4;

// Concurrency limits
const GLOBAL_CONCURRENCY = 5;     // max parallel shows
const PER_WIKI_CONCURRENCY = 1;   // max parallel requests to one wiki subdomain
const IMAGE_CONCURRENCY = 3;      // max parallel image fetches per show

const SKIP_CHARACTER_PATTERNS = [
  /^additional voices?$/i,
  /^various$/i,
  /^uncredited$/i,
  /^voice$/i,
  /^misc\.?\s*voices?$/i,
  /^background voices?$/i,
  /^ensemble$/i,
  /^and more$/i,
  /^others?$/i,
];

const CAST_SECTION_KEYWORDS = ['voice cast', 'cast', 'voices', 'voice actors'];

const GENERAL_WIKI_SLUGS = [];

// ─── API key ──────────────────────────────────────────────────────────────────

const API_KEY = process.env.TMDB_API_KEY;
if (!API_KEY) {
  console.error('\n❌ TMDB_API_KEY not set. Run: export TMDB_API_KEY=your_key\n');
  process.exit(1);
}
if (!/^[a-f0-9]{32}$/i.test(API_KEY)) {
  console.error('\n❌ TMDB_API_KEY does not look valid.\n');
  process.exit(1);
}

// ─── Checkpoint DB ────────────────────────────────────────────────────────────

function openCheckpoint() {
  const db = new Database(CHECKPOINT_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS completed_shows (
      tmdb_id INTEGER PRIMARY KEY,
      title TEXT,
      finished_at TEXT
    )
  `);
  return db;
}

// ─── Bottleneck limiters ──────────────────────────────────────────────────────

// One global limiter caps total concurrent work
const globalLimiter = new Bottleneck({ maxConcurrent: GLOBAL_CONCURRENCY });

// Per-wiki limiters created on demand — keyed by wiki slug
const wikiLimiters = new Map();
function getWikiLimiter(slug) {
  if (!wikiLimiters.has(slug)) {
    wikiLimiters.set(slug, new Bottleneck({
      maxConcurrent: PER_WIKI_CONCURRENCY,
      minTime: DELAY_MS,
    }));
  }
  return wikiLimiters.get(slug);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function shouldSkipCharacter(name) {
  return SKIP_CHARACTER_PATTERNS.some(p => p.test(name.trim()));
}

function normalizeName(name) {
  return name.toLowerCase().trim().replace(/\s+/g, ' ');
}

function loadDatabase() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch {
    console.error('\n❌ Could not load data/database.json\n');
    process.exit(1);
  }
}

function saveDatabase(db) {
  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DB_PATH);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function initCreditsFile() {
  if (!fs.existsSync(CREDITS_PATH)) {
    fs.writeFileSync(
      CREDITS_PATH,
      '# Image Credits\n\nCharacter images sourced from Fandom wikis under CC-BY-SA 3.0.\n\n' +
      '| Show | Character | Source URL | License |\n' +
      '|------|-----------|------------|----------|\n',
      'utf8'
    );
  }
}

// Mutex so concurrent shows don't interleave credits writes
const creditsMutex = { locked: false, queue: [] };
function appendCredits(showTitle, characterName, sourceUrl) {
return new Promise(resolve => {
    const write = () => {
      creditsMutex.locked = true;
      try {
        const line = `| ${showTitle} | ${characterName} | ${sourceUrl} | CC-BY-SA 3.0 |\n`;
        fs.appendFileSync(CREDITS_PATH, line, 'utf8');
      } finally {
        creditsMutex.locked = false;
        const next = creditsMutex.queue.shift();
        if (next) next();
        resolve();
      }
    };
    if (creditsMutex.locked) {
      creditsMutex.queue.push(write);
    } else {
      write();
    }
  });
}

// DB save mutex — only one show saves at a time
let saveLocked = false;
const saveQueue = [];
function safeSaveDatabase(db) {
return new Promise(resolve => {
    const doSave = () => {
      saveLocked = true;
      try {
        saveDatabase(db);
      } finally {
        saveLocked = false;
        const next = saveQueue.shift();
        if (next) next();
        resolve();
      }
    };
    if (saveLocked) {
      saveQueue.push(doSave);
    } else {
      doSave();
    }
  });
}

// ─── Download ─────────────────────────────────────────────────────────────────

function downloadImage(url, destPath) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const request = protocol.get(url, {
      headers: { 'User-Agent': 'VoiceCastBot/2.0 (https://github.com/matanrotman/VoiceCast)' },
      timeout: 15000,
    }, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        const loc = response.headers.location;
        if (!loc) return reject(new Error('Redirect with no location'));
        return downloadImage(loc, destPath).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) return reject(new Error(`HTTP ${response.statusCode}`));
      const ct = response.headers['content-type'] || '';
      if (!ct.includes('image')) return reject(new Error(`Not an image: ${ct}`));
      const fileStream = fs.createWriteStream(destPath);
      response.pipe(fileStream);
      fileStream.on('finish', () => { fileStream.close(); resolve(); });
      fileStream.on('error', reject);
    });
    request.on('error', reject);
    request.on('timeout', () => { request.destroy(); reject(new Error('Timeout')); });
  });
}

// ─── HTTP fetch with retry ────────────────────────────────────────────────────

async function fetchWithRetry(url, label = '') {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'VoiceCastBot/2.0 (https://github.com/matanrotman/VoiceCast)' },
        signal: AbortSignal.timeout(12000),
      });
      if (res.status === 429 || res.status === 503) {
        const retryAfter = Number(res.headers.get('Retry-After'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(60000, 1000 * 2 ** attempt);
        await sleep(wait + Math.random() * 500);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}${label ? ' ' + label : ''}`);
      return await res.json();
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err;
      await sleep(1000 * 2 ** attempt + Math.random() * 500);
    }
  }
}

// Wrap a fetch call in the per-wiki limiter
function wikiFetch(slug, url) {
  return getWikiLimiter(slug).schedule(() => fetchWithRetry(url, slug));
}

// ─── TMDB ─────────────────────────────────────────────────────────────────────

async function fetchTmdbData(tmdbId, tmdbType) {
  const endpoint = tmdbType === 'tv'
    ? `/tv/${tmdbId}/aggregate_credits?language=en-US`
    : `/movie/${tmdbId}/credits?language=en-US`;
  const url = `${TMDB_BASE_URL}${endpoint}&api_key=${API_KEY}`;
  const data = await fetchWithRetry(url);
  const rawCast = data.cast || [];
  const photoMap = {};
  const characterMap = {};

  rawCast.forEach(member => {
    const name = (member.name || '').trim();
    if (!name) return;
    const key = normalizeName(name);
    if (member.profile_path) photoMap[key] = `${TMDB_IMAGE_BASE}${member.profile_path}`;
    const charName = (
      member.roles?.[0]?.character || member.character || ''
    ).replace(/\s*\(voice\)/gi, '').trim();
    if (charName && !shouldSkipCharacter(charName)) characterMap[key] = charName;
  });

  return { photoMap, characterMap };
}

// ─── Fandom wiki discovery ────────────────────────────────────────────────────

function getWikiSlugsToTry(title) {
  const base = slugify(title)
    .replace(/-the-animated-series$/, '')
    .replace(/-series$/, '')
    .replace(/-movie$/, '');
  const dedicated = [base, base.split('-').slice(0, 3).join('-'), base.replace(/-/g, '')];
  return [...new Set([...dedicated, ...GENERAL_WIKI_SLUGS])];
}

function getPageTitlesToTry(title) {
  const base = title.replace(/ /g, '_');
  const words = title.split(' ');
  const variations = [
    base,
    `${base}_(film)`, `${base}_(movie)`, `${base}_(TV_series)`,
    `${base}_(animated_series)`, `${base}_(animation)`,
    `${base}_(cartoon)`, `${base}_(anime)`,
  ];
  if (words.length > 2) variations.push(`${words[0]}:_${words.slice(1).join('_')}`);
  return [...new Set(variations)];
}

async function tryWikiCombo(slug, pageTitle) {
  try {
    const url = `https://${slug}.fandom.com/api.php?action=parse&page=${encodeURIComponent(pageTitle)}&prop=sections&format=json`;
    const data = await wikiFetch(slug, url);
    if (data.error) return null;

    const sections = data?.parse?.sections || [];
    const castSection = sections.find(s =>
      CAST_SECTION_KEYWORDS.some(k => s.line.toLowerCase().includes(k))
    );
    if (!castSection) return null;

    const wtUrl = `https://${slug}.fandom.com/api.php?action=parse&page=${encodeURIComponent(pageTitle)}&prop=wikitext&section=${castSection.index}&format=json`;
    const wtData = await wikiFetch(slug, wtUrl);
    const wikitext = wtData?.parse?.wikitext?.['*'] || '';
    const linkCount = (wikitext.match(/\[\[/g) || []).length;

    if (linkCount < MIN_CAST_LINKS) return null;
    return { sectionIndex: castSection.index, linkCount, wikitext };
} catch (err) {
    console.log(`  ⚠️  Wiki probe failed [${slug}/${pageTitle}]: ${err.message}`);
    return null;
  }
}

async function findBestWiki(title) {
  const slugs = getWikiSlugsToTry(title);
  const pageTitles = getPageTitlesToTry(title);
  let best = null;
  let attempt = 0;
  let totalAttempts = slugs.length * pageTitles.length;

  for (const slug of slugs) {
    for (const pageTitle of pageTitles) {
      attempt++;
      process.stdout.write(`\r  Wiki ... (discovering ${attempt}/${totalAttempts})  `);
      const result = await tryWikiCombo(slug, pageTitle);
      if (!result) continue;
      if (!best || result.linkCount > best.linkCount) {
        best = { wikiSlug: slug, pageTitle, ...result };
      }
      if (result.linkCount > 30) break;
    }
    if (best && best.linkCount > 30) break;

    if (!best) {
      const searchTitles = await searchWikiForPage(slug, title);
      totalAttempts += searchTitles.length;
      for (const pageTitle of searchTitles) {
        attempt++;
        process.stdout.write(`\r  Wiki ... (discovering ${attempt}/${totalAttempts})  `);
        const result = await tryWikiCombo(slug, pageTitle);
        if (!result) continue;
        if (!best || result.linkCount > best.linkCount) {
          best = { wikiSlug: slug, pageTitle, ...result };
        }
        if (result.linkCount > 30) break;
      }
      if (best && best.linkCount > 30) break;
    }
  }

  process.stdout.write('\r' + ' '.repeat(60) + '\r');
  return best;
}

// For shows where fandom_wiki is already known — skip discovery, fetch directly
async function fetchKnownWiki(wikiSlug, title) {
  const pageTitles = getPageTitlesToTry(title);
  for (const pageTitle of pageTitles) {
    const result = await tryWikiCombo(wikiSlug, pageTitle);
    if (result) return { wikiSlug, pageTitle, ...result };
  }
  // Fallback: search the wiki for the correct page title
  const searchTitles = await searchWikiForPage(wikiSlug, title);
  for (const pageTitle of searchTitles) {
    const result = await tryWikiCombo(wikiSlug, pageTitle);
    if (result) return { wikiSlug, pageTitle, ...result };
  }
  return null;
}
// Search a wiki for a page title when direct guesses fail
async function searchWikiForPage(slug, title) {
  try {
    const url = `https://${slug}.fandom.com/api.php?action=opensearch&search=${encodeURIComponent(title)}&limit=5&format=json`;
    const data = await wikiFetch(slug, url);
    if (!Array.isArray(data) || !Array.isArray(data[1])) return [];
    return data[1].map(t => t.replace(/ /g, '_'));
  } catch (err) {
    console.log(`  ⚠️  Wiki search failed [${slug}]: ${err.message}`);
    return [];
  }
}
// ─── Wikitext parser (unchanged from v1) ─────────────────────────────────────

function parseCastFromWikitext(wikitext) {
  const results = [];
  const seenCharacters = new Set();

  function addResult(actorName, characterName, fandomPageName) {
    actorName = actorName.trim();
    characterName = characterName.trim();
    fandomPageName = (fandomPageName || characterName).trim();
    const key = normalizeName(characterName);
    if (!actorName || !characterName) return;
    if (seenCharacters.has(key)) return;
    if (shouldSkipCharacter(characterName)) return;
    if (characterName.length > 80) return;
    results.push({ actorName, characterName, fandomPageName });
    seenCharacters.add(key);
  }

  const lines = wikitext.split('\n');

  for (const line of lines) {
    if (!line.toLowerCase().includes('voiced by') && !line.toLowerCase().includes('voice by')) continue;
    const charMatch = line.match(/\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/);
    if (!charMatch) continue;
    const fandomPageName = charMatch[1].trim();
    const characterName = charMatch[2]?.trim() || fandomPageName;
    if (shouldSkipCharacter(characterName)) continue;
    const voicedByIndex = line.toLowerCase().indexOf('voiced by');
    if (voicedByIndex === -1) continue;
    const afterVoicedBy = line.substring(voicedByIndex);
const actorMatches = [...afterVoicedBy.matchAll(/\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]/g)];
    if (actorMatches.length === 0) continue;
    const actorName = actorMatches[actorMatches.length - 1][1].trim();
    addResult(actorName, characterName, fandomPageName);
  }

  for (const line of lines) {
    if (!line.includes(' as ')) continue;
    const actorMatch = line.match(/\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]/);
    if (!actorMatch) continue;
    const actorName = actorMatch[1].trim();
    const afterAs = line.split(' as ').slice(1).join(' as ').trim();
    if (!afterAs) continue;
    const formatA = afterAs.match(/\[\[([^\]|]+)\|'{0,3}([^\]']+?)'{0,3}\]\]/);
    if (formatA) { addResult(actorName, formatA[2], formatA[1]); continue; }
    const formatB = afterAs.match(/'{1,3}\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]'{0,3}/);
    if (formatB) { addResult(actorName, formatB[2] || formatB[1], formatB[1]); continue; }
    const formatC = afterAs.match(/^\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/);
    if (formatC) { addResult(actorName, formatC[2] || formatC[1], formatC[1]); continue; }
    const formatD = afterAs.match(/^'{1,3}([^'\[{\n]+?)'{1,3}/);
    if (formatD) { addResult(actorName, formatD[1], formatD[1]); continue; }
  }

  const pattern1 = /\|\s*\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]\s*\n\s*\|\s*\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g;
  let match;
  while ((match = pattern1.exec(wikitext)) !== null) addResult(match[1], match[3] || match[2], match[2]);

  const pattern2 = /\|\s*\[\[([^\]|]+)\]\]\s*\n\s*\|\s*([^\n\[|{<]+)/g;
  while ((match = pattern2.exec(wikitext)) !== null) {
    const charName = match[2].trim().replace(/^['*\s]+|['*\s]+$/g, '');
    addResult(match[1], charName, charName);
  }

  return results;
}

// ─── Character image fetching ─────────────────────────────────────────────────

async function fetchCharacterImageUrl(wikiSlug, fandomPageName) {
  try {
    const url = `https://${wikiSlug}.fandom.com/api.php?action=query&titles=${encodeURIComponent(fandomPageName)}&prop=pageimages&format=json&pithumbsize=400&redirects=1`;
    const data = await wikiFetch(wikiSlug, url);
    const pages = data?.query?.pages || {};
    const page = Object.values(pages)[0];
    if (!page || page.missing !== undefined) return null;
    if (page.thumbnail?.source) return page.thumbnail.source;

    const wtUrl = `https://${wikiSlug}.fandom.com/api.php?action=parse&page=${encodeURIComponent(fandomPageName)}&prop=wikitext&section=0&format=json&redirects=1`;
    const wtData = await wikiFetch(wikiSlug, wtUrl);
    const wikitext = wtData?.parse?.wikitext?.['*'] || '';
    const fileMatch = wikitext.match(/\[\[File:([^\]|]+)/i);
    if (!fileMatch) return null;

    const fileName = fileMatch[1].trim().replace(/ /g, '_');
    const imgUrl = `https://${wikiSlug}.fandom.com/api.php?action=query&titles=File:${encodeURIComponent(fileName)}&prop=imageinfo&iiprop=url&format=json`;
    const imgData = await wikiFetch(wikiSlug, imgUrl);
    const imgPages = imgData?.query?.pages || {};
    const imgPage = Object.values(imgPages)[0];
    return imgPage?.imageinfo?.[0]?.url || null;
} catch (err) {
    console.log(`  ⚠️  Image fetch failed [${wikiSlug}/${fandomPageName}]: ${err.message}`);
    return null;
  }
}

// Fetch images for a batch of characters concurrently (IMAGE_CONCURRENCY at a time)
async function fetchCharacterImagesBatch(characters, wikiSlug, showSlug, showTitle) {
  const showImagesDir = path.join(IMAGES_DIR, showSlug);
  ensureDir(showImagesDir);

  let imagesFound = 0;
  let imagesMissed = 0;

console.log(`  Downloading ${characters.length} character images`);
  for (let i = 0; i < characters.length; i += IMAGE_CONCURRENCY) {
    const chunk = characters.slice(i, i + IMAGE_CONCURRENCY);
    await Promise.all(chunk.map(async (character) => {
      if (!character.fandom_page_name) { imagesMissed++; return; }
      try {
        const imageUrl = await fetchCharacterImageUrl(wikiSlug, character.fandom_page_name);
        if (!imageUrl) { imagesMissed++; return; }

        const ext = imageUrl.match(/\.(jpg|jpeg|png|webp|gif)/i)?.[1]?.toLowerCase() || 'jpg';
        const charSlug = slugify(character.character_name);
        const fileName = `${charSlug}.${ext}`;
        const destPath = path.join(showImagesDir, fileName);
        const githubUrl = `${GITHUB_RAW_BASE}/data/images/${showSlug}/${fileName}`;

        await downloadImage(imageUrl, destPath);
        character.character_image = githubUrl;
        character.character_image_placeholder = false;
        character.character_image_source = imageUrl;
        await appendCredits(showTitle, character.character_name, imageUrl);
        console.log(`    \x1b[32m✓\x1b[0m ${character.character_name}`);
        imagesFound++;
      } catch (err) {
        console.log(`    ✗ ${character.character_name}: ${err.message}`);
        imagesMissed++;
      }
    }));
  }

  return { imagesFound, imagesMissed };
}

// ─── Core: build one show ─────────────────────────────────────────────────────

async function buildShow(show, checkpoint, showIndex, totalShows) {
  const showSlug = slugify(show.title);
 const progress = `[${showIndex}/${totalShows}]`;
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`${progress} ${show.title}`);
  console.log('─'.repeat(50));

  // Step 1: TMDB
let photoMap = {};
  let tmdbCharacterMap = {};
  console.log(`  TMDB ...`);
  try {
    const result = await fetchTmdbData(show.tmdb_id, show.tmdb_type);
    photoMap = result.photoMap;
    tmdbCharacterMap = result.characterMap;
console.log(`  TMDB ✓ ${Object.keys(photoMap).length} photos, ${Object.keys(tmdbCharacterMap).length} characters`);  } catch (err) {
console.log(`  TMDB ✗ ${err.message}`);  }

  // Step 2: Fandom wiki
let wikiResult = null;
  if (show.fandom_wiki) {
    console.log(`  Wiki ... (known: ${show.fandom_wiki})`);
    wikiResult = await fetchKnownWiki(show.fandom_wiki, show.title);
  } else {
    console.log(`  Wiki ... (discovering)`);
    wikiResult = await findBestWiki(show.title);
    if (wikiResult) show.fandom_wiki = wikiResult.wikiSlug;
  }
  console.log(`  Wiki ${wikiResult ? `✓ ${wikiResult.wikiSlug} (${wikiResult.linkCount} cast links)` : '✗ not found'}`);

  // Step 3: Build character list
  let characters = [];
  if (wikiResult) {
    const fandomCast = parseCastFromWikitext(wikiResult.wikitext);
    for (const entry of fandomCast) {
      characters.push({
        character_name: entry.characterName,
        fandom_page_name: entry.fandomPageName,
        voice_actor: entry.actorName,
        voice_actor_photo: photoMap[normalizeName(entry.actorName)] || null,
        character_image: null,
        character_image_placeholder: true,
      });
    }
    const fandomActors = new Set(fandomCast.map(e => normalizeName(e.actorName)));
    for (const [actorKey, charName] of Object.entries(tmdbCharacterMap)) {
      if (!fandomActors.has(actorKey) && !shouldSkipCharacter(charName)) {
        characters.push({
          character_name: charName,
          fandom_page_name: null,
          voice_actor: actorKey,
          voice_actor_photo: photoMap[actorKey] || null,
          character_image: null,
          character_image_placeholder: true,
        });
      }
    }
  } else {
    for (const [actorKey, charName] of Object.entries(tmdbCharacterMap)) {
      if (!shouldSkipCharacter(charName)) {
        characters.push({
          character_name: charName,
          fandom_page_name: null,
          voice_actor: actorKey,
          voice_actor_photo: photoMap[actorKey] || null,
          character_image: null,
          character_image_placeholder: true,
        });
      }
    }
  }

  // Step 4: Fetch character images (concurrently)
  let imagesFound = 0;
  let imagesMissed = 0;
  if (wikiResult && characters.some(c => c.fandom_page_name)) {
    const result = await fetchCharacterImagesBatch(
      characters, wikiResult.wikiSlug, showSlug, show.title
    );
    imagesFound = result.imagesFound;
    imagesMissed = result.imagesMissed;
  }

  show.characters = characters;

console.log(`  Images ${imagesFound}/${characters.length}`);
  console.log(`  \x1b[32mDone ✓\x1b[0m ${characters.length} chars, ${imagesFound} images`);

  return { imagesFound, imagesMissed };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const showFilter = args.includes('--show')
    ? args[args.indexOf('--show') + 1]?.toLowerCase()
    : null;
  const runAll = args.includes('--all');
  const forceAll = args.includes('--force');
  const limitArg = args.includes('--limit')
    ? parseInt(args[args.indexOf('--limit') + 1], 10)
    : null;

  if (!showFilter && !runAll) {
    console.error('\nUsage:');
    console.error('  node scripts/build-show-database-v2.js --show "Frozen"');
    console.error('  node scripts/build-show-database-v2.js --all');
    console.error('  node scripts/build-show-database-v2.js --all --force\n');
    process.exit(1);
  }

  ensureDir(IMAGES_DIR);
  initCreditsFile();

  const db = loadDatabase();
  const checkpoint = openCheckpoint();

  
  // Load already-completed show IDs from checkpoint
  const completedIds = new Set(
    checkpoint.prepare('SELECT tmdb_id FROM completed_shows').all().map(r => r.tmdb_id)
  );
  const markComplete = checkpoint.prepare(
    'INSERT OR REPLACE INTO completed_shows (tmdb_id, title, finished_at) VALUES (?, ?, ?)'
  );

let shows = db.shows;

  if (showFilter) {
    shows = shows.filter(s => s.title.toLowerCase() === showFilter);
    if (shows.length === 0) {
      console.error(`\n❌ Show not found: ${showFilter}\n`);
      process.exit(1);
    }
  }

if (!forceAll && !showFilter) {
    const beforeSkip = shows.length;
    // Skip shows already in checkpoint OR already have images
    shows = shows.filter(s =>
      !completedIds.has(s.tmdb_id) &&
    !((s.characters || []).length > 0 && (s.characters || []).every(c => c.character_image))    );
    const skipped = beforeSkip - shows.length;
    if (skipped > 0) console.log(`⏭️  Skipping ${skipped} already-complete shows. Use --force to reprocess.\n`);
  }

  if (limitArg && limitArg > 0) shows = shows.slice(0, limitArg);
  console.log(`\n🎬 VoiceCast Database Builder v2`);
  console.log(`📺 Processing ${shows.length} shows (${GLOBAL_CONCURRENCY} parallel)\n`);

  let totalImagesFound = 0;
  let totalImagesMissed = 0;
  let totalProcessed = 0;
  let failed = [];

  // Process shows in parallel chunks
  for (let i = 0; i < shows.length; i += GLOBAL_CONCURRENCY) {
    const chunk = shows.slice(i, i + GLOBAL_CONCURRENCY);

await Promise.all(chunk.map((show, chunkIdx) =>
      globalLimiter.schedule(async () => {
        try {
          const showIndex = i + chunkIdx + 1;
          const { imagesFound, imagesMissed } = await buildShow(show, checkpoint, showIndex, shows.length);
          totalImagesFound += imagesFound;
          totalImagesMissed += imagesMissed;
          totalProcessed++;
          markComplete.run(show.tmdb_id, show.title, new Date().toISOString());
          await safeSaveDatabase(db);
        } catch (err) {
          const safeMsg = err.message.replace(API_KEY, '[REDACTED]');
          console.log(`❌ ${show.title}: ${safeMsg}`);
          failed.push(show.title);
        }
      })
    ));

    console.log(`\n📊 Progress: ${Math.min(i + GLOBAL_CONCURRENCY, shows.length)}/${shows.length} shows\n`);
  }

  console.log('\n' + '─'.repeat(60));
  console.log('📊 Final Summary');
  console.log('─'.repeat(60));
  console.log(`  Shows processed:  ${totalProcessed}`);
  console.log(`  Images found:     ${totalImagesFound}`);
  console.log(`  Images missed:    ${totalImagesMissed}`);
  console.log(`  Failed shows:     ${failed.length}`);
  if (failed.length > 0) {
    console.log('\n⚠️  Failed:');
    failed.slice(0, 20).forEach(t => console.log(`  - ${t}`));
  }
  console.log('─'.repeat(60) + '\n');

  checkpoint.close();
}

// Graceful Ctrl+C — SQLite WAL ensures nothing is lost
process.on('SIGINT', () => {
  console.log('\n\n⚠️  Interrupted. Progress saved — restart to resume.\n');
  process.exit(0);
});

main().catch(err => {
  const safeMsg = err.message.replace(API_KEY || '', '[REDACTED]');
  console.error(`\n❌ Fatal: ${safeMsg}\n`);
  process.exit(1);
});