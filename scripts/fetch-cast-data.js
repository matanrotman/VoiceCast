#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'database.json');
const SHOWS_PATH = path.join(__dirname, 'shows-to-fetch.txt');

const API_KEY = process.env.TMDB_API_KEY;

if (!API_KEY) {
  console.error('Error: TMDB_API_KEY environment variable is not set.');
  process.exit(1);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse JSON: ${e.message}`));
        }
      });
    }).on('error', reject);
  });
}

function stripVoiceSuffix(name) {
  return name.replace(/\s*\(voice\)\s*/gi, '').trim();
}

async function fetchCredits(tmdbId, tmdbType) {
  if (tmdbType === 'movie') {
    return fetchJson(
      `https://api.themoviedb.org/3/movie/${tmdbId}/credits?api_key=${API_KEY}`
    );
  } else {
    // aggregate_credits merges recurring roles across all seasons
    return fetchJson(
      `https://api.themoviedb.org/3/tv/${tmdbId}/aggregate_credits?api_key=${API_KEY}`
    );
  }
}

function buildCharacters(credits, tmdbType) {
  const cast = credits.cast || [];
  const characters = [];

  for (const member of cast) {
    if (tmdbType === 'movie') {
      const characterName = stripVoiceSuffix(member.character || '');
      if (!characterName) continue;
      characters.push({
        character_name: characterName,
        character_image: null,
        character_image_placeholder: true,
        voice_actor: member.name,
        voice_actor_tmdb_id: member.id,
        voice_actor_photo: null,
      });
    } else {
      // TV aggregate_credits: each cast member has a roles[] array
      for (const role of member.roles || []) {
        const characterName = stripVoiceSuffix(role.character || '');
        if (!characterName) continue;
        characters.push({
          character_name: characterName,
          character_image: null,
          character_image_placeholder: true,
          voice_actor: member.name,
          voice_actor_tmdb_id: member.id,
          voice_actor_photo: null,
        });
      }
    }
  }

  return characters;
}

async function main() {
  if (!fs.existsSync(SHOWS_PATH)) {
    console.error(`Error: ${SHOWS_PATH} not found.`);
    process.exit(1);
  }

  const lines = fs
    .readFileSync(SHOWS_PATH, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));

  const showsToFetch = lines.map(line => {
    const parts = line.split('|');
    return {
      title: parts[0].trim(),
      tmdbId: parseInt(parts[1], 10),
      tmdbType: parts[2].trim(),
    };
  });

  console.log(`Found ${showsToFetch.length} show(s) in shows-to-fetch.txt.`);

  // Read (or initialise) the database
  let db;
  if (fs.existsSync(DB_PATH)) {
    db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } else {
    db = { version: 1, updated_at: new Date().toISOString(), shows: [] };
  }

  for (let i = 0; i < showsToFetch.length; i++) {
    const { title, tmdbId, tmdbType } = showsToFetch[i];
    const prefix = `[${i + 1}/${showsToFetch.length}]`;

    // Skip duplicates
    const alreadyPresent = db.shows.some(
      s => s.tmdb_id === tmdbId && s.tmdb_type === tmdbType
    );
    if (alreadyPresent) {
      console.log(`${prefix} Skipping "${title}" — already in database.`);
    } else {
      console.log(`${prefix} Fetching "${title}" (id=${tmdbId}, type=${tmdbType})...`);
      try {
        const credits = await fetchCredits(tmdbId, tmdbType);
        const characters = buildCharacters(credits, tmdbType);

        db.shows.push({ title, tmdb_id: tmdbId, tmdb_type: tmdbType, characters });
        db.updated_at = new Date().toISOString();

        // Write after every successful show so partial runs aren't lost
        fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
        console.log(`  -> OK: ${characters.length} character(s) added.`);
      } catch (err) {
        console.error(`  -> Error: ${err.message}`);
      }
    }

    // 1-second delay between requests (skip after the last one)
    if (i < showsToFetch.length - 1) {
      await sleep(1000);
    }
  }

  console.log('\nDone.');
}

main();
