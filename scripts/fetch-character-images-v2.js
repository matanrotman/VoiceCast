/**
 * fetch-character-images-v2.js
 *
 * For each show in data/database.json:
 * 1. Finds the show's Fandom wiki page
 * 2. Locates the Voice Cast / Cast section
 * 3. Parses actor -> character mappings from the wikitext table
 * 4. Matches actors to our database by name
 * 5. Fetches character images using the exact Fandom page name
 * 6. Downloads images to data/images/[show-slug]/[character-slug].ext
 * 7. Updates database.json with GitHub raw URLs
 *
 * Usage:
 *   node scripts/fetch-character-images-v2.js
 *   node scripts/fetch-character-images-v2.js --show "Frozen"
 *
 * Safe to re-run — skips characters that already have a character_image.
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
const DELAY_BETWEEN_REQUESTS_MS = 2000;
const DELAY_BETWEEN_SHOWS_MS = 3000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 5000;

// Section titles to look for (case-insensitive)
const CAST_SECTION_KEYWORDS = ['voice cast', 'cast', 'voices', 'voice actors'];

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

/**
 * Download a file from URL to disk.
 * Pure stream — never reads file contents.
 */
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
        const redirectUrl = response.headers.location;
        if (!redirectUrl) return reject(new Error('Redirect with no location'));
        return downloadImage(redirectUrl, destPath).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) {
        return reject(new Error(`HTTP ${response.statusCode}`));
      }
      const contentType = response.headers['content-type'] || '';
      if (!contentType.includes('image')) {
        return reject(new Error(`Not an image: ${contentType}`));
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

/**
 * Fetch JSON from a Fandom API URL with retry logic.
 */
async function fandomFetch(url) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'VoiceCast/1.0 (https://github.com/matanrotman/VoiceCast)'
        },
        signal: AbortSignal.timeout(10000)
      });
      if (response.status === 429) {
        process.stdout.write('\n  ⏳ Rate limited — waiting 30s...\n');
        await sleep(30000);
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err;
      await sleep(RETRY_DELAY_MS);
    }
  }
}

/**
 * Guess the Fandom wiki slug for a show title.
 */
function guessWikiSlug(title) {
  return slugify(title)
    .replace(/-the-animated-series$/, '')
    .replace(/-series$/, '')
    .replace(/-movie$/, '')
    .split('-')
    .slice(0, 4)
    .join('-');
}

/**
 * Guess the Fandom page title for a show.
 * Usually matches the show title exactly.
 */
function guessPageTitle(title) {
  return title.replace(/ /g, '_');
}

/**
 * Find the index of the cast section on a Fandom page.
 * Returns the section index or null.
 */
