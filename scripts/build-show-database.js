/**
 * build-show-database.js
 *
 * Unified script that builds complete show data by combining Fandom and TMDB.
 *
 * Per show:
 * 1. Find best Fandom wiki by trying multiple slugs and page title variations
 * 2. Fetch TMDB credits for actor photos
 * 3. Parse cast from Fandom cast section
 * 4. Match by actor name to enrich with TMDB photos
 * 5. Fetch character images from Fandom
 * 6. Download images to data/images/[show-slug]/
 * 7. Write complete entry to data/database.json
 *
 * Usage:
 *   export TMDB_API_KEY=your_key
 *   node scripts/build-show-database.js --show "Frozen"
 *   node scripts/build-show-database.js --all
 *   node scripts/build-show-database.js --all --force
 *
 * Safe to re-run — skips shows that already have character images unless --force.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// ─── Configuration ────────────────────────────────────────────────────────────

const DB_PATH = path.resolve(__dirname, '../data/database.json');
const IMAGES_DIR = path.resolve(__dirname, '../data/images');
const CREDITS_PATH = path.resolve(__dirname, '../data/CREDITS.md');
const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com/matanrotman/VoiceCast/main';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w185';

const DELAY_BETWEEN_REQUESTS_MS = 1500;
const DELAY_BETWEEN_SHOWS_MS = 3000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 5000;
const MIN_CAST_LINKS_TO_ACCEPT = 4;

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

// Wiki slugs to try per show type, in priority order
const GENERAL_WIKI_SLUGS = [
  'disney',
  'pixar',
  'dreamworks',
  'nickelodeon',
  'cartoonnetwork',
  'ghibli',
];

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
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function initCreditsFile() {
  if (!fs.existsSync(CREDITS_PATH)) {
    fs.writeFileSync(
      CREDITS_PATH,
      '# Image Credits\n\n' +
      'Character images sourced from Fandom wikis under CC-BY-SA 3.0.\n\n' +
      '| Show | Character | Source URL | License |\n' +
      '|------|-----------|------------|----------|\n',
      'utf8'
    );
  }
}

function appendCredits(showTitle, characterName, sourceUrl) {
  const line = `| ${showTitle} | ${characterName} | ${sourceUrl} | CC-BY-SA 3.0 |\n`;
  fs.appendFileSync(CREDITS_PATH, line, 'utf8');
}

// ─── Download ─────────────────────────────────────────────────────────────────

function downloadImage(url, destPath) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const request = protocol.get(url, {
      headers: {
        'User-Agent': 'VoiceCast/1.0 (https://github.com/matanrotman/VoiceCast)'
      },
      timeout: 15000
    }, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        const loc = response.headers.location;
        if (!loc) return reject(new Error('Redirect with no location'));
        return downloadImage(loc, destPath).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) {
        return reject(new Error(`HTTP ${response.statusCode}`));
      }
      const ct = response.headers['content-type'] || '';
      if (!ct.includes('image')) {
        return reject(new Error(`Not an image: ${ct}`));
      }
      const fileStream = fs.createWriteStream(destPath);
      response.pipe(fileStream);
      fileStream.on('finish', () => { fileStream.close(); resolve(); });
      fileStream.on('error', reject);
    });
    request.on('error', reject);
    request.on('timeout', () => { request.destroy(); reject(new Error('Timeout')); });
  });
}

// ─── TMDB ─────────────────────────────────────────────────────────────────────

async function tmdbFetch(endpoint) {
  const url = `${TMDB_BASE_URL}${endpoint}&api_key=${API_KEY}`;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (res.status === 429) {
        process.stdout.write('\n  ⏳ TMDB rate limited — waiting 30s...\n');
        await sleep(30000);
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

async function fetchTmdbData(tmdbId, tmdbType) {
  const endpoint = tmdbType === 'tv'
    ? `/tv/${tmdbId}/aggregate_credits?language=en-US`
    : `/movie/${tmdbId}/credits?language=en-US`;

  const data = await tmdbFetch(endpoint);
  const rawCast = data.cast || [];
  const photoMap = {};
  const characterMap = {};

  rawCast.forEach(member => {
    const name = (member.name || '').trim();
    if (!name) return;
    const key = normalizeName(name);
    if (member.profile_path) {
      photoMap[key] = `${TMDB_IMAGE_BASE}${member.profile_path}`;
    }
    const charName = (
      member.roles?.[0]?.character ||
      member.character ||
      ''
    ).replace(/\s*\(voice\)/gi, '').trim();
    if (charName && !shouldSkipCharacter(charName)) {
      characterMap[key] = charName;
    }
  });

  return { photoMap, characterMap };
}

// ─── Fandom ───────────────────────────────────────────────────────────────────

async function fandomFetch(url) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'VoiceCast/1.0 (https://github.com/matanrotman/VoiceCast)'
        },
        signal: AbortSignal.timeout(10000)
      });
      if (res.status === 429) {
        process.stdout.write('\n  ⏳ Fandom rate limited — waiting 30s...\n');
        await sleep(30000);
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

/**
 * Generate wiki slugs to try for a show in priority order.
 */
