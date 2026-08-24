const fs = require('fs');

const manifest = JSON.parse(fs.readFileSync('./manifest.json', 'utf8'));

manifest.pages = manifest.pages.map(pageId => {
  const pageData = JSON.parse(fs.readFileSync(`./pages/${pageId}/page.json`, 'utf8'));
  pageData.id = pageId;
  return pageData;
});

fs.writeFileSync('./manifest.json', JSON.stringify(manifest));
console.log('Manifest consolidated successfully!');