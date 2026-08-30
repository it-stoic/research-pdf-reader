/*
 * Research PDF Reader, https://github.com/it-stoic/research-pdf-reader
 * Copyright (C) 2026 Filip Simunjak
 * Licensed under the GNU Affero General Public License v3 or later; see LICENSE.
 *
 * Match modes and variant suggestions, over the folded string index-core makes.
 * Everything here is plain string work, so it runs and is tested under node.
 */
(function (root, factory) {
  var core = typeof require === 'function' ? require('./index-core') : root.IndexCore;
  var api = factory(core);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MatchCore = api;
})(typeof self !== 'undefined' ? self : this, function (IndexCore) {
  'use strict';

  var isWordChar = IndexCore.isWordChar;
  var foldText = IndexCore.foldText;

  var SUGGEST_LIMIT = 12;
  var MIN_STEM = 4;        // shorter than this and one letter apart is a different word
  var VOWELS = 'aeiou';

  // letters a reading engine mixes up, once the scribe's own spellings are folded away
  var CONFUSED = new Set([
    'ce', 'co', 'cl', 'il', 'ij', 'lt', 'mn', 'nh', 'nu', 'nr',
    'bh', 'bl', 'ft', 'fs', 'gq', 'sz', 'pq',
  ]);

  function isVowel(ch) {
    return VOWELS.indexOf(ch) >= 0;
  }

  /*
   * modi is the genitive of modus and stands on nearly every page of a charter
   * collection, so a term carries the mode that keeps it apart from the family
   * name: 'word' Modich only, 'start' also Modicha and Modichem, 'any' also
   * deModich.
   */
  function findAll(text, term, mode) {
    var out = [];
    if (!term) return out;
    var from = 0;
    for (;;) {
      var at = text.indexOf(term, from);
      if (at < 0) return out;
      var end = at + term.length;
      var openLeft = at === 0 || !isWordChar(text.charAt(at - 1));
      var openRight = end === text.length || !isWordChar(text.charAt(end));
      if (mode === 'any' || (openLeft && (mode !== 'word' || openRight))) {
        out.push({ start: at, end: end });
      }
      from = at + 1;
    }
  }

  function count(text, term, mode) {
    return findAll(text, term, mode).length;
  }

  /* Every word of a folded page, counted into a map that grows across pages. */
  function addWords(text, into) {
    var vocab = into || new Map();
    var start = -1;
    for (var i = 0; i <= text.length; i++) {
      var word = i < text.length && isWordChar(text.charAt(i));
      if (word && start < 0) start = i;
      if (!word && start >= 0) {
        var w = text.slice(start, i);
        vocab.set(w, (vocab.get(w) || 0) + 1);
        start = -1;
      }
    }
    return vocab;
  }

  var DIGRAPHS = { 'ch': 'c', 'cz': 'c', 'cs': 'c', 'ty': 'c', 'th': 't' };
  var LETTERS = { 'w': 'u', 'v': 'u', 'y': 'i' };

  /*
   * The spelling a scribe was free to vary, stripped out: w, u and v are one
   * letter, y is i, the many ways of writing the c sound collapse, and a
   * doubled consonant is a single one. Two words with the same skeleton are the
   * same name written twice.
   */
  function skeleton(word) {
    var out = '';
    for (var i = 0; i < word.length; i++) {
      var pair = DIGRAPHS[word.substr(i, 2)];
      if (pair !== undefined) { out += pair; i++; continue; }
      var one = LETTERS[word.charAt(i)];
      out += one === undefined ? word.charAt(i) : one;
    }
    var deduped = '';
    for (var k = 0; k < out.length; k++) {
      if (out.charAt(k) !== out.charAt(k - 1)) deduped += out.charAt(k);
    }
    return deduped;
  }

  /*
   * How far two skeletons are from being the same name: 0 the same, 1 a letter
   * apart inside, 2 a letter apart at the front, and -1 not the same name at
   * all. A plain distance of one is far too generous, so three things hold it
   * back.
   *
   * The letter that differs has to be one that stands for another: a vowel for a
   * vowel, which is the scribe, or a pair a reading engine mixes up, which is
   * the OCR. Modich and Mudich are the same family, Modich and Modip are not.
   *
   * A difference at the very first letter is real but rarer, and it is where
   * nonsense creeps in, so it is allowed and then ranked last: Nodich is offered
   * for Modich, woman is not offered for Roman.
   *
   * A letter may be missing or added only in the middle, and only a vowel. At
   * the end it is a case ending and starts with already finds those.
   */
  function kin(a, b) {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > 1) return -1;

    var short = a.length <= b.length ? a : b;
    var long = a.length <= b.length ? b : a;
    if (short.length < MIN_STEM) return -1;

    var i = 0;
    while (i < short.length && short.charAt(i) === long.charAt(i)) i++;
    var j = 0;
    while (j < short.length - i && short.charAt(short.length - 1 - j) === long.charAt(long.length - 1 - j)) j++;

    if (short.length === long.length) {
      if (i + j + 1 < short.length) return -1;
      if (!swappable(short.charAt(i), long.charAt(i))) return -1;
      return i === 0 ? 2 : 1;
    }
    if (i + j < short.length || j < 1 || i < 1) return -1;
    return isVowel(long.charAt(i)) ? 1 : -1;
  }

  /*
   * Two letters that stand for each other: one vowel for another, which is the
   * scribe, or a pair a reading engine mixes up, which is the OCR. Both belong
   * here, because a name arrives through both hands.
   */
  function swappable(one, other) {
    if (isVowel(one) && isVowel(other)) return true;
    return CONFUSED.has(one + other) || CONFUSED.has(other + one);
  }

  /*
   * Neighbours of a term that are actually in the book. A rule engine can emit
   * forms no charter ever used; this offers only what the vocabulary holds,
   * with its count, so ticking one is a decision about this book.
   */
  function suggest(vocab, term, opts) {
    var o = opts || {};
    var limit = o.limit || SUGGEST_LIMIT;
    var skip = new Set((o.exclude || []).map(foldText));
    var wanted = foldText(term);
    if (!wanted) return [];
    skip.add(wanted);
    var mine = skeleton(wanted);
    var found = [];

    vocab.forEach(function (n, word) {
      if (skip.has(word)) return;
      var theirs = skeleton(word);
      var near = kin(theirs, mine);
      if (near < 0) return;
      found.push({ word: word, count: n, distance: near });
    });

    found.sort(function (a, b) {
      return a.distance - b.distance || b.count - a.count || a.word.localeCompare(b.word);
    });
    return found.slice(0, limit);
  }

  return {
    findAll: findAll,
    count: count,
    addWords: addWords,
    skeleton: skeleton,
    kin: kin,
    suggest: suggest,
  };
});
