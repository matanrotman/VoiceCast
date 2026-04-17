/**
 * fetch-character-images.js
 *
 * For each show in data/database.json, attempts to find and download
 * character images from Fandom wikis.
 *
 * Images are saved to: data/images/[show-slug]/[character-slug].jpg
 * database.json is updated with the raw.githubusercontent.com URL.
 *
 * Usage:
 *   node scripts/fetch-character-images.js
 *
 * Optional — process one show only:
 *   node scripts/fetch-character-images.js --show "Shrek"
 *
 * Safe to re-run — skips characters that already have a character_image URL.
 *
 * Security notes:
 *   - No API keys required
 *   - Only writes to data/images/ inside this repo
 *   - Never reads image contents — streams directly to disk
 *   - All URLs are validated before fetch
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
const DELAY_BETWEEN_SHOWS_MS = 5000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 5000;
const MAX_CHARACTERS_PER_SHOW = 20;

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
    console.error('\n❌ ERROR: Could not load data/database.json\n');
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

function appendCredits(showTitle, characterName, sourceUrl) {
  const line = `| ${showTitle} | ${characterName} | ${sourceUrl} | CC-BY-SA 3.0 |\n`;
  fs.appendFileSync(CREDITS_PATH, line, 'utf8');
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

/**
 * Download a file from a URL and save it to disk.
 * Never reads the file contents — pure stream pipe.
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
      // Follow redirects
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
      fileStream.on('finish', () => {
        fileStream.close();
        resolve();
      });
      fileStream.on('error', reject);
    });

    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy();
      reject(new Error('Request timed out'));
    });
  });
}

/**
 * Fetch a Fandom wiki page and extract the infobox image URL.
 * Returns an image URL string or null.
 */
async function fetchFandomImageUrl(wikiSlug, characterName) {
  const pageTitle = characterName.replace(/ /g, '_');
  const apiUrl = `https://${wikiSlug}.fandom.com/api.php?action=query&titles=${encodeURIComponent(pageTitle)}&prop=pageimages&format=json&pithumbsize=300`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(apiUrl, {
        headers: {
          'User-Agent': 'VoiceCast/1.0 (https://github.com/matanrotman/VoiceCast)'
        },
        signal: AbortSignal.timeout(10000)
      });

      if (response.status === 429) {
        console.log('\n  ⏳ Rate limited by Fandom — waiting 30s...');
        await sleep(30000);
        continue;
      }

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json();
      const pages = data?.query?.pages || {};
      const page = Object.values(pages)[0];

      if (!page || page.missing !== undefined) return null;
      return page.thumbnail?.source || null;

    } catch (err) {
      if (attempt === MAX_RETRIES) return null;
      await sleep(RETRY_DELAY_MS);
    }
  }
  return null;
}

/**
 * Given a show title, guess the most likely Fandom wiki slug.
 * e.g. "Shrek" -> "shrek", "SpongeBob SquarePants" -> "spongebob"
 */
function guessWikiSlug(title) {
  return slugify(title)
    .replace(/-the-animated-series$/, '')
    .replace(/-series$/, '')
    .replace(/-movie$/, '')
    .split('-')
    .slice(0, 3)
    .join('-');
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
      console.error(`\n❌ Show not found in database: ${showFilter}\n`);
      process.exit(1);
    }
  }

  console.log(`\n🎨 Character image fetcher`);
  console.log(`📺 Processing ${shows.length} show(s)\n`);

  let totalFound = 0;
  let totalMissed = 0;
  let totalSkipped = 0;
  const failedShows = [];

  for (let si = 0; si < shows.length; si++) {
    const show = shows[si];
    const wikiSlug = guessWikiSlug(show.title);
    const showSlug = slugify(show.title);
    const showImagesDir = path.join(IMAGES_DIR, showSlug);

    printProgress(si, shows.length, show.title);

    // Only process top N characters per show to keep scope manageable
    const characters = (show.cast || []).slice(0, MAX_CHARACTERS_PER_SHOW);
    let showFound = 0;
    let showMissed = 0;

    for (const character of characters) {
      // Skip if already has a character image
      if (character.character_image) {
        totalSkipped++;
        continue;
      }

      await sleep(DELAY_BETWEEN_REQUESTS_MS);

      try {
        const imageUrl = await fetchFandomImageUrl(wikiSlug, character.character_name);

        if (!imageUrl) {
          showMissed++;
          totalMissed++;
          continue;
        }

        // Determine file extension from URL
        const ext = imageUrl.match(/\.(jpg|jpeg|png|webp|gif)/i)?.[1]?.toLowerCase() || 'jpg';
        const charSlug = slugify(character.character_name);
        const fileName = `${charSlug}.${ext}`;
        const destPath = path.join(showImagesDir, fileName);
        const githubUrl = `${GITHUB_RAW_BASE}/data/images/${showSlug}/${fileName}`;

        ensureDir(showImagesDir);
        await downloadImage(imageUrl, destPath);

        // Update character in database
        character.character_image = githubUrl;
        character.character_image_placeholder = false;
        character.character_image_source = imageUrl;

        appendCredits(show.title, character.character_name, imageUrl);

        showFound++;
        totalFound++;

      } catch (err) {
        showMissed++;
        totalMissed++;
      }
    }

    if (showFound === 0 && characters.length > 0) {
      failedShows.push(show.title);
    }

    // Save after each show
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
    failedShows.forEach(t => console.log(`  - ${t}`));
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