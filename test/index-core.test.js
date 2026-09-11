const assert = require('assert');
const { buildPage, spans, locate, original, fold, foldText, isWordChar } = require('../index-core');
const frag = require('./frag');

function run() {
  /* --- folding ----------------------------------------------------------- */

  assert.strictEqual(foldText('Modić'), 'modic');
  assert.strictEqual(foldText('MODIĆ'), 'modic');
  assert.strictEqual(foldText('Mwdych'), 'mwdych');
  assert.strictEqual(foldText('Đurđević'), 'durdevic');
  assert.strictEqual(foldText('Æthel'), 'aethel');
  assert.strictEqual(fold('́'), '', 'a lone combining mark folds away');
  assert.ok(isWordChar('c') && isWordChar('4') && !isWordChar(' ') && !isWordChar('-'));

  /* --- one name in three fragments, the ordinary case --------------------- */

  const split = buildPage([frag('Mo', 100, 700), frag('di', 112, 700), frag('ch', 124, 700)]);
  assert.strictEqual(split.text, 'modich');
  assert.ok(split.text.indexOf('modich') === 0, 'the name is contiguous in the string');
  assert.strictEqual(spans(split, 0, 6).length, 3, 'three fragments, three boxes');

  /* --- a gap on the same line is a space, a tight join is not ------------- */

  const spaced = buildPage([frag('quo', 100, 700), frag('modi', 140, 700)]);
  assert.strictEqual(spaced.text, 'quo modi');
  const tight = buildPage([frag('quo', 100, 700), frag('modi', 118, 700)]);
  assert.strictEqual(tight.text, 'quomodi');

  /* --- a fragment carrying its own space is not doubled ------------------- */

  const own = buildPage([frag('quo ', 100, 700), frag('modi', 140, 700)]);
  assert.strictEqual(own.text, 'quo modi');

  /* --- a line break separates, even when the boxes sit close -------------- */

  const twoLines = buildPage([frag('quo', 100, 700), frag('modi', 100, 686)]);
  assert.strictEqual(twoLines.text, 'quo modi');

  /* --- a name broken across a line is stitched ---------------------------- */

  const broken = buildPage([frag('Mo-', 100, 700), frag('dich', 100, 686)]);
  assert.strictEqual(broken.text, 'modich', 'the hyphen is gone and the halves are one word');
  const across = spans(broken, 0, 6);
  assert.strictEqual(across.length, 2, 'one box per line');
  assert.strictEqual(across[0].y, 700);
  assert.strictEqual(across[1].y, 686);
  assert.deepStrictEqual([across[0].from, across[0].to], [0, 2], 'Mo, without the hyphen');
  assert.deepStrictEqual([across[1].from, across[1].to], [0, 4], 'and dich whole');

  /* --- an en dash at a line end breaks a word too ------------------------- */

  const dashed = buildPage([frag('Mo–', 100, 700), frag('dich', 100, 686)]);
  assert.strictEqual(dashed.text, 'modich');

  /* --- a real dash between words is kept --------------------------------- */

  const kept = buildPage([frag('quo-', 100, 700), frag(' modi', 100, 686)]);
  assert.strictEqual(kept.text, 'quo- modi');

  /* --- an empty fragment marks the line break it stands for --------------- */

  const eol = buildPage([
    frag('quo', 100, 700, { hasEOL: true }),
    frag('', 0, 0, { width: 0, height: 0 }),
    frag('modi', 100, 700),
  ]);
  assert.strictEqual(eol.text, 'quo modi', 'the break wins over the baseline');

  /* --- the map back holds under a folding that changes length ------------- */

  const grown = buildPage([frag('Æ', 100, 700, { width: 8 })]);
  assert.strictEqual(grown.text, 'ae');
  assert.strictEqual(grown.src[0], grown.src[1], 'both letters point at the one glyph');
  assert.strictEqual(spans(grown, 0, 2).length, 1);

  /* --- inserted characters belong to no box ------------------------------ */

  assert.strictEqual(spaced.src[3], null);
  const around = spans(spaced, 0, spaced.text.length);
  assert.strictEqual(around.length, 2, 'the inserted space closes no box of its own');

  /* --- a fragment that reports no width still gets one ------------------- */

  const guessed = buildPage([frag('modi', 100, 700, { width: 0 })]);
  assert.strictEqual(guessed.text, 'modi');
  const one = spans(guessed, 0, 4)[0];
  assert.ok(one.w > 0 && one.x === 100);

  /* --- the printed text, for quoting and for context ---------------------- */

  const printed = buildPage([frag('Modić', 100, 700), frag('QUO', 140, 700)]);
  assert.strictEqual(printed.text, 'modic quo');
  assert.strictEqual(original(printed, 0, printed.text.length), 'Modić QUO', 'capitals and marks come back');
  assert.strictEqual(original(printed, 0, 5), 'Modić', 'and so does a stretch of one word');
  assert.strictEqual(original(broken, 0, 6), 'Modich', 'a stitched word reads as one');
  assert.strictEqual(original(grown, 0, 2), 'Æ', 'one glyph behind two letters is written once');

  /* --- a point in a fragment, back to the string, for a selection -------- */

  assert.strictEqual(locate(spaced, 0, 0), 0, 'the start of quo');
  assert.strictEqual(locate(spaced, 1, 0), 4, 'the start of modi, past the inserted space');
  assert.strictEqual(locate(spaced, 0, 3), 4, 'the end of quo is the character after it');
  assert.strictEqual(locate(spaced, 1, 4), spaced.text.length, 'past the last glyph is the end of the page');
  assert.strictEqual(spaced.text.slice(locate(spaced, 1, 1), locate(spaced, 1, 3)), 'od');
  assert.strictEqual(broken.text.slice(locate(broken, 0, 0), locate(broken, 0, 3)), 'mo',
    'a selection of Mo- ends before dich, with the hyphen already gone');
  assert.strictEqual(locate(grown, 0, 0), 0, 'a glyph behind two letters starts at the first');
  assert.strictEqual(locate(grown, 0, 1), 2);

  /* --- a page with nothing on it must not crash -------------------------- */

  const empty = buildPage([]);
  assert.strictEqual(empty.text, '');
  assert.deepStrictEqual(spans(empty, 0, 5), []);

  console.log('index: ok');
}

run();
