#!/usr/bin/env node
'use strict';

/**
 * discover-wikis.js
 *
 * Finds the correct Fandom wiki for each show in data/database.json.
 * Outputs a reviewable mapping file at data/wiki-mappings.json.
 *
 * Strategy:
 *   Tier 1: Slug guessing — try multiple URL patterns, validate with siteinfo + Category:Characters
 *   Tier 2: DuckDuckGo search — search "{title} fandom wiki", extract fandom.com URLs
 *   Tier 3: Manual — shows that couldn't be resolved are flagged in the output
 *
 * Usage:
 *   node scripts/pipeline/discover-wikis.js                 # all shows
 *   node scripts/pipeline/discover-wikis.js --limit 200     # first 200
 *   node scripts/pipeline/discover-wikis.js --offset 200 --limit 200
 *   node scripts/pipeline/discover-wikis.js --show "Frozen"
 *   node scripts/pipeline/discover-wikis.js --recheck-failed # retry nulls only
 *   node scripts/pipeline/discover-wikis.js --no-search      # skip DuckDuckGo tier
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const DB_PATH = path.join(ROOT, 'data/database.json');
const MAPPINGS_PATH = path.join(ROOT, 'data/wiki-mappings.json');

// Rate limiting
const SLUG_CHECK_DELAY = 1200;   // ms between siteinfo checks
const SEARCH_DELAY = 3000;       // ms between DuckDuckGo requests (be polite)
const CATEGORY_CHECK_DELAY = 1200;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function slugifyNoHyphens(str) {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function fetchJson(url, timeoutMs = 10000) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'VoiceCastBot/3.0 (https://github.com/matanrotman/VoiceCast)' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchText(url, timeoutMs = 10000) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'text/html',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// ─── Slug candidates ─────────────────────────────────────────────────────────

function generateSlugs(title) {
  const slugs = new Set();
  const clean = title
    .replace(/[:''""!?.,]/g, '')
    .replace(/&/g, 'and')
    .trim();

  // Full title, no hyphens: "gravityfalls"
  slugs.add(slugifyNoHyphens(clean));

  // Full title, hyphenated: "gravity-falls"
  slugs.add(slugify(clean));

  // Without "The" prefix: "lion-king" from "The Lion King"
  const noThe = clean.replace(/^the\s+/i, '');
  if (noThe !== clean) {
    slugs.add(slugifyNoHyphens(noThe));
    slugs.add(slugify(noThe));
  }

  // First word only: "gravity"
  const words = clean.split(/\s+/);
  if (words.length > 1) {
    slugs.add(words[0].toLowerCase().replace(/[^a-z0-9]/g, ''));
  }

  // First two words: "gravityfall" (no hyphens)
  if (words.length > 2) {
    slugs.add(slugifyNoHyphens(words.slice(0, 2).join(' ')));
    slugs.add(slugify(words.slice(0, 2).join(' ')));
  }

  // Before colon: "Avatar: The Last Airbender" → "avatar"
  if (title.includes(':')) {
    const beforeColon = title.split(':')[0].trim();
    slugs.add(slugifyNoHyphens(beforeColon));
    slugs.add(slugify(beforeColon));
  }

  // Strip common suffixes
  const suffixes = [
    /\s+the\s+animated\s+series$/i,
    /\s+the\s+movie$/i,
    /\s+movie$/i,
    /\s+the\s+series$/i,
    /\s+series$/i,
    /\s+season\s+\d+$/i,
    /\s+part\s+\d+$/i,
  ];
  let stripped = clean;
  for (const suf of suffixes) {
    stripped = stripped.replace(suf, '');
  }
  if (stripped !== clean) {
    slugs.add(slugifyNoHyphens(stripped));
    slugs.add(slugify(stripped));
  }

  // Remove empty/trivial
  slugs.delete('');
  slugs.delete('the');

  return [...slugs];
}

// ─── Tier 1: Slug guessing ───────────────────────────────────────────────────

async function checkWikiExists(slug) {
  try {
    const url = `https://${slug}.fandom.com/api.php?action=query&meta=siteinfo&siprop=general&format=json`;
    const data = await fetchJson(url);
    if (data?.query?.general?.sitename) {
      return { exists: true, name: data.query.general.sitename };
    }
    return { exists: false };
  } catch {
    return { exists: false };
  }
}

async function countCharacterCategory(slug) {
  try {
    const url = `https://${slug}.fandom.com/api.php?action=query&list=categorymembers&cmtitle=Category:Characters&cmlimit=10&format=json`;
    const data = await fetchJson(url);
    const members = data?.query?.categorymembers || [];
    return members.length;
  } catch {
    return 0;
  }
}

async function discoverWithSlugs(title, existingSlug) {
  const slugs = existingSlug ? [existingSlug, ...generateSlugs(title)] : generateSlugs(title);
  const uniqueSlugs = [...new Set(slugs)];
  let best = null;

  for (const slug of uniqueSlugs) {
    process.stdout.write(`  trying ${slug}...`);
    const result = await checkWikiExists(slug);
    await sleep(SLUG_CHECK_DELAY);

    if (!result.exists) {
      process.stdout.write(` 404\r  ${' '.repeat(50)}\r`);
      continue;
    }

    process.stdout.write(` found! Checking characters...`);
    const charCount = await countCharacterCategory(slug);
    await sleep(CATEGORY_CHECK_DELAY);

    process.stdout.write(`\r  ${' '.repeat(60)}\r`);

    const candidate = {
      wiki_slug: slug,
      wiki_name: result.name,
      character_category_count: charCount,
      discovery_method: existingSlug === slug ? 'existing' : 'slug_guess',
      confidence: charCount >= 5 ? 'high' : charCount > 0 ? 'medium' : 'low',
    };

    if (!best || candidate.character_category_count > best.character_category_count) {
      best = candidate;
    }

    // If we found a wiki with plenty of characters, no need to try more slugs
    if (charCount >= 10) break;
  }

  return best;
}

// ─── Tier 2: DuckDuckGo search ───────────────────────────────────────────────

async function discoverWithSearch(title) {
  try {
    const query = encodeURIComponent(`${title} fandom wiki`);
    const url = `https://html.duckduckgo.com/html/?q=${query}`;
    const html = await fetchText(url, 15000);

    // Extract fandom.com URLs from the HTML
    const fandomUrlPattern = /https?:\/\/([a-z0-9-]+)\.fandom\.com/gi;
    const matches = [...html.matchAll(fandomUrlPattern)];
    const slugs = [...new Set(matches.map(m => m[1].toLowerCase()))];

    // Filter out generic fandom pages
    const skip = new Set(['community', 'www', 'auth', 'services', 'soap', 'support']);
    const candidates = slugs.filter(s => !skip.has(s));

    if (candidates.length === 0) return null;

    // Try the top 3 candidates
    for (const slug of candidates.slice(0, 3)) {
      process.stdout.write(`  search found: ${slug}.fandom.com — checking...`);
      const result = await checkWikiExists(slug);
      if (!result.exists) {
        process.stdout.write(`\r  ${' '.repeat(60)}\r`);
        await sleep(SLUG_CHECK_DELAY);
        continue;
      }

      const charCount = await countCharacterCategory(slug);
      await sleep(CATEGORY_CHECK_DELAY);
      process.stdout.write(`\r  ${' '.repeat(60)}\r`);

      return {
        wiki_slug: slug,
        wiki_name: result.name,
        character_category_count: charCount,
        discovery_method: 'web_search',
        confidence: charCount >= 5 ? 'high' : charCount > 0 ? 'medium' : 'low',
      };
    }

    return null;
  } catch (err) {
    process.stdout.write(`\r  search error: ${err.message}${' '.repeat(20)}\r`);
    return null;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const limit = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1]) : null;
  const offset = args.includes('--offset') ? parseInt(args[args.indexOf('--offset') + 1]) : 0;
  const showFilter = args.includes('--show') ? args[args.indexOf('--show') + 1] : null;
  const recheckFailed = args.includes('--recheck-failed');
  const noSearch = args.includes('--no-search');

  // Load database
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));

  // Load existing mappings if they exist
  let mappings = [];
  if (fs.existsSync(MAPPINGS_PATH)) {
    const existing = JSON.parse(fs.readFileSync(MAPPINGS_PATH, 'utf8'));
    mappings = existing.mappings || [];
  }
  const mappingIndex = new Map(mappings.map(m => [m.tmdb_id, m]));

  // Select shows to process
  let shows = db.shows;
  if (showFilter) {
    shows = shows.filter(s => s.title.toLowerCase() === showFilter.toLowerCase());
    if (shows.length === 0) {
      console.error(`\n  Show not found: "${showFilter}"\n`);
      process.exit(1);
    }
  } else {
    shows = shows.slice(offset, limit ? offset + limit : undefined);
  }

  if (recheckFailed) {
    shows = shows.filter(s => {
      const m = mappingIndex.get(s.tmdb_id);
      return !m || !m.wiki_slug;
    });
  }

  console.log(`\n  VoiceCast Wiki Discovery`);
  console.log(`  Processing ${shows.length} shows${noSearch ? ' (slug guessing only)' : ''}\n`);

  let found = 0;
  let failed = 0;
  let skipped = 0;

  for (let i = 0; i < shows.length; i++) {
    const show = shows[i];
    const existing = mappingIndex.get(show.tmdb_id);

    // Skip if already have a high-confidence mapping (unless single-show mode)
    if (!showFilter && existing?.wiki_slug && existing.confidence === 'high' && !recheckFailed) {
      skipped++;
      continue;
    }

    const num = `[${i + 1}/${shows.length}]`;
    process.stdout.write(`${num} ${show.title}\n`);

    // Tier 1: Slug guessing
    let result = await discoverWithSlugs(show.title, show.fandom_wiki || null);

    // Tier 2: Web search (if enabled and Tier 1 failed)
    if (!result && !noSearch) {
      process.stdout.write(`  slug guessing failed, trying web search...\n`);
      await sleep(SEARCH_DELAY);
      result = await discoverWithSearch(show.title);
    }

    // Build mapping entry
    const entry = {
      title: show.title,
      tmdb_id: show.tmdb_id,
      tmdb_type: show.tmdb_type,
      wiki_slug: result?.wiki_slug || null,
      wiki_name: result?.wiki_name || null,
      discovery_method: result?.discovery_method || 'failed',
      confidence: result?.confidence || 'none',
      character_category_count: result?.character_category_count || 0,
      verified: false,
    };

    if (!result) {
      entry.candidates_tried = generateSlugs(show.title);
    }

    // Update or add to mappings
    mappingIndex.set(show.tmdb_id, entry);

    if (result) {
      found++;
      console.log(`  -> ${result.wiki_slug}.fandom.com (${result.confidence}, ${result.character_category_count} chars)`);
    } else {
      failed++;
      console.log(`  -> not found`);
    }

    // Save after every 10 shows (incremental saves)
    if ((i + 1) % 10 === 0) {
      saveMappings(mappingIndex);
    }

    // Progress summary every 50 shows
    if ((i + 1) % 50 === 0) {
      console.log(`\n  --- Progress: ${i + 1}/${shows.length} | Found: ${found} | Failed: ${failed} | Skipped: ${skipped} ---\n`);
    }
  }

  // Final save
  saveMappings(mappingIndex);

  // Summary
  const all = [...mappingIndex.values()];
  const totalFound = all.filter(m => m.wiki_slug).length;
  const totalFailed = all.filter(m => !m.wiki_slug).length;
  const highConf = all.filter(m => m.confidence === 'high').length;
  const medConf = all.filter(m => m.confidence === 'medium').length;
  const lowConf = all.filter(m => m.confidence === 'low').length;

  console.log('\n  ┌─────────────────────────────────────┐');
  console.log('  │       Wiki Discovery Summary         │');
  console.log('  ├─────────────────────────────────────┤');
  console.log(`  │  Total shows:        ${String(all.length).padStart(13)} │`);
  console.log(`  │  Wiki found:         ${String(totalFound).padStart(13)} │`);
  console.log(`  │  Not found:          ${String(totalFailed).padStart(13)} │`);
  console.log(`  │  High confidence:    ${String(highConf).padStart(13)} │`);
  console.log(`  │  Medium confidence:  ${String(medConf).padStart(13)} │`);
  console.log(`  │  Low confidence:     ${String(lowConf).padStart(13)} │`);
  console.log('  └─────────────────────────────────────┘');

  if (totalFailed > 0) {
    console.log(`\n  Shows without wiki (first 20):`);
    all.filter(m => !m.wiki_slug).slice(0, 20).forEach(m =>
      console.log(`    - ${m.title}`)
    );
    if (totalFailed > 20) console.log(`    ... and ${totalFailed - 20} more`);
  }

  console.log(`\n  Output: data/wiki-mappings.json`);
  console.log(`  Review the file and set "verified": true for entries you confirm.\n`);
}

function saveMappings(index) {
  const output = {
    generated_at: new Date().toISOString(),
    total: index.size,
    found: [...index.values()].filter(m => m.wiki_slug).length,
    not_found: [...index.values()].filter(m => !m.wiki_slug).length,
    mappings: [...index.values()],
  };
  const tmp = MAPPINGS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(output, null, 2), 'utf8');
  fs.renameSync(tmp, MAPPINGS_PATH);
}

main().catch(err => {
  console.error(`\n  Fatal: ${err.message}\n`);
  process.exit(1);
});
