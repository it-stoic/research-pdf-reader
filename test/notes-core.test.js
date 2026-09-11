const assert = require('assert');
const { buildPage } = require('../index-core');
const { anchor, onPage, quote, place, inkLabels, markdown } = require('../notes-core');
const frag = require('./frag');

const book = [
  buildPage([frag('Modić', 100, 700), frag('et', 140, 700), frag('Mo-', 100, 686), frag('dich', 100, 672)]),
  buildPage([frag('quo', 100, 700), frag('modi', 140, 700)]),
];

function run() {
  assert.strictEqual(book[0].text, 'modic et modich');
  assert.strictEqual(book[1].text, 'quo modi');

  /* --- a selection becomes a stretch, with the gaps at its edges left off -- */

  assert.deepStrictEqual(anchor(book, { page: 0, at: 5 }, { page: 0, at: 9 }),
    { page: 0, start: 6, endPage: 0, end: 8 }, 'the spaces either side of et are not kept');
  assert.strictEqual(anchor(book, { page: 0, at: 5 }, { page: 0, at: 6 }), null, 'a drag over a gap alone is nothing');
  assert.deepStrictEqual(anchor(book, { page: 0, at: 9 }, { page: 1, at: 3 }),
    { page: 0, start: 9, endPage: 1, end: 3 }, 'a paragraph may run onto the next page');
  assert.strictEqual(anchor(book, { page: 1, at: 0 }, { page: 0, at: 3 }), null);
  assert.deepStrictEqual(anchor(book, { page: 0, at: 9 }, { page: 1, at: 0 }),
    { page: 0, start: 9, endPage: 0, end: 15 }, 'a drag onto the top margin of the next page stays on this one');
  assert.deepStrictEqual(anchor(book, { page: 0, at: 15 }, { page: 1, at: 3 }),
    { page: 1, start: 0, endPage: 1, end: 3 }, 'and one begun below the last line starts on the next');

  const across = { page: 0, start: 9, endPage: 1, end: 3 };
  assert.deepStrictEqual(onPage(across, 0, book[0].text.length), { start: 9, end: 15 });
  assert.deepStrictEqual(onPage(across, 1, book[1].text.length), { start: 0, end: 3 });
  assert.strictEqual(onPage(across, 2, 10), null);

  /* --- the quotation is the printed text, not the folded index ----------- */

  assert.strictEqual(quote(book, { page: 0, start: 0, endPage: 0, end: 5 }), 'Modić');
  assert.strictEqual(quote(book, { page: 0, start: 9, endPage: 0, end: 15 }), 'Modich', 'a stitched word quotes whole');
  assert.strictEqual(quote(book, across), 'Modich quo', 'and a stretch over a page break reads straight on');

  /* --- a note read back is checked against the book that is open ---------- */

  const kept = { id: 'a', page: 0, start: 0, endPage: 0, end: 5, ink: 'green', label: 'cite', comment: 'x', quote: 'Modić' };
  assert.deepStrictEqual(place(book, kept), kept, 'a note that still fits comes back as it was');
  assert.deepStrictEqual(place(book, Object.assign({}, across, { quote: 'Modich quo' })).end, 3);

  const moved = place(book, { page: 0, start: 0, end: 2, quote: 'et' });
  assert.deepStrictEqual([moved.start, moved.end], [6, 8], 'words a little further along are found again');
  assert.strictEqual(moved.endPage, 0, 'a note from before notes could cross a page is still one page');

  assert.strictEqual(place(book, { page: 0, start: 0, end: 5, quote: 'Turci' }), null, 'words that are not there are not painted');
  assert.strictEqual(place(book, { page: 5, start: 0, end: 5, quote: 'Modić' }), null, 'a page this book does not have');
  assert.strictEqual(place(book, { page: 0, start: 0, end: 50, quote: 'Modić' }), null);
  assert.strictEqual(place(book, { page: 0, start: '0', end: 5, quote: 'Modić' }), null);
  assert.strictEqual(place(book, { page: 0, start: 0, end: 5 }), null, 'without its words a note cannot be checked');
  assert.strictEqual(place(book, null), null);

  const odd = place(book, { page: 0, start: 0, end: 5, quote: 'Modić', ink: 'purple', label: 'maybe', comment: 7 });
  assert.deepStrictEqual([odd.ink, odd.label, odd.comment], ['yellow', '', ''], 'what this app does not know is dropped');

  /* --- the label a colour carries in one book, read back ------------------ */

  assert.deepStrictEqual(inkLabels({ orange: 'important', green: '', blue: 'maybe', purple: 'cite' }),
    { orange: 'important', green: '' }, 'an unknown label or colour is dropped, a label taken off is kept');
  assert.deepStrictEqual(inkLabels(null), {});
  assert.deepStrictEqual(inkLabels('orange'), {});

  /* --- Markdown, one section per colour, reading order inside it --------- */

  const md = markdown('Codex', [
    { page: 1, start: 0, endPage: 1, end: 3, ink: 'yellow', label: '', comment: '', quote: 'quo' },
    { page: 0, start: 9, endPage: 1, end: 3, ink: 'green', label: '', comment: '', quote: 'Modich quo' },
    { page: 0, start: 0, endPage: 0, end: 5, ink: 'yellow', label: 'important', comment: ' the family \n', quote: 'Modić' },
  ]);
  assert.strictEqual(md, [
    '# Codex', '',
    '## Yellow', '',
    '**p. 1** · Important', '', '> Modić', '', 'the family', '',
    '**p. 2**', '', '> quo', '',
    '## Green', '',
    '**pp. 1–2**', '', '> Modich quo', '',
  ].join('\n'));

  console.log('notes: ok');
}

run();
