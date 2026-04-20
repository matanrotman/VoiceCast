const fs = require('fs');
const path = require('path');

const db = JSON.parse(fs.readFileSync('data/database.json', 'utf8'));
const imagesDir = 'data/images';

let mismatchShows = 0;
let orphanImages = 0;
let totalImages = 0;

const folders = fs.readdirSync(imagesDir).filter(f => 
  fs.statSync(path.join(imagesDir, f)).isDirectory()
);

folders.forEach(folder => {
  const show = db.shows.find(s => 
    s.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') === folder
  );
  if (!show) return;

  const files = fs.readdirSync(path.join(imagesDir, folder)).filter(f => !f.startsWith('.'));
  totalImages += files.length;

  const charSlugs = new Set(
    (show.characters || [])
      .filter(c => c.character_image)
      .map(c => {
        const url = c.character_image;
        return url.split('/').pop().replace(/\.[^.]+$/, '');
      })
  );

  const orphans = files.filter(f => !charSlugs.has(f.replace(/\.[^.]+$/, '')));
  if (orphans.length > 0) {
    mismatchShows++;
    orphanImages += orphans.length;
    console.log(`${show.title} (${folder}): ${orphans.length} orphan images`);
    orphans.forEach(f => console.log('    ', f));
  }
});

console.log('\n=== Summary ===');
console.log('Total image files on disk:', totalImages);
console.log('Shows with orphan images:', mismatchShows);
console.log('Total orphan image files:', orphanImages);
