#!/usr/bin/env node
'use strict';

/**
 * cleanup-database.js
 *
 * Resets data/database.json to a clean state for reprocessing:
 * - Backs up to data/backups/
 * - Caps characters at 50 per show (TMDB billing order)
 * - Removes junk characters (Self, uncredited, etc.)
 * - Resets all character_image fields to "" and character_image_placeholder to true
 * - Deletes data/images/ contents and checkpoint DB
 *
 * Usage:
 *   node scripts/pipeline/cleanup-database.js
 *   node scripts/pipeline/cleanup-database.js --dry-run
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const DB_PATH = path.join(ROOT, 'data/database.json');
const BACKUPS_DIR = path.join(ROOT, 'data/backups');
const IMAGES_DIR = path.join(ROOT, 'data/images');
const CHECKPOINT_PATH = path.join(ROOT, 'data/build-checkpoint.db');
const CHECKPOINT_WAL = CHECKPOINT_PATH + '-wal';
const CHECKPOINT_SHM = CHECKPOINT_PATH + '-shm';

const MAX_CHARACTERS = 50;

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

function shouldSkip(name) {
  const trimmed = (name || '').trim();
  return !trimmed || SKIP_PATTERNS.some(p => p.test(trimmed));
}

function main() {
  const dryRun = process.argv.includes('--dry-run');

  if (dryRun) console.log('\n  DRY RUN — no changes will be written\n');

  // Load database
  console.log('  Loading database...');
  const raw = fs.readFileSync(DB_PATH, 'utf8');
  const db = JSON.parse(raw);
  const shows = db.shows;
  console.log(`  Loaded ${shows.length} shows\n`);

  // Backup
  if (!dryRun) {
    if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(BACKUPS_DIR, `database-pre-rebuild-${ts}.json`);
    fs.writeFileSync(backupPath, raw, 'utf8');
    console.log(`  Backup saved: ${path.relative(ROOT, backupPath)}\n`);
  }

  // Process shows
  let totalCharsBefore = 0;
  let totalCharsAfter = 0;
  let totalSkipped = 0;
  let totalCapped = 0;
  let totalImagesReset = 0;
  let showsFlagged = [];

  for (let i = 0; i < shows.length; i++) {
    const show = shows[i];
    const chars = show.characters || [];
    const before = chars.length;
    totalCharsBefore += before;

    // Progress
    if ((i + 1) % 50 === 0 || i === shows.length - 1) {
      process.stdout.write(`\r  [${i + 1}/${shows.length}] Processing shows...`);
    }

    // Flag suspicious shows (>100 chars usually means wrong TMDB match)
    if (before > 100) {
      showsFlagged.push({ title: show.title, count: before });
    }

    // Remove junk characters
    const filtered = chars.filter(c => !shouldSkip(c.character_name));
    totalSkipped += before - filtered.length;

    // Cap at MAX_CHARACTERS
    const capped = filtered.slice(0, MAX_CHARACTERS);
    if (filtered.length > MAX_CHARACTERS) totalCapped++;

    // Reset image fields, normalize schema
    for (const c of capped) {
      if (c.character_image && c.character_image !== '') totalImagesReset++;
      c.character_image = '';
      c.character_image_placeholder = true;
      // Remove non-schema fields
      delete c.character_image_source;
      delete c.fandom_page_name;
    }

    show.characters = capped;
    totalCharsAfter += capped.length;
  }

  process.stdout.write('\r' + ' '.repeat(60) + '\r');

  // Update timestamp
  db.updated_at = new Date().toISOString();

  // Write database
  if (!dryRun) {
    const tmp = DB_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
    fs.renameSync(tmp, DB_PATH);
    console.log('  Database updated\n');
  }

  // Delete images directory contents
  if (!dryRun && fs.existsSync(IMAGES_DIR)) {
    const folders = fs.readdirSync(IMAGES_DIR).filter(f =>
      fs.statSync(path.join(IMAGES_DIR, f)).isDirectory()
    );
    let deleted = 0;
    for (const folder of folders) {
      fs.rmSync(path.join(IMAGES_DIR, folder), { recursive: true });
      deleted++;
    }
    console.log(`  Deleted ${deleted} image folders\n`);
  }

  // Delete checkpoint
  if (!dryRun) {
    for (const f of [CHECKPOINT_PATH, CHECKPOINT_WAL, CHECKPOINT_SHM]) {
      if (fs.existsSync(f)) { fs.unlinkSync(f); }
    }
    console.log('  Checkpoint cleared\n');
  }

  // Summary
  console.log('  ┌─────────────────────────────────────┐');
  console.log('  │           Cleanup Summary            │');
  console.log('  ├─────────────────────────────────────┤');
  console.log(`  │  Shows:              ${String(shows.length).padStart(13)} │`);
  console.log(`  │  Chars before:       ${String(totalCharsBefore).padStart(13)} │`);
  console.log(`  │  Chars after:        ${String(totalCharsAfter).padStart(13)} │`);
  console.log(`  │  Junk removed:       ${String(totalSkipped).padStart(13)} │`);
  console.log(`  │  Shows capped (>50): ${String(totalCapped).padStart(13)} │`);
  console.log(`  │  Images reset:       ${String(totalImagesReset).padStart(13)} │`);
  console.log('  └─────────────────────────────────────┘');

  if (showsFlagged.length > 0) {
    console.log(`\n  Flagged shows (>100 chars, likely wrong TMDB match):`);
    showsFlagged.forEach(s => console.log(`    - ${s.title} (${s.count} chars)`));
  }

  console.log('\n  Done.\n');
}

main();