function getWikiSlugsToTry(title) {
  const base = slugify(title)
    .replace(/-the-animated-series$/, '')
    .replace(/-series$/, '')
    .replace(/-movie$/, '');

  const dedicated = [
    base,
    base.split('-').slice(0, 3).join('-'),
    base.replace(/-/g, ''),
  ];

  return [...new Set([...dedicated, ...GENERAL_WIKI_SLUGS])];
}

/**
 * Generate page title variations to try for a show.
 */
function getPageTitlesToTry(title) {
  const base = title.replace(/ /g, '_');
  const words = title.split(' ');

  const variations = [
    base,
    `${base}_(film)`,
    `${base}_(movie)`,
    `${base}_(TV_series)`,
    `${base}_(animated_series)`,
    `${base}_(animation)`,
    `${base}_(cartoon)`,
    `${base}_(anime)`,
  ];

  // "Avatar The Last Airbender" -> "Avatar:_The_Last_Airbender"
  if (words.length > 2) {
    variations.push(`${words[0]}:_${words.slice(1).join('_')}`);
  }

  return [...new Set(variations)];
}

/**
 * Try a specific wiki + page title combo.
 * Returns { sectionIndex, linkCount } or null.
 */
async function tryWikiCombo(slug, pageTitle) {
  try {
    const url = `https://${slug}.fandom.com/api.php?action=parse&page=${encodeURIComponent(pageTitle)}&prop=sections&format=json`;
    const data = await fandomFetch(url);
    if (data.error) return null;

    const sections = data?.parse?.sections || [];
    const castSection = sections.find(s =>
      CAST_SECTION_KEYWORDS.some(k => s.line.toLowerCase().includes(k))
    );
    if (!castSection) return null;

    // Count cast links to measure quality
    const wtUrl = `https://${slug}.fandom.com/api.php?action=parse&page=${encodeURIComponent(pageTitle)}&prop=wikitext&section=${castSection.index}&format=json`;
    await sleep(300);
    const wtData = await fandomFetch(wtUrl);
    const wikitext = wtData?.parse?.wikitext?.['*'] || '';
    const linkCount = (wikitext.match(/\[\[/g) || []).length;

    if (linkCount < MIN_CAST_LINKS_TO_ACCEPT) return null;

    return { sectionIndex: castSection.index, linkCount, wikitext };
  } catch {
    return null;
  }
}

/**
 * Find the best wiki and page title for a show.
 * Returns { wikiSlug, pageTitle, wikitext } or null.
 */
async function findBestWiki(title) {
  const slugs = getWikiSlugsToTry(title);
  const pageTitles = getPageTitlesToTry(title);

  let best = null;

  for (const slug of slugs) {
    for (const pageTitle of pageTitles) {
      await sleep(300);
      const result = await tryWikiCombo(slug, pageTitle);
      if (!result) continue;

      if (!best || result.linkCount > best.linkCount) {
        best = { wikiSlug: slug, pageTitle, ...result };
      }

      // Good enough — stop searching
      if (result.linkCount > 30) break;
    }
    if (best && best.linkCount > 30) break;
  }

  return best;
}

/**
 * Parse actor -> character mappings from wikitext.
 */
function parseCastFromWikitext(wikitext) {
  const results = [];
  // Track by CHARACTER not by actor — one card per character
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

  // Format: * '''[[Character]]''' (voiced by [[Actor]])
  for (const line of lines) {
    if (!line.toLowerCase().includes('voiced by') &&
        !line.toLowerCase().includes('voice by')) continue;

    const charMatch = line.match(/\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/);
    if (!charMatch) continue;
    const fandomPageName = charMatch[1].trim();
    const characterName = charMatch[2]?.trim() || fandomPageName;
    if (shouldSkipCharacter(characterName)) continue;

    // Find ALL actor links after "voiced by" — take the most recent/current one
    const voicedByIndex = line.toLowerCase().indexOf('voiced by');
    if (voicedByIndex === -1) continue;
    const afterVoicedBy = line.substring(voicedByIndex);
    const actorMatches = [...afterVoicedBy.matchAll(/\[\[([^\]|]+?)(?:\|[^\]])?\]\]/g)];
    if (actorMatches.length === 0) continue;

    // Use the last actor listed (most current)
    const actorName = actorMatches[actorMatches.length - 1][1].trim();
    addResult(actorName, characterName, fandomPageName);
  }

  // Format: * '''[[Actor]]''' as [[Character]] or variations
  for (const line of lines) {
    if (!line.includes(' as ')) continue;

    const actorMatch = line.match(/\[\[([^\]|]+?)(?:\|[^\]])?\]\]/);
    if (!actorMatch) continue;
    const actorName = actorMatch[1].trim();

    const afterAs = line.split(' as ').slice(1).join(' as ').trim();
    if (!afterAs) continue;

    // Format A: [[CharPage|'''Char Name''']] or [[CharPage|Char Name]]
    const formatA = afterAs.match(/\[\[([^\]|]+)\|'{0,3}([^\]']+?)'{0,3}\]\]/);
    if (formatA) {
      addResult(actorName, formatA[2], formatA[1]);
      continue;
    }

    // Format B: '''[[Char Name]]''' or '''[[CharPage|Char]]'''
    const formatB = afterAs.match(/'{1,3}\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]'{0,3}/);
    if (formatB) {
      const fandomPage = formatB[1];
      const display = formatB[2] || formatB[1];
      addResult(actorName, display, fandomPage);
      continue;
    }

    // Format C: [[Char Name]] with no formatting
    const formatC = afterAs.match(/^\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/);
    if (formatC) {
      const fandomPage = formatC[1];
      const display = formatC[2] || formatC[1];
      addResult(actorName, display, fandomPage);
      continue;
    }

    // Format D: plain bold text '''Char Name'''
    const formatD = afterAs.match(/^'{1,3}([^'\[{\n]+?)'{1,3}/);
    if (formatD) {
      addResult(actorName, formatD[1], formatD[1]);
      continue;
    }
  }

  // Wikitable patterns for other wiki formats
  // Pattern 1: [[Actor]] | [[CharPage|CharDisplay]]
  const pattern1 = /\|\s*\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]\s*\n\s*\|\s*\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g;
  let match;
  while ((match = pattern1.exec(wikitext)) !== null) {
    addResult(match[1], match[3] || match[2], match[2]);
  }

  // Pattern 2: [[Actor]] | plain text
  const pattern2 = /\|\s*\[\[([^\]|]+)\]\]\s*\n\s*\|\s*([^\n\[|{<]+)/g;
  while ((match = pattern2.exec(wikitext)) !== null) {
    const charName = match[2].trim().replace(/^['*\s]+|['*\s]+$/g, '');
    addResult(match[1], charName, charName);
  }

  return results;
}

/**
 * Fetch character image URL from Fandom.
 */
async function fetchCharacterImageUrl(wikiSlug, fandomPageName) {
  try {
    // Try pageimages first
    const url = `https://${wikiSlug}.fandom.com/api.php?action=query&titles=${encodeURIComponent(fandomPageName)}&prop=pageimages&format=json&pithumbsize=400&redirects=1`;
    const data = await fandomFetch(url);
    const pages = data?.query?.pages || {};
    const page = Object.values(pages)[0];
    if (!page || page.missing !== undefined) return null;
    if (page.thumbnail?.source) return page.thumbnail.source;

    // Fall back to wikitext file parsing
    await sleep(300);
    const wtUrl = `https://${wikiSlug}.fandom.com/api.php?action=parse&page=${encodeURIComponent(fandomPageName)}&prop=wikitext&section=0&format=json&redirects=1`;
    const wtData = await fandomFetch(wtUrl);
    const wikitext = wtData?.parse?.wikitext?.['*'] || '';
    const fileMatch = wikitext.match(/\[\[File:([^\]|]+)/i);
    if (!fileMatch) return null;

    const fileName = fileMatch[1].trim().replace(/ /g, '_');
    await sleep(300);
    const imgUrl = `https://${wikiSlug}.fandom.com/api.php?action=query&titles=File:${encodeURIComponent(fileName)}&prop=imageinfo&iiprop=url&format=json`;
    const imgData = await fandomFetch(imgUrl);
    const imgPages = imgData?.query?.pages || {};
    const imgPage = Object.values(imgPages)[0];
    return imgPage?.imageinfo?.[0]?.url || null;
  } catch {
    return null;
  }
}

// ─── Core: build one show ─────────────────────────────────────────────────────

async function buildShow(show) {
  const showSlug = slugify(show.title);
  const showImagesDir = path.join(IMAGES_DIR, showSlug);

  process.stdout.write(`\n\n📺 ${show.title}`);
  process.stdout.write(`\n   TMDB: ${show.tmdb_id} (${show.tmdb_type})`);

  // Step 1: Fetch TMDB data
  let photoMap = {};
  let tmdbCharacterMap = {};
  try {
    process.stdout.write(`\n   📡 Fetching TMDB credits...`);
    const result = await fetchTmdbData(show.tmdb_id, show.tmdb_type);
    photoMap = result.photoMap;
    tmdbCharacterMap = result.characterMap;
    process.stdout.write(` ${Object.keys(photoMap).length} actor photos`);
    await sleep(DELAY_BETWEEN_REQUESTS_MS);
  } catch (err) {
    const safeErr = API_KEY ? err.message.replace(API_KEY, '[REDACTED]') : err.message;
    process.stdout.write(` ❌ ${safeErr}`);
  }

  // Step 2: Find best Fandom wiki
  process.stdout.write(`\n   📖 Finding Fandom wiki...`);
  const wikiResult = await findBestWiki(show.title);

  let characters = [];
  let resolvedWikiSlug = null;

  if (wikiResult) {
    resolvedWikiSlug = wikiResult.wikiSlug;
    process.stdout.write(` ✅ ${wikiResult.wikiSlug}/${wikiResult.pageTitle} (${wikiResult.linkCount} links)`);

    const fandomCast = parseCastFromWikitext(wikiResult.wikitext);
    process.stdout.write(`\n   👥 Fandom cast: ${fandomCast.length} characters`);

    // Build character list from Fandom enriched with TMDB photos
    for (const entry of fandomCast) {
      const tmdbPhoto = photoMap[normalizeName(entry.actorName)] || null;
      characters.push({
        character_name: entry.characterName,
        fandom_page_name: entry.fandomPageName,
        voice_actor: entry.actorName,
        voice_actor_photo: tmdbPhoto,
        character_image: null,
        character_image_placeholder: true
      });
    }

    // Add TMDB-only named characters that Fandom missed
    const fandomActors = new Set(fandomCast.map(e => normalizeName(e.actorName)));
    for (const [actorKey, charName] of Object.entries(tmdbCharacterMap)) {
      if (!fandomActors.has(actorKey) && !shouldSkipCharacter(charName)) {
        characters.push({
          character_name: charName,
          fandom_page_name: null,
          voice_actor: actorKey,
          voice_actor_photo: photoMap[actorKey] || null,
          character_image: null,
          character_image_placeholder: true
        });
      }
    }

  } else {
    process.stdout.write(` ⚠️  not found — using TMDB only`);
    for (const [actorKey, charName] of Object.entries(tmdbCharacterMap)) {
      if (!shouldSkipCharacter(charName)) {
        characters.push({
          character_name: charName,
          fandom_page_name: null,
          voice_actor: actorKey,
          voice_actor_photo: photoMap[actorKey] || null,
          character_image: null,
          character_image_placeholder: true
        });
      }
    }
  }

  process.stdout.write(`\n   👥 Total characters: ${characters.length}`);

  // Step 3: Fetch character images
  if (resolvedWikiSlug && characters.some(c => c.fandom_page_name)) {
    process.stdout.write(`\n   🎨 Fetching character images...`);
    let imagesFound = 0;
    let imagesMissed = 0;

    ensureDir(showImagesDir);

    for (const character of characters) {
      if (!character.fandom_page_name) {
        imagesMissed++;
        continue;
      }

      await sleep(DELAY_BETWEEN_REQUESTS_MS);

      try {
        const imageUrl = await fetchCharacterImageUrl(
          resolvedWikiSlug,
          character.fandom_page_name
        );

        if (!imageUrl) {
          imagesMissed++;
          process.stdout.write(`\n      ❌ ${character.character_name}`);
          continue;
        }

        const ext = imageUrl.match(/\.(jpg|jpeg|png|webp|gif)/i)?.[1]?.toLowerCase() || 'jpg';
        const charSlug = slugify(character.character_name);
        const fileName = `${charSlug}.${ext}`;
        const destPath = path.join(showImagesDir, fileName);
        const githubUrl = `${GITHUB_RAW_BASE}/data/images/${showSlug}/${fileName}`;

        ensureDir(showImagesDir);
        await downloadImage(imageUrl, destPath);

        character.character_image = githubUrl;
        character.character_image_placeholder = false;
        character.character_image_source = imageUrl;

        appendCredits(show.title, character.character_name, imageUrl);

        imagesFound++;
        process.stdout.write(`\n      ✅ ${character.character_name}`);

      } catch (err) {
        imagesMissed++;
        process.stdout.write(`\n      ❌ ${character.character_name}: ${err.message}`);
      }
    }

    process.stdout.write(`\n   📊 Images: ${imagesFound} found, ${imagesMissed} missed`);
  }

  // Store wiki info for future runs
  show.fandom_wiki = resolvedWikiSlug;
  show.characters = characters;

  return characters;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const showFilter = args.includes('--show')
    ? args[args.indexOf('--show') + 1]?.toLowerCase()
    : null;
  const runAll = args.includes('--all');
  const forceAll = args.includes('--force');

  if (!showFilter && !runAll) {
    console.error('\nUsage:');
    console.error('  node scripts/build-show-database.js --show "Frozen"');
    console.error('  node scripts/build-show-database.js --all');
    console.error('  node scripts/build-show-database.js --all --force\n');
    process.exit(1);
  }

  ensureDir(IMAGES_DIR);
  initCreditsFile();

  const db = loadDatabase();
  let shows = db.shows;

  if (showFilter) {
    shows = shows.filter(s => s.title.toLowerCase() === showFilter);
    if (shows.length === 0) {
      console.error(`\n❌ Show not found: ${showFilter}\n`);
      process.exit(1);
    }
  }

  if (!forceAll) {
    const before = shows.length;
    shows = shows.filter(s =>
      !(s.characters || []).some(c => c.character_image)
    );
    const skipped = before - shows.length;
    if (skipped > 0) {
      console.log(`⏭️  Skipping ${skipped} show(s) that already have character images.`);
      console.log(`   Use --force to reprocess them.\n`);
    }
  }

  console.log(`\n🎬 VoiceCast Database Builder`);
  console.log(`📺 Processing ${shows.length} show(s)\n`);

  let totalImagesFound = 0;
  let totalImagesMissed = 0;
  let totalShowsProcessed = 0;
  let failedShows = [];

  for (let i = 0; i < shows.length; i++) {
    const show = shows[i];
    process.stdout.write(`\n[${i + 1}/${shows.length}]`);

    try {
      const characters = await buildShow(show);
      totalImagesFound += characters.filter(c => c.character_image).length;
      totalImagesMissed += characters.filter(c => !c.character_image).length;
      totalShowsProcessed++;
      saveDatabase(db);
    } catch (err) {
      const safeMsg = API_KEY ? err.message.replace(API_KEY, '[REDACTED]') : err.message;
      process.stdout.write(`\n   ❌ Fatal: ${safeMsg}`);
      failedShows.push(show.title);
    }

    await sleep(DELAY_BETWEEN_SHOWS_MS);
  }

  console.log('\n\n' + '─'.repeat(60));
  console.log('📊 Final Summary');
  console.log('─'.repeat(60));
  console.log(`  Shows processed:    ${totalShowsProcessed}`);
  console.log(`  Character images:   ${totalImagesFound} found, ${totalImagesMissed} missed`);
  console.log(`  Failed shows:       ${failedShows.length}`);
  console.log('─'.repeat(60));

  if (failedShows.length > 0) {
    console.log('\n⚠️  Failed shows:');
    failedShows.slice(0, 20).forEach(t => console.log(`  - ${t}`));
    if (failedShows.length > 20) {
      console.log(`  ... and ${failedShows.length - 20} more`);
    }
  }

  console.log('\n📁 Images: data/images/');
  console.log('📄 Credits: data/CREDITS.md\n');
}

main().catch(err => {
  const safeMsg = API_KEY ? err.message.replace(API_KEY, '[REDACTED]') : err.message;
  console.error(`\n❌ Fatal error: ${safeMsg}\n`);
  process.exit(1);
});