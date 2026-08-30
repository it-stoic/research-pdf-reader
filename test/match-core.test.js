const assert = require('assert');
const { findAll, count, addWords, skeleton, kin, suggest } = require('../match-core');

const PAGE = 'quo modi et quo modo modich modicha demodich mudich mwdych modycz molendinum';

function run() {
  /* --- the three modes, on the trap the whole app is built around --------- */

  assert.strictEqual(count(PAGE, 'modi', 'word'), 1, 'only the Latin word itself');
  assert.strictEqual(count(PAGE, 'modi', 'start'), 3, 'and every name that opens with it');
  assert.strictEqual(count(PAGE, 'modi', 'any'), 4, 'plus the one buried inside demodich');

  assert.strictEqual(count(PAGE, 'modich', 'word'), 1);
  assert.strictEqual(count(PAGE, 'modich', 'start'), 2, 'modich and modicha');
  assert.strictEqual(count(PAGE, 'modich', 'any'), 3, 'and demodich');

  assert.strictEqual(count(PAGE, 'nowhere', 'any'), 0);
  assert.strictEqual(count(PAGE, '', 'any'), 0, 'an empty term is not a match on everything');

  /* --- a hit is a stretch of the string, ready for rects() ---------------- */

  const hits = findAll(PAGE, 'modicha', 'start');
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(PAGE.slice(hits[0].start, hits[0].end), 'modicha');

  /* --- a term at the very edge of a page counts --------------------------- */

  assert.strictEqual(count('modich', 'modich', 'word'), 1);
  assert.strictEqual(count('modich et', 'modich', 'word'), 1);
  assert.strictEqual(count('et modich', 'modich', 'word'), 1);

  /* --- overlapping occurrences are all found ------------------------------ */

  assert.strictEqual(count('aaaa', 'aa', 'any'), 3);

  /* --- the skeleton: one name however the scribe spelled it --------------- */

  assert.strictEqual(skeleton('modich'), skeleton('modycz'), 'ch and cz are one sound');
  assert.strictEqual(skeleton('mwdych'), skeleton('mudich'), 'w is u and y is i');
  assert.strictEqual(skeleton('modicch'), skeleton('modich'), 'a doubled letter is one');
  assert.notStrictEqual(skeleton('modich'), skeleton('molendinum'));

  assert.strictEqual(kin('modic', 'modic'), 0, 'the same skeleton twice');
  assert.strictEqual(kin('modic', 'mudic'), 1, 'one vowel apart is the same name');
  assert.strictEqual(kin('modic', 'modeic'), 1, 'and so is a vowel dropped in the middle');
  assert.strictEqual(kin('modic', 'nodic'), 2, 'a misread initial counts, but ranks last');
  assert.strictEqual(kin('cizant', 'eizant'), 2, 'c and e are what a reading engine mixes up');
  assert.ok(kin('modic', 'molend') < 0);
  assert.ok(kin('roman', 'uoman') < 0, 'woman is not a spelling of Roman');
  assert.ok(kin('roma', 'toma') < 0, 'nor toma of Roma');
  assert.ok(kin('roma', 'rom') < 0, 'nor room, once its double o has folded');
  assert.ok(kin('modic', 'modip') < 0, 'a letter nothing confuses with c is a different word');
  assert.ok(kin('modic', 'modics') < 0, 'an ending is what starts with is for');
  assert.ok(kin('ram', 'rim') < 0, 'three letters are too few to guess at');

  /* --- suggestions come from the book, and only from the book ------------- */

  const vocab = addWords(PAGE);
  assert.strictEqual(vocab.get('quo'), 2);
  assert.strictEqual(vocab.get('modich'), 1);

  const offered = suggest(vocab, 'Modich').map((s) => s.word);
  assert.ok(offered.includes('mwdych'), 'the same name through w and y');
  assert.ok(offered.includes('modycz'), 'and through cz');
  assert.ok(offered.includes('mudich'));
  assert.ok(!offered.includes('modich'), 'the term itself is not offered back');
  assert.ok(!offered.includes('molendinum'), 'and neither is an unrelated word');
  assert.ok(!offered.includes('modicz'), 'a form no page carries is never invented');

  /* --- counts ride along, and the closest spellings come first ------------ */

  const busy = addWords('modich modich modich mudich mwdych', addWords(PAGE));
  const ranked = suggest(busy, 'Modich');
  assert.strictEqual(ranked[0].word, 'modycz', 'same skeleton before a near miss');
  assert.strictEqual(ranked[0].distance, 0);
  assert.strictEqual(ranked[1].word, 'mudich', 'then the near miss seen most often');
  assert.strictEqual(ranked[1].count, 2);

  /* --- spellings already on the row are not offered again ----------------- */

  const rest = suggest(vocab, 'Modich', { exclude: ['Mwdych'] }).map((s) => s.word);
  assert.ok(!rest.includes('mwdych'));
  assert.ok(rest.includes('mudich'));

  /* --- the noise a plain edit distance would have let through ------------ */

  const modern = addWords('roman romans romano romane romani woman roma rome room toma soma');
  const forRoman = suggest(modern, 'Roman').map((s) => s.word);
  assert.ok(!forRoman.includes('woman'), 'a different first letter is a different word');
  assert.ok(!forRoman.includes('romans'), 'an ending is what starts with is for');
  assert.deepStrictEqual(forRoman, [], 'romano and romani are endings too, and nothing else is kin');

  const forRoma = suggest(modern, 'Roma').map((s) => s.word);
  assert.ok(!forRoma.includes('toma') && !forRoma.includes('soma') && !forRoma.includes('room'),
    'toma, soma and room are not spellings of Roma');
  assert.ok(forRoma.includes('rome'), 'Rome is');

  /* --- a term typed with capitals and diacritics still finds its kin ------ */

  assert.deepStrictEqual(suggest(vocab, 'MODIĆ').map((s) => s.word).sort(),
    suggest(vocab, 'modic').map((s) => s.word).sort());

  console.log('match: ok');
}

run();
