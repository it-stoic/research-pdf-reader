/*
 * Research PDF Reader, https://github.com/it-stoic/research-pdf-reader
 * Copyright (C) 2026 Filip Simunjak
 * Licensed under the GNU Affero General Public License v3 or later; see LICENSE.
 *
 * Highlights and comments. A note is a stretch of the index, so it is drawn by
 * the same code that draws a hit. No DOM, no pdf.js.
 */
(function (root, factory) {
  var core = typeof require === 'function' ? require('./index-core') : root.IndexCore;
  var api = factory(core);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NotesCore = api;
})(typeof self !== 'undefined' ? self : this, function (IndexCore) {
  'use strict';

  // a note keeps the key, so a colour can be retuned without losing what was marked in it
  var INKS = [
    { key: 'yellow', name: 'Yellow', color: '#ffe14d' },
    { key: 'green', name: 'Green', color: '#a6e77f' },
    { key: 'blue', name: 'Blue', color: '#55c6ff' },
    { key: 'pink', name: 'Pink', color: '#ff9aa8' },
    { key: 'orange', name: 'Orange', color: '#ffab6b' },
  ];

  var LABELS = [
    { key: 'important', name: 'Important' },
    { key: 'verify', name: 'To verify' },
    { key: 'questionable', name: 'Questionable' },
    { key: 'cite', name: 'To cite' },
  ];

  function byKey(list, key) {
    for (var i = 0; i < list.length; i++) if (list[i].key === key) return list[i];
    return null;
  }

  function flat(text) {
    return text.replace(/\s+/g, ' ').trim();
  }

  function order(a, b) {
    return a.page - b.page || a.start - b.start;
  }

  // a drag that overshoots into the gap after a word, or onto the margin of the next page, must not carry it
  function anchor(book, from, to) {
    var page = from.page;
    var start = from.at;
    var endPage = to.page;
    var end = to.at;
    for (;;) {
      var first = book[page].text;
      while (start < first.length && first[start] === ' ') start++;
      if (start < first.length || page >= endPage) break;
      page++;
      start = 0;
    }
    for (;;) {
      var last = book[endPage].text;
      while (end > 0 && last[end - 1] === ' ') end--;
      if (end > 0 || endPage <= page) break;
      endPage--;
      end = book[endPage].text.length;
    }
    if (page === endPage ? start >= end : page > endPage) return null;
    return { page: page, start: start, endPage: endPage, end: end };
  }

  function onPage(note, i, length) {
    if (i < note.page || i > note.endPage) return null;
    return {
      start: i === note.page ? note.start : 0,
      end: i === note.endPage ? note.end : length,
    };
  }

  function across(book, note, read) {
    var parts = [];
    for (var i = note.page; i <= note.endPage; i++) {
      var part = onPage(note, i, book[i].text.length);
      parts.push(read(book[i], part.start, part.end));
    }
    return flat(parts.join(' '));
  }

  function quote(book, note) {
    return across(book, note, IndexCore.original);
  }

  // a file of notes made on another copy of the book must not paint over the wrong words
  function place(book, raw) {
    if (!raw || typeof raw !== 'object') return null;
    var note = {
      id: typeof raw.id === 'string' ? raw.id : '',
      page: raw.page,
      start: raw.start,
      endPage: raw.endPage === undefined ? raw.page : raw.endPage,
      end: raw.end,
      ink: byKey(INKS, raw.ink) ? raw.ink : INKS[0].key,
      label: byKey(LABELS, raw.label) ? raw.label : '',
      comment: typeof raw.comment === 'string' ? raw.comment : '',
      quote: typeof raw.quote === 'string' ? flat(raw.quote) : '',
    };
    var whole = [note.page, note.start, note.endPage, note.end].every(Number.isInteger);
    if (!whole || note.page < 0 || note.endPage < note.page || note.endPage >= book.length) return null;
    if (note.start < 0 || note.end < 0 || note.start > book[note.page].text.length) return null;
    if (note.end > book[note.endPage].text.length) return null;

    var want = flat(IndexCore.foldText(note.quote));
    if (!want) return null;
    var there = across(book, note, function (page, start, end) { return page.text.slice(start, end); });
    if (there === want) return note;
    if (note.page !== note.endPage) return null;

    var text = book[note.page].text;
    var best = -1;
    for (var at = text.indexOf(want); at >= 0; at = text.indexOf(want, at + 1)) {
      if (best < 0 || Math.abs(at - note.start) < Math.abs(best - note.start)) best = at;
    }
    if (best < 0) return null;
    note.start = best;
    note.end = best + want.length;
    return note;
  }

  // colour -> label, as read back; '' is kept, since it means the reader took the label off
  function inkLabels(raw) {
    var out = {};
    if (!raw || typeof raw !== 'object') return out;
    INKS.forEach(function (ink) {
      var key = raw[ink.key];
      if (key === '' || byKey(LABELS, key)) out[ink.key] = key;
    });
    return out;
  }

  function pages(note) {
    return note.page === note.endPage
      ? 'p. ' + (note.page + 1)
      : 'pp. ' + (note.page + 1) + '–' + (note.endPage + 1);
  }

  function markdown(title, notes) {
    var out = ['# ' + title, ''];
    INKS.forEach(function (ink) {
      var mine = notes.filter(function (note) { return note.ink === ink.key; }).sort(order);
      if (!mine.length) return;
      out.push('## ' + ink.name, '');
      mine.forEach(function (note) {
        var label = byKey(LABELS, note.label);
        out.push('**' + pages(note) + '**' + (label ? ' · ' + label.name : ''), '');
        out.push('> ' + note.quote, '');
        if (note.comment.trim()) out.push(note.comment.trim(), '');
      });
    });
    return out.join('\n');
  }

  return {
    INKS: INKS,
    LABELS: LABELS,
    ink: function (key) { return byKey(INKS, key) || INKS[0]; },
    label: function (key) { return byKey(LABELS, key); },
    order: order,
    anchor: anchor,
    onPage: onPage,
    quote: quote,
    place: place,
    inkLabels: inkLabels,
    pages: pages,
    markdown: markdown,
  };
});
