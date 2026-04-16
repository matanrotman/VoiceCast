#!/usr/bin/env node
/**
 * VoiceCast scraper
 *
 * Adds a new animated show to data/database.json by:
 * 1. Querying TMDB for cast data
 * 2. Scraping character images from Fandom via MediaWiki API
 * 3. Downloading + resizing images to data/images/{show-slug}/
 * 4. Updating data/database.json and data/CREDITS.md
 *
 * Usage:
 *   node scripts/scraper.js --title "Shrek" --tmdb-id 808 --type movie
 *   node scripts/scraper.js --title "The Simpsons" --tmdb-id 456 --type tv
 *
 * Requires: TMDB_API_KEY env var
 * Optional: FANDOM_WIKI env var (e.g. "simpsons" for simpsons.fandom.com)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import https from 'https';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      parsed[key] = args[i + 1] || true;
      i++;
    }
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Slug helpers
// ---------------------------------------------------------------------------

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}

// ---------------------------------------------------------------------------
// TMDB
// ---------------------------------------------------------------------------

const TMDB_BASE = 'https://api.themoviedb.org/3';
const ANIMATION_GENRE_ID = 16;

async function tmdbGet(path) {
  const key = process.env.TMDB_API_KEY;
  if (!key) throw new Error('TMDB_API_KEY env var is required');
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${TMDB_BASE}${path}${sep}api_key=${key}&language=en-US`);
  if (!res.ok) throw new Error(`TMDB HTTP ${res.status} for ${path}`);
  return res.json();
}

async function fetchTmdbCast(tmdbId, type) {
  // Confirm it's animated
  const details = await tmdbGet(`/${type}/${tmdbId}`);
  const genres = details.genre_ids || (details.genres || []).map((g) => g.id);
  if (!genres.includes(ANIMATION_GENRE_ID)) {
    throw new Error(`TMDB ID ${tmdbId} (${type}) is not animation genre — aborting`);
  }

  const title = type === 'movie'
    ? details.title || details.original_title
    : details.name || details.original_name;

  // Fetch credits
  const creditsPath = type === 'tv'
    ? `/${type}/${tmdbId}/aggregate_credits`
    : `/${type}/${tmdbId}/credits`;
  const credits = await tmdbGet(creditsPath);

  const cast = (credits.cast || [])
    .filter((person) => {
      if (type === 'movie') return /\(voice\)/i.test(person.character || '');
      return true;
    })
    .slice(0, 20)
    .map((person) => {
      const rawChar = type === 'tv'
        ? (person.roles?.[0]?.character || person.character || '')
        : (person.character || '');
      const characterName = rawChar.replace(/\s*\(voice\)/gi, '').trim();
      const photoPath = person.profile_path;
      return {
        character_name: characterName,
        voice_actor: person.name || '',
        voice_actor_tmdb_id: person.id,
        voice_actor_photo: photoPath
          ? `https://image.tmdb.org/t/p/w200${photoPath}`
          : '',
      };
    })
    .filter((c) => c.character_name && c.voice_actor);

  return { title, cast };
}

// ---------------------------------------------------------------------------
// Fandom MediaWiki API — character image lookup
// ---------------------------------------------------------------------------

async function getFandomImageUrl(wikiSlug, characterName) {
  // Try to find the character's page image via MediaWiki API
  const baseUrl = `https://${wikiSlug}.fandom.com/api.php`;
  const params = new URLSearchParams({
    action: 'query',
    titles: characterName,
    prop: 'pageimages',
    pithumbsize: 400,
    format: 'json',
    origin: '*',
  });

  try {
    const res = await fetch(`${baseUrl}?${params}`);
    if (!res.ok) return null;
    const data = await res.json();
    const pages = data?.query?.pages || {};
    const page = Object.values(pages)[0];
    if (!page || page.missing !== undefined) return null;
    return page.thumbnail?.source || null;
  } catch {
    return null;
  }
}

async function getFandomImageUrlFallbacks(wikiSlug, characterName) {
  // Try the character name directly, then common variants
  const variants = [
    characterName,
    characterName.split(' ')[0], // first name only
    characterName.replace(/\s+/g, '_'),
  ];

  for (const variant of variants) {
    const url = await getFandomImageUrl(wikiSlug, variant);
    if (url) return url;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Image download + resize
// ---------------------------------------------------------------------------

async function downloadAndResize(imageUrl, destPath) {
  // Ensure directory exists
  mkdirSync(dirname(destPath), { recursive: true });

  // Import sharp (optional dependency — only needed in scraper)
  let sharp;
  try {
    sharp = (await import('sharp')).default;
  } catch {
    throw new Error('sharp package is required for image processing: npm install sharp');
  }

  // Download to buffer
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`Image download failed: HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());

  // Resize to 200px wide, maintain aspect ratio, save as PNG
  await sharp(buffer)
    .resize(200, null, { withoutEnlargement: true })
    .png({ quality: 90 })
    .toFile(destPath);

  return destPath;
}

// ---------------------------------------------------------------------------
// Database read/write
// ---------------------------------------------------------------------------

function readDatabase() {
  const path = join(ROOT, 'data', 'database.json');
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw);
}

function writeDatabase(db) {
  const path = join(ROOT, 'data', 'database.json');
  db.updated_at = new Date().toISOString();
  writeFileSync(path, JSON.stringify(db, null, 2) + '\n', 'utf8');
}

function appendCredit(characterName, showSlug, charSlug, sourceUrl) {
  const path = join(ROOT, 'data', 'CREDITS.md');
  const line = `| data/images/${showSlug}/${charSlug}.png | ${sourceUrl} | CC-BY-SA 3.0 | Fandom |\n`;
  const existing = readFileSync(path, 'utf8');
  if (!existing.includes(line.trim())) {
    // Insert before the closing license section
    const updated = existing.replace(
      '| (entries added by scraper) | | CC-BY-SA 3.0 | Fandom |',
      `| (entries added by scraper) | | CC-BY-SA 3.0 | Fandom |\n${line.trim()}`
    );
    writeFileSync(path, updated, 'utf8');
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs();

  if (!args.title || !args['tmdb-id'] || !args.type) {
    console.error('Usage: node scripts/scraper.js --title "Shrek" --tmdb-id 808 --type movie');
    process.exit(1);
  }

  const tmdbId = parseInt(args['tmdb-id'], 10);
  const type = args.type; // "movie" or "tv"
  const wikiSlug = args['fandom-wiki'] || slugify(args.title); // e.g. "shrek"

  console.log(`\nScraping: ${args.title} (TMDB ${type} #${tmdbId})`);
  console.log(`Fandom wiki: ${wikiSlug}.fandom.com\n`);

  // 1. Fetch TMDB cast
  console.log('Fetching TMDB cast data…');
  const { title, cast } = await fetchTmdbCast(tmdbId, type);
  console.log(`  Found ${cast.length} voice actors for "${title}"`);

  // 2. Check for duplicate in database
  const db = readDatabase();
  const existingIdx = db.shows.findIndex(
    (s) => s.tmdb_id === tmdbId && s.tmdb_type === type
  );
  if (existingIdx >= 0) {
    console.log(`  Show already exists in database at index ${existingIdx} — updating`);
    db.shows.splice(existingIdx, 1);
  }

  const showSlug = slugify(title);
  const characters = [];

  // 3. For each character, try to get Fandom image
  for (const person of cast) {
    const charSlug = slugify(person.character_name);
    const destPath = join(ROOT, 'data', 'images', showSlug, `${charSlug}.png`);
    const relPath = `data/images/${showSlug}/${charSlug}.png`;

    let imagePath = '';
    let placeholder = true;

    console.log(`  Processing character: ${person.character_name}`);

    // Skip if image already exists (idempotent re-runs)
    if (existsSync(destPath)) {
      console.log(`    Image already exists — reusing`);
      imagePath = relPath;
      placeholder = false;
    } else {
      // Try Fandom
      const fandomUrl = await getFandomImageUrlFallbacks(wikiSlug, person.character_name);
      if (fandomUrl) {
        try {
          await downloadAndResize(fandomUrl, destPath);
          appendCredit(person.character_name, showSlug, charSlug, fandomUrl);
          imagePath = relPath;
          placeholder = false;
          console.log(`    Downloaded image from Fandom`);
        } catch (err) {
          console.warn(`    Image download failed: ${err.message} — using placeholder`);
        }
      } else {
        console.warn(`    No Fandom image found — using placeholder`);
      }
    }

    characters.push({
      character_name: person.character_name,
      character_image: imagePath,
      character_image_placeholder: placeholder,
      voice_actor: person.voice_actor,
      voice_actor_tmdb_id: person.voice_actor_tmdb_id,
      voice_actor_photo: person.voice_actor_photo,
    });
  }

  // 4. Add to database
  const showEntry = {
    title,
    tmdb_id: tmdbId,
    tmdb_type: type,
    characters,
  };

  db.shows.push(showEntry);
  writeDatabase(db);

  const successCount = characters.filter((c) => !c.character_image_placeholder).length;
  console.log(`\nDone! Added "${title}" with ${characters.length} characters (${successCount} with images)`);
  console.log(`Database updated: data/database.json`);
}

main().catch((err) => {
  console.error('\nScraper failed:', err.message);
  process.exit(1);
});
