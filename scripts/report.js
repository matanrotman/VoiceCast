'use strict';

const fs = require('fs');
const path = require('path');

const DB_PATH = path.resolve(__dirname, '../data/database.json');

function loadDatabase() {
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function main() {
  const db = loadDatabase();
  const shows = db.shows;

  let totalShows = shows.length;
  let showsWithAllImages = 0;
  let showsWithSomeImages = 0;
  let showsWithNoImages = 0;
  let showsWithNoFandom = 0;
  let totalCharacters = 0;
  let charsWithImage = 0;
  let charsWithActorPhoto = 0;
  const missingImageShows = [];
  const noFandomShows = [];

  shows.forEach(show => {
    const chars = show.characters || [];
    totalCharacters += chars.length;

    const withImage = chars.filter(c => c.character_image).length;
    const withPhoto = chars.filter(c => c.voice_actor_photo).length;
    charsWithImage += withImage;
    charsWithActorPhoto += withPhoto;

    if (!show.fandom_wiki) {
      showsWithNoFandom++;
      noFandomShows.push(show.title);
    }

    if (chars.length === 0) {
      showsWithNoImages++;
      missingImageShows.push({ title: show.title, total: 0, withImage: 0, fandom: show.fandom_wiki });
    } else if (withImage === 0) {
      showsWithNoImages++;
      missingImageShows.push({ title: show.title, total: chars.length, withImage: 0, fandom: show.fandom_wiki });
    } else if (withImage < chars.length) {
      showsWithSomeImages++;
    } else {
      showsWithAllImages++;
    }
  });

  console.log('\n' + '═'.repeat(60));
  console.log('📊 VoiceCast Database Report');
  console.log('═'.repeat(60));
  console.log(`\n📺 Shows: ${totalShows} total`);
  console.log(`   ✅ All characters have images: ${showsWithAllImages}`);
  console.log(`   🟡 Some characters have images: ${showsWithSomeImages}`);
  console.log(`   ❌ No character images at all:  ${showsWithNoImages}`);
  console.log(`   ⚠️  No Fandom wiki found:        ${showsWithNoFandom}`);
  console.log(`\n👥 Characters: ${totalCharacters} total`);
  console.log(`   🎨 With character image:  ${charsWithImage} (${Math.round(charsWithImage/totalCharacters*100)}%)`);
  console.log(`   📸 With actor photo:      ${charsWithActorPhoto} (${Math.round(charsWithActorPhoto/totalCharacters*100)}%)`);
  console.log(`   ❌ Missing character img: ${totalCharacters - charsWithImage}`);
  console.log(`   ❌ Missing actor photo:   ${totalCharacters - charsWithActorPhoto}`);

  console.log('\n' + '─'.repeat(60));
  console.log(`❌ Shows with NO character images (${missingImageShows.length}):`);
  console.log('─'.repeat(60));
  missingImageShows.forEach(s => {
    const fandom = s.fandom ? `fandom:${s.fandom}` : 'no fandom found';
    console.log(`  - ${s.title} (${s.total} chars, ${fandom})`);
  });

  console.log('\n' + '─'.repeat(60));
  console.log(`⚠️  Shows with no Fandom wiki (${noFandomShows.length}):`);
  console.log('─'.repeat(60));
  noFandomShows.forEach(t => console.log(`  - ${t}`));

  console.log('\n' + '═'.repeat(60) + '\n');
}

main();