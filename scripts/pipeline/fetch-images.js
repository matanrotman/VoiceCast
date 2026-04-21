#!/usr/bin/env node
'use strict';

/**
 * fetch-images.js
 *
 * Downloads character images from Fandom wikis using verified wiki mappings.
 * Processes shows in batches of 100.
 *
 * Flow per show:
 *   1. Look up wiki slug from data/wiki-mappings.json
 *   2. Find the cast/voice cast section on the wiki page
 *   3. Parse wikitext for character→actor mappings (gets fandom_page_name)
 *   4. Batch-query pageimages API for character images
 *   5. Download and resize images to 200px width
 *   6. Update database.json with relative paths
 *
 * Usage:
 *   node scripts/pipeline/fetch-images.js --batch 1       # shows 1-100
 *   node scripts/pipeline/fetch-images.js --batch 2       # shows 101-200
 *   node scripts/pipeline/fetch-images.js --show "Shrek"  # single show
 *   node scripts/pipeline/fetch-images.js --resume        # skip completed
 *   node scripts/pipeline/fetch-images.js --dry-run       # no downloads
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '../..');
const DB_PATH = path.join(ROOT, 'data/database.json');
const MAPPINGS_PATH = path.join(ROOT, 'data/wiki-mappings.json');
const IMAGES_DIR = path.join(ROOT, 'data/images');
const PROGRESS_PATH = path.join(ROOT, 'data/batch-progress.json');

const REQUEST_DELAY = 1200;    // ms between wiki API requests
const IMAGE_DL_DELAY = 500;   // ms between image downloads
const IMAGE_WIDTH = 200;      // resize target
const MIN_CAST_LINKS = 4;
const CAST_SECTION_KEYWORDS = ['voice cast', 'cast', 'voices', 'voice actors'];
const BATCH_SIZE = 100;

const SKIP_PATTERNS = [
  /^additional voices?$/i, /^various$/i, /^uncredited$/i, /^voice$/i,
  /^misc\.?\s*voices?$/i, /^background voices?$/i, /^ensemble$/i,
  /^and more$/i, /^others?$/i, /^self$/i, /^self\s*[-–—]/i,
  /\(uncredited\)/i, /^narrator$/i,
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function normalizeName(name) {
  return name.toLowerCase().trim().replace(/\s+/g, ' ');
}

function shouldSkipCharacter(name) {
  return SKIP_PATTERNS.some(p => p.test((name || '').trim()));
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function fetchJson(url) {
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'VoiceCastBot/3.0 (https://github.com/matanrotman/VoiceCast)' },
        signal: AbortSignal.timeout(12000),
      });
      if (res.status === 429 || res.status === 503) {
        const wait = Math.min(30000, 2000 * 2 ** attempt);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === 2) throw err;
      await sleep(1500 * (attempt + 1));
    }
  }
}

function downloadToBuffer(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.get(url, {
      headers: { 'User-Agent': 'VoiceCastBot/3.0 (https://github.com/matanrotman/VoiceCast)' },
      timeout: 20000,
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location;
        if (!loc) return reject(new Error('Redirect with no location'));
        return downloadToBuffer(loc).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const ct = res.headers['content-type'] || '';
      if (!ct.includes('image')) return reject(new Error(`Not an image: ${ct}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ─── Wiki cast section finder ─────────────────────────────────────────────────

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

async function findCastSection(wikiSlug, title) {
  const pageTitles = getPageTitlesToTry(title);

  // Try direct page title guesses
  for (const pageTitle of pageTitles) {
    const result = await tryCastSection(wikiSlug, pageTitle);
    if (result) return result;
    await sleep(REQUEST_DELAY);
  }

  // Fallback: opensearch
  try {
    const searchUrl = `https://${wikiSlug}.fandom.com/api.php?action=opensearch&search=${encodeURIComponent(title)}&limit=5&format=json`;
    const searchData = await fetchJson(searchUrl);
    await sleep(REQUEST_DELAY);
    if (Array.isArray(searchData) && Array.isArray(searchData[1])) {
      for (const t of searchData[1]) {
        const result = await tryCastSection(wikiSlug, t.replace(/ /g, '_'));
        if (result) return result;
        await sleep(REQUEST_DELAY);
      }
    }
  } catch {}

  return null;
}

async function tryCastSection(slug, pageTitle) {
  try {
    const url = `https://${slug}.fandom.com/api.php?action=parse&page=${encodeURIComponent(pageTitle)}&prop=sections&format=json`;
    const data = await fetchJson(url);
    if (data.error) return null;

    const sections = data?.parse?.sections || [];
    const castSection = sections.find(s =>
      CAST_SECTION_KEYWORDS.some(k => s.line.toLowerCase().includes(k))
    );
    if (!castSection) return null;

    const wtUrl = `https://${slug}.fandom.com/api.php?action=parse&page=${encodeURIComponent(pageTitle)}&prop=wikitext&section=${castSection.index}&format=json`;
    const wtData = await fetchJson(wtUrl);
    await sleep(REQUEST_DELAY);
    const wikitext = wtData?.parse?.wikitext?.['*'] || '';
    const linkCount = (wikitext.match(/\[\[/g) || []).length;

    if (linkCount < MIN_CAST_LINKS) return null;
    return { wikiSlug: slug, pageTitle, wikitext, linkCount };
  } catch {
    return null;
  }
}

// ─── Wikitext parser ──────────────────────────────────────────────────────────
// Adapted from build-show-database-v2.js with bug fixes applied

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

  // Pass 1: "voiced by" format
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

  // Pass 2: "as" format
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

  // Pass 3: Wikitable patterns
  const pattern1 = /\|\s*\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]\s*\n\s*\|\s*\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g;
  let match;
  while ((match = pattern1.exec(wikitext)) !== null) {
    addResult(match[1], match[3] || match[2], match[2]);
  }

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
    // Try pageimages API first
    const url = `https://${wikiSlug}.fandom.com/api.php?action=query&titles=${encodeURIComponent(fandomPageName)}&prop=pageimages&format=json&pithumbsize=400&redirects=1`;
    const data = await fetchJson(url);
    const pages = data?.query?.pages || {};
    const page = Object.values(pages)[0];
    if (page && page.missing === undefined && page.thumbnail?.source) {
      return page.thumbnail.source;
    }

    await sleep(REQUEST_DELAY);

    // Fallback: parse wikitext for [[File:...]]
    const wtUrl = `https://${wikiSlug}.fandom.com/api.php?action=parse&page=${encodeURIComponent(fandomPageName)}&prop=wikitext&section=0&format=json&redirects=1`;
    const wtData = await fetchJson(wtUrl);
    const wikitext = wtData?.parse?.wikitext?.['*'] || '';
    const fileMatch = wikitext.match(/\[\[File:([^\]|]+)/i);
    if (!fileMatch) return null;

    await sleep(REQUEST_DELAY);

    const fileName = fileMatch[1].trim().replace(/ /g, '_');
    const imgUrl = `https://${wikiSlug}.fandom.com/api.php?action=query&titles=File:${encodeURIComponent(fileName)}&prop=imageinfo&iiprop=url&format=json`;
    const imgData = await fetchJson(imgUrl);
    const imgPages = imgData?.query?.pages || {};
    const imgPage = Object.values(imgPages)[0];
    return imgPage?.imageinfo?.[0]?.url || null;
  } catch {
    return null;
  }
}

// Try character name with disambiguation suffixes
async function fetchImageWithFallbacks(wikiSlug, fandomPageName, characterName) {
  // Try exact name first
  let imageUrl = await fetchCharacterImageUrl(wikiSlug, fandomPageName);
  if (imageUrl) return imageUrl;

  await sleep(REQUEST_DELAY);

  // Try "{Name} (character)"
  const withSuffix = `${fandomPageName} (character)`;
  imageUrl = await fetchCharacterImageUrl(wikiSlug, withSuffix);
  if (imageUrl) return imageUrl;

  await sleep(REQUEST_DELAY);

  // Try first name only (if multi-word)
  const firstName = characterName.split(' ')[0];
  if (firstName !== characterName && firstName.length > 2) {
    imageUrl = await fetchCharacterImageUrl(wikiSlug, firstName);
    if (imageUrl) return imageUrl;
  }

  return null;
}

// ─── Download + resize ────────────────────────────────────────────────────────

async function downloadAndResize(imageUrl, destPath) {
  const buffer = await downloadToBuffer(imageUrl);
  if (buffer.length < 1024) throw new Error('Image too small (<1KB)');

  const resized = await sharp(buffer)
    .resize(IMAGE_WIDTH, null, { withoutEnlargement: true })
    .png()
    .toBuffer();

  fs.writeFileSync(destPath, resized);
}

// ─── Process one show ─────────────────────────────────────────────────────────

async function processShow(show, wikiSlug, showIndex, totalShows, dryRun) {
  const showSlug = slugify(show.title);
  const tag = `[${showIndex}/${totalShows}]`;

  process.stdout.write(`${tag} ${show.title}\n`);

  // Step 1: Find cast section on wiki
  process.stdout.write(`  wiki: finding cast section...`);
  const castResult = await findCastSection(wikiSlug, show.title);

  if (!castResult) {
    process.stdout.write(` not found\n`);
    return { imagesFound: 0, imagesFailed: 0, charsFromWiki: 0 };
  }
  process.stdout.write(`\r  wiki: ${castResult.linkCount} cast links found${' '.repeat(20)}\n`);

  // Step 2: Parse wikitext for character→actor mappings
  const fandomCast = parseCastFromWikitext(castResult.wikitext);
  process.stdout.write(`  cast: ${fandomCast.length} characters parsed from wikitext\n`);

  if (fandomCast.length === 0) {
    return { imagesFound: 0, imagesFailed: 0, charsFromWiki: 0 };
  }

  // Step 3: Match wiki characters to existing database characters
  const dbChars = show.characters || [];
  const dbCharMap = new Map(dbChars.map(c => [normalizeName(c.character_name), c]));

  // Update existing chars with fandom_page_name, add new ones from wiki
  for (const fc of fandomCast) {
    const key = normalizeName(fc.characterName);
    if (dbCharMap.has(key)) {
      // Existing char — add fandom page name for image lookup
      dbCharMap.get(key)._fandom_page_name = fc.fandomPageName;
    }
    // Don't add new characters from wiki — we trust TMDB for the character list
  }

  // Also try matching by actor name for characters with different names
  const dbActorMap = new Map(dbChars.map(c => [normalizeName(c.voice_actor), c]));
  for (const fc of fandomCast) {
    const actorKey = normalizeName(fc.actorName);
    const char = dbActorMap.get(actorKey);
    if (char && !char._fandom_page_name) {
      char._fandom_page_name = fc.fandomPageName;
    }
  }

  // Step 4: Fetch images for characters that have fandom page names
  const charsToFetch = dbChars.filter(c => c._fandom_page_name);
  let imagesFound = 0;
  let imagesFailed = 0;

  if (dryRun) {
    process.stdout.write(`  images: would fetch ${charsToFetch.length} images (dry run)\n`);
    // Clean up temp field
    for (const c of dbChars) delete c._fandom_page_name;
    return { imagesFound: 0, imagesFailed: 0, charsFromWiki: fandomCast.length };
  }

  const showImagesDir = path.join(IMAGES_DIR, showSlug);
  ensureDir(showImagesDir);

  for (let i = 0; i < charsToFetch.length; i++) {
    const char = charsToFetch[i];
    const charSlug = slugify(char.character_name);

    process.stdout.write(`  [${i + 1}/${charsToFetch.length}] ${char.character_name}...`);

    try {
      const imageUrl = await fetchImageWithFallbacks(
        wikiSlug, char._fandom_page_name, char.character_name
      );

      if (!imageUrl) {
        process.stdout.write(` no image found\n`);
        imagesFailed++;
        await sleep(IMAGE_DL_DELAY);
        continue;
      }

      const destPath = path.join(showImagesDir, `${charSlug}.png`);
      const relPath = `data/images/${showSlug}/${charSlug}.png`;

      await downloadAndResize(imageUrl, destPath);

      char.character_image = relPath;
      char.character_image_placeholder = false;

      process.stdout.write(` done\n`);
      imagesFound++;
    } catch (err) {
      process.stdout.write(` failed: ${err.message}\n`);
      imagesFailed++;
    }

    await sleep(IMAGE_DL_DELAY);
  }

  // Clean up temp field
  for (const c of dbChars) delete c._fandom_page_name;

  return { imagesFound, imagesFailed, charsFromWiki: fandomCast.length };
}

// ─── Progress tracking ───────────────────────────────────────────────────────

function loadProgress() {
  try {
    return JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf8'));
  } catch {
    return { completed_shows: [], stats: { total_images: 0, total_failed: 0, shows_processed: 0 } };
  }
}

function saveProgress(progress) {
  fs.writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2), 'utf8');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const batchNum = args.includes('--batch') ? parseInt(args[args.indexOf('--batch') + 1]) : null;
  const showFilter = args.includes('--show') ? args[args.indexOf('--show') + 1] : null;
  const resume = args.includes('--resume');
  const dryRun = args.includes('--dry-run');

  if (!batchNum && !showFilter) {
    console.error('\nUsage:');
    console.error('  node scripts/pipeline/fetch-images.js --batch 1');
    console.error('  node scripts/pipeline/fetch-images.js --show "Shrek"');
    console.error('  node scripts/pipeline/fetch-images.js --batch 1 --resume');
    console.error('  node scripts/pipeline/fetch-images.js --batch 1 --dry-run\n');
    process.exit(1);
  }

  // Load data
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));

  if (!fs.existsSync(MAPPINGS_PATH)) {
    console.error('\n  wiki-mappings.json not found. Run discover-wikis.js first.\n');
    process.exit(1);
  }
  const mappingsData = JSON.parse(fs.readFileSync(MAPPINGS_PATH, 'utf8'));
  const wikiMap = new Map(mappingsData.mappings.map(m => [m.tmdb_id, m]));

  const progress = loadProgress();
  const completedSet = new Set(progress.completed_shows);

  // Select shows
  let shows;
  if (showFilter) {
    shows = db.shows.filter(s => s.title.toLowerCase() === showFilter.toLowerCase());
    if (shows.length === 0) {
      console.error(`\n  Show not found: "${showFilter}"\n`);
      process.exit(1);
    }
  } else {
    const start = (batchNum - 1) * BATCH_SIZE;
    const end = start + BATCH_SIZE;
    shows = db.shows.slice(start, end);
  }

  // Filter for shows that have wiki mappings
  const showsWithWiki = shows.filter(s => {
    const m = wikiMap.get(s.tmdb_id);
    return m && m.wiki_slug;
  });

  const showsWithoutWiki = shows.length - showsWithWiki.length;

  // Skip completed if resuming
  let toProcess = showsWithWiki;
  if (resume && !showFilter) {
    toProcess = showsWithWiki.filter(s => !completedSet.has(s.tmdb_id));
  }

  const batchLabel = showFilter ? `"${showFilter}"` : `Batch ${batchNum}`;
  console.log(`\n  VoiceCast Image Fetcher — ${batchLabel}`);
  console.log(`  Shows to process: ${toProcess.length} (${showsWithoutWiki} skipped — no wiki)`);
  if (dryRun) console.log('  DRY RUN — no downloads');
  console.log();

  ensureDir(IMAGES_DIR);

  let totalImages = 0;
  let totalFailed = 0;
  let totalWikiChars = 0;
  const startTime = Date.now();

  for (let i = 0; i < toProcess.length; i++) {
    const show = toProcess[i];
    const mapping = wikiMap.get(show.tmdb_id);

    const result = await processShow(show, mapping.wiki_slug, i + 1, toProcess.length, dryRun);
    totalImages += result.imagesFound;
    totalFailed += result.imagesFailed;
    totalWikiChars += result.charsFromWiki;

    // Mark completed and save progress
    if (!dryRun) {
      completedSet.add(show.tmdb_id);
      progress.completed_shows = [...completedSet];
      progress.stats.total_images += result.imagesFound;
      progress.stats.total_failed += result.imagesFailed;
      progress.stats.shows_processed++;
      saveProgress(progress);

      // Save database after every show
      db.updated_at = new Date().toISOString();
      const tmp = DB_PATH + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
      fs.renameSync(tmp, DB_PATH);
    }

    // ETA
    const elapsed = (Date.now() - startTime) / 1000;
    const perShow = elapsed / (i + 1);
    const remaining = Math.round(perShow * (toProcess.length - i - 1));
    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    console.log(`  --- ${i + 1}/${toProcess.length} done | ${totalImages} images | ETA: ${mins}m ${secs}s ---\n`);
  }

  // Final summary
  const totalElapsed = Math.round((Date.now() - startTime) / 1000);
  const totalMins = Math.floor(totalElapsed / 60);
  const totalSecs = totalElapsed % 60;

  console.log('  ┌─────────────────────────────────────┐');
  console.log(`  │     ${batchLabel.padEnd(15)} Complete        │`);
  console.log('  ├─────────────────────────────────────┤');
  console.log(`  │  Shows processed:   ${String(toProcess.length).padStart(13)} │`);
  console.log(`  │  Wiki chars parsed: ${String(totalWikiChars).padStart(13)} │`);
  console.log(`  │  Images downloaded: ${String(totalImages).padStart(13)} │`);
  console.log(`  │  Images failed:     ${String(totalFailed).padStart(13)} │`);
  console.log(`  │  No wiki (skipped): ${String(showsWithoutWiki).padStart(13)} │`);
  console.log(`  │  Time:              ${String(`${totalMins}m ${totalSecs}s`).padStart(13)} │`);
  console.log('  └─────────────────────────────────────┘\n');
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n  Interrupted. Progress saved — use --resume to continue.\n');
  process.exit(0);
});

main().catch(err => {
  console.error(`\n  Fatal: ${err.message}\n`);
  process.exit(1);
});
