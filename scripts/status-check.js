const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const db = JSON.parse(fs.readFileSync('data/database.json', 'utf8'));
const checkpoint = new Database('data/build-checkpoint.db');
const completed = checkpoint.prepare('SELECT COUNT(*) as count FROM completed_shows').get().count;

const total = db.shows.length;
const hasChars = db.shows.filter(s => (s.characters || []).length > 0).length;
const hasImages = db.shows.filter(s => (s.characters || []).some(c => c.character_image)).length;
const hasWiki = db.shows.filter(s => s.fandom_wiki).length;
const empty = db.shows.filter(s => !(s.characters || []).length).length;

const general = ['disney', 'pixar', 'dreamworks', 'nickelodeon', 'cartoonnetwork', 'ghibli'];
const stillGeneral = db.shows.filter(s => general.includes(s.fandom_wiki)).length;

// Count image directories on disk
const imagesDir = 'data/images';
const imgFolders = fs.existsSync(imagesDir) ? fs.readdirSync(imagesDir).filter(f => fs.statSync(path.join(imagesDir, f)).isDirectory()) : [];
const showSlugs = new Set(db.shows.map(s => s.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')));
const orphanFolders = imgFolders.filter(f => !showSlugs.has(f));

console.log('=== Database Status ===');
console.log('Total shows:', total);
console.log('Checkpoint completed:', completed);
console.log('Has characters:', hasChars);
console.log('Has images:', hasImages);
console.log('Has wiki:', hasWiki);
console.log('Empty (no chars):', empty);
console.log('Still using general wiki:', stillGeneral);
console.log('');
console.log('=== Image Folders ===');
console.log('Total image folders on disk:', imgFolders.length);
console.log('Orphan folders (no matching show):', orphanFolders.length);
if (orphanFolders.length > 0) {
  orphanFolders.forEach(f => console.log('  ', f));
}

checkpoint.close();
