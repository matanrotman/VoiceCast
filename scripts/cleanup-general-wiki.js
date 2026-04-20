const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.resolve(__dirname, '../data/database.json');
const IMAGES_DIR = path.resolve(__dirname, '../data/images');
const CHECKPOINT_PATH = path.resolve(__dirname, '../data/build-checkpoint.db');

const general = ['disney', 'pixar', 'dreamworks', 'nickelodeon', 'cartoonnetwork', 'ghibli'];
const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
const checkpoint = new Database(CHECKPOINT_PATH);

let cleaned = 0;
let imagesDirsCleaned = 0;

db.shows.forEach(s => {
  if (!general.includes(s.fandom_wiki)) return;

  const slug = s.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const imgDir = path.join(IMAGES_DIR, slug);

  if (fs.existsSync(imgDir)) {
    fs.rmSync(imgDir, { recursive: true });
    imagesDirsCleaned++;
  }

  s.fandom_wiki = null;
  s.characters = [];

  checkpoint.prepare('DELETE FROM completed_shows WHERE tmdb_id = ?').run(s.tmdb_id);

  cleaned++;
});

fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
checkpoint.close();

console.log('Cleaned ' + cleaned + ' shows');
console.log('Deleted ' + imagesDirsCleaned + ' image directories');