async function findCastSectionIndex(wikiSlug, pageTitle) {
  const url = `https://${wikiSlug}.fandom.com/api.php?action=parse&page=${encodeURIComponent(pageTitle)}&prop=sections&format=json`;
  try {
    const data = await fandomFetch(url);
    const sections = data?.parse?.sections || [];
    for (const section of sections) {
      if (CAST_SECTION_KEYWORDS.some(k => section.line.toLowerCase().includes(k))) {
        return section.index;
      }
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Parse actor -> character mappings from wikitext.
 * Returns array of { actorName, characterName, fandomPageName }
 */
function parseCastFromWikitext(wikitext) {
  const results = [];

  // Match rows like: | [[Actor Name]] | [[Character Page|Character Name]] |
  // Also handles: | [[Actor Name]] | [[Character Name]] |
  const rowPattern = /\|\s*\[\[([^\]|]+)(?:\|[^\]]*)?\]\]\s*\n\s*\|\s*\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

  let match;
  while ((match = rowPattern.exec(wikitext)) !== null) {
    const actorName = match[1].trim();
    const fandomPageName = match[2].trim(); // e.g. "Kristoff Bjorgman"
    const displayName = match[3]?.trim() || fandomPageName; // e.g. "Kristoff"

    if (actorName && fandomPageName) {
      results.push({ actorName, characterName: displayName, fandomPageName });
    }
  }

  // Also try simpler pattern for plain text character names
  const simplePattern = /\|\s*\[\[([^\]|]+)\]\]\s*\n\s*\|\s*([^\n\[|{]+)/g;
  while ((match = simplePattern.exec(wikitext)) !== null) {
    const actorName = match[1].trim();
    const characterName = match[2].trim().replace(/^['*]+|['*]+$/g, '');
    if (actorName && characterName && characterName.length < 60) {
      // Only add if not already found
      if (!results.find(r => r.actorName === actorName)) {
        results.push({ actorName, characterName, fandomPageName: characterName });
      }
    }
  }

  return results;
}

/**
 * Fetch the image URL for a character's Fandom page.
 */
async function fetchCharacterImageUrl(wikiSlug, fandomPageName) {
  const url = `https://${wikiSlug}.fandom.com/api.php?action=query&titles=${encodeURIComponent(fandomPageName)}&prop=pageimages&format=json&pithumbsize=400&redirects=1`;
  try {
    const data = await fandomFetch(url);
    const pages = data?.query?.pages || {};
    const page = Object.values(pages)[0];
    if (!page || page.missing !== undefined) return null;
    if (page.thumbnail?.source) return page.thumbnail.source;

    // Fall back to wikitext parsing
    const wikitextUrl = `https://${wikiSlug}.fandom.com/api.php?action=parse&page=${encodeURIComponent(fandomPageName)}&prop=wikitext&section=0&format=json&redirects=1`;
    const wtData = await fandomFetch(wikitextUrl);
    const wikitext = wtData?.parse?.wikitext?.['*'] || '';
    const fileMatch = wikitext.match(/\[\[File:([^\]|]+)/i);
    if (!fileMatch) return null;

    const fileName = fileMatch[1].trim().replace(/ /g, '_');
    const imageInfoUrl = `https://${wikiSlug}.fandom.com/api.php?action=query&titles=File:${encodeURIComponent(fileName)}&prop=imageinfo&iiprop=url&format=json`;
    const imgData = await fandomFetch(imageInfoUrl);
    const imgPages = imgData?.query?.pages || {};
    const imgPage = Object.values(imgPages)[0];
    return imgPage?.imageinfo?.[0]?.url || null;
  } catch {
    return null;
  }
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
  const args = process.argv.slice(2);
  const showFilter = args.includes('--show')
    ? args[args.indexOf('--show') + 1]?.toLowerCase()
    : null;

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

  console.log(`\n🎨 Character image fetcher v2`);
  console.log(`📺 Processing ${shows.length} show(s)\n`);

  let totalFound = 0;
  let totalMissed = 0;
  let totalSkipped = 0;
  const failedShows = [];

  for (let si = 0; si < shows.length; si++) {
    const show = shows[si];
    const wikiSlug = guessWikiSlug(show.title);
    const pageTitle = guessPageTitle(show.matched_title || show.title);
    const showSlug = slugify(show.title);
    const showImagesDir = path.join(IMAGES_DIR, showSlug);

    printProgress(si, shows.length, show.title);

    // Count characters that still need images
    const needsImage = (show.characters || []).filter(c => !c.character_image);
    if (needsImage.length === 0) {
      totalSkipped += (show.characters || []).length;
      continue;
    }

    // Step 1: Find cast section
    process.stdout.write(`\n  📖 ${show.title} — finding cast section on ${wikiSlug}.fandom.com`);
    const sectionIndex = await findCastSectionIndex(wikiSlug, pageTitle);
    await sleep(DELAY_BETWEEN_REQUESTS_MS);

    if (!sectionIndex) {
      process.stdout.write(` — ❌ no cast section found`);
      failedShows.push(show.title);
      totalMissed += needsImage.length;
      await sleep(DELAY_BETWEEN_SHOWS_MS);
      continue;
    }

    // Step 2: Fetch cast section wikitext
    const wikitextUrl = `https://${wikiSlug}.fandom.com/api.php?action=parse&page=${encodeURIComponent(pageTitle)}&prop=wikitext&section=${sectionIndex}&format=json`;
    let wikitext = '';
    try {
      const data = await fandomFetch(wikitextUrl);
      wikitext = data?.parse?.wikitext?.['*'] || '';
    } catch {
      process.stdout.write(` — ❌ could not fetch wikitext`);
      failedShows.push(show.title);
      totalMissed += needsImage.length;
      await sleep(DELAY_BETWEEN_SHOWS_MS);
      continue;
    }
    await sleep(DELAY_BETWEEN_REQUESTS_MS);

    // Step 3: Parse actor -> character mappings
    const castMappings = parseCastFromWikitext(wikitext);
    process.stdout.write(` — found ${castMappings.length} cast entries`);

    if (castMappings.length === 0) {
      failedShows.push(show.title);
      totalMissed += needsImage.length;
      await sleep(DELAY_BETWEEN_SHOWS_MS);
      continue;
    }

    // Step 4: Match our database characters to Fandom mappings by actor name
    let showFound = 0;
    let showMissed = 0;

    for (const character of needsImage) {
      const mapping = castMappings.find(m =>
        m.actorName.toLowerCase() === (character.voice_actor || '').toLowerCase()
      );

      if (!mapping) {
        process.stdout.write(`\n    ⚠️  No Fandom mapping for: ${character.character_name} (${character.voice_actor})`);
        showMissed++;
        totalMissed++;
        continue;
      }

      process.stdout.write(`\n    🔍 ${character.character_name} → ${mapping.fandomPageName}`);
      await sleep(DELAY_BETWEEN_REQUESTS_MS);

      try {
        const imageUrl = await fetchCharacterImageUrl(wikiSlug, mapping.fandomPageName);

        if (!imageUrl) {
          process.stdout.write(` — ❌ no image`);
          showMissed++;
          totalMissed++;
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

        process.stdout.write(` — ✅`);
        showFound++;
        totalFound++;

      } catch (err) {
        process.stdout.write(` — ❌ ${err.message}`);
        showMissed++;
        totalMissed++;
      }
    }

    if (showFound === 0 && needsImage.length > 0) {
      failedShows.push(show.title);
    }

    saveDatabase(db);
    await sleep(DELAY_BETWEEN_SHOWS_MS);
  }

  printProgress(shows.length, shows.length, 'Complete');
  console.log('\n');
  console.log('─'.repeat(60));
  console.log('📊 Summary');
  console.log('─'.repeat(60));
  console.log(`  Images found:    ${totalFound}`);
  console.log(`  Images missing:  ${totalMissed}`);
  console.log(`  Already had one: ${totalSkipped}`);
  console.log('─'.repeat(60));

  if (failedShows.length > 0) {
    console.log(`\n⚠️  No images found for ${failedShows.length} show(s):`);
    failedShows.slice(0, 20).forEach(t => console.log(`  - ${t}`));
    if (failedShows.length > 20) console.log(`  ... and ${failedShows.length - 20} more`);
  } else {
    console.log('\n✅ All shows had at least one character image found.');
  }

  console.log('\n📁 Images saved to: data/images/');
  console.log('📄 Credits updated: data/CREDITS.md\n');
}

main().catch(err => {
  console.error(`\n❌ Fatal error: ${err.message}\n`);
  process.exit(1);
});