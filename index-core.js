/*
 * Research PDF Reader, https://github.com/it-stoic/research-pdf-reader
 * Copyright (C) 2026 Filip Simunjak
 * Licensed under the GNU Affero General Public License v3 or later; see LICENSE.
 *
 * Text layer of one page -> one folded string, plus a map from every character
 * of that string back to the box it was drawn in. Case and diacritics are
 * folded, gaps between fragments are read off the geometry, and a word broken
 * across a line is stitched. Coordinates stay in PDF user space: y is the
 * baseline, so a box runs from y up to y + h. No DOM, no pdf.js.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.IndexCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LINE_SHARE = 0.5;    // baselines further apart than this share of the line height are two lines
  var GAP_SHARE = 0.25;    // a gap this much of a character wide is a space
  var HEIGHT_GUESS = 0.55; // character width as a share of its height, for fragments reporting no width

  var COMBINING = /[̀-ͯ]/g;
  var HYPHENS = '-­‐‑‒–—';

  // letters that carry their difference in the letter itself, where stripping marks does nothing
  var SPECIAL = {
    'đ': 'd', 'Đ': 'd', 'ð': 'd', 'Ð': 'd',
    'ł': 'l', 'Ł': 'l',
    'ø': 'o', 'Ø': 'o',
    'æ': 'ae', 'Æ': 'ae',
    'œ': 'oe', 'Œ': 'oe',
    'ß': 'ss',
    'þ': 'th', 'Þ': 'th',
    'ſ': 's',
  };

  // returns a string, not a character: ae for a ligature, nothing for a lone combining mark
  function fold(ch) {
    var special = SPECIAL[ch];
    if (special !== undefined) return special;
    return ch.normalize('NFD').replace(COMBINING, '').toLowerCase();
  }

  function foldText(text) {
    var out = '';
    for (var i = 0; i < text.length; i++) out += fold(text[i]);
    return out;
  }

  function isHyphen(ch) {
    return HYPHENS.indexOf(ch) >= 0;
  }

  function isWordChar(ch) {
    return /[^\W_]/.test(ch);
  }

  function box(item) {
    var tr = item.transform || [1, 0, 0, 1, 0, 0];
    var h = item.height || Math.abs(tr[3]) || 10;
    var w = item.width || h * HEIGHT_GUESS * item.str.length;
    return { x: tr[4], y: tr[5], w: w, h: h };
  }

  /*
   * { text, src }, where src[i] = { item, x, y, w, h } for a character drawn on
   * the page and null for one inserted here. item indexes the array that came
   * in, so the raw glyphs are still reachable.
   */
  function buildPage(items) {
    var text = '';
    var src = [];
    var prev = null;

    // a run of spaces is one space, so a padded text layer cannot hold a term apart
    function push(ch, at) {
      if (ch === ' ' && (text === '' || text[text.length - 1] === ' ')) return;
      text += ch;
      src.push(at);
    }

    // nothing, a space, or the removal of a hyphen; the fragments themselves say which only through their boxes
    function separate(before, now, str) {
      var lineHeight = Math.max(before.h, now.h);
      var newLine = before.eol || Math.abs(now.y - before.y) > lineHeight * LINE_SHARE;
      var last = text.length - 1;

      if (newLine) {
        var joins = last >= 1 && isHyphen(text[last]) && isWordChar(text[last - 1]) &&
          isWordChar(fold(str[0]).charAt(0) || ' ');
        if (joins) {
          text = text.slice(0, last);
          src.pop();
          return;
        }
        if (last < 0 || text[last] !== ' ') push(' ', null);
        return;
      }

      if (text[last] === ' ' || str[0] === ' ') return;
      if (now.x - before.x1 > before.charW * GAP_SHARE) push(' ', null);
    }

    for (var n = 0; n < items.length; n++) {
      var item = items[n];
      if (!item.str) {
        if (item.hasEOL && prev) prev.eol = true;
        continue;
      }
      var b = box(item);
      var charW = b.w / item.str.length;

      if (prev) separate(prev, b, item.str);

      for (var i = 0; i < item.str.length; i++) {
        var folded = fold(item.str[i]);
        var at = { item: n, offset: i, ch: item.str.charAt(i), x: b.x + charW * i, y: b.y, w: charW, h: b.h };
        for (var k = 0; k < folded.length; k++) push(folded[k], at);
      }

      prev = { x1: b.x + b.w, y: b.y, h: b.h, charW: charW, eol: !!item.hasEOL };
    }

    return { text: text, src: src };
  }

  /*
   * One span per fragment the stretch runs through, so a name stitched across a
   * line break gives two. from and to are offsets into that fragment's own
   * string, for a caller that can measure the real glyphs; x, y, w and h are the
   * even split, which is right vertically and only an estimate across.
   */
  function spans(page, start, end) {
    var out = [];
    var open = null;

    function close(r) {
      return { item: r.item, from: r.from, to: r.to, x: r.x, y: r.y, w: r.x1 - r.x, h: r.h };
    }

    for (var i = start; i < end && i < page.src.length; i++) {
      var at = page.src[i];
      if (!at) continue;
      if (open && open.item === at.item) {
        open.x1 = Math.max(open.x1, at.x + at.w);
        open.to = at.offset + 1;
        continue;
      }
      if (open) out.push(close(open));
      open = { item: at.item, from: at.offset, to: at.offset + 1, x: at.x, x1: at.x + at.w, y: at.y, h: at.h };
    }
    if (open) out.push(close(open));
    return out;
  }

  /*
   * spans() the other way round: a point inside one fragment, where a selection
   * starts or stops, back to a place in the string. It is the first character
   * drawn at or after the point, so the end of a selection comes out as the
   * character after it, which is what a slice wants.
   */
  function locate(page, item, offset) {
    for (var i = 0; i < page.src.length; i++) {
      var at = page.src[i];
      if (at && (at.item > item || (at.item === item && at.offset >= offset))) return i;
    }
    return page.text.length;
  }

  /*
   * The stretch as it was actually printed, capitals, diacritics and all. The
   * index is folded, so it can be searched but not quoted; this is what a
   * quotation and a line of context are made of. One glyph can stand behind
   * several folded characters, so a repeated entry is written out once.
   */
  function original(page, start, end) {
    var out = '';
    var last = null;
    for (var i = Math.max(0, start); i < end && i < page.src.length; i++) {
      var at = page.src[i];
      if (!at) { out += page.text.charAt(i); last = null; continue; }
      if (at === last) continue;
      out += at.ch;
      last = at;
    }
    return out;
  }

  return {
    buildPage: buildPage,
    spans: spans,
    locate: locate,
    original: original,
    fold: fold,
    foldText: foldText,
    isWordChar: isWordChar,
    isHyphen: isHyphen,
  };
});
