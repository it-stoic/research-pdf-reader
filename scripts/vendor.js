// Copies the browser build of pdf.js into vendor/ so the app runs straight from
// the file system, with no bundler and no network.
const fs = require('fs');
const path = require('path');

const files = [
  ['pdfjs-dist/legacy/build/pdf.min.js', 'pdf.min.js'],
  ['pdfjs-dist/legacy/build/pdf.worker.min.js', 'pdf.worker.min.js'],
];

const target = path.join(__dirname, '..', 'vendor');
fs.mkdirSync(target, { recursive: true });
files.forEach(([from, to]) => {
  fs.copyFileSync(require.resolve(from), path.join(target, to));
  console.log('vendor/' + to);
});
