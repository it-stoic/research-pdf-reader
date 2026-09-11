/*
 * Research PDF Reader, https://github.com/it-stoic/research-pdf-reader
 * Copyright (C) 2026 Filip Simunjak
 * Licensed under the GNU Affero General Public License v3 or later; see LICENSE.
 *
 * The screen: opening a file, indexing it once, drawing the pages that are in
 * view, and painting the hits the term rows ask for. All the searching itself
 * lives in index-core.js and match-core.js, which know nothing about any of this.
 */
(function () {
  'use strict';

  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

  var MAX_SCALE = 1.8;
  var KEEP_RENDERED = 4;    // pages either side of the view that keep their canvas
  var MIN_TEXT = 40;        // characters in the whole book below which there is no text layer
  var SUGGEST_SHOWN = 8;
  var LADDER = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 2.5, 3];
  var CONTEXT = 40;         // characters of the line kept either side of a mention
  var SPREAD_GAP = 2;       // the pixels between two pages lying side by side
  var ASCENT = 0.8;         // the share of a letter's size above the baseline, so a mark covers descenders too
  var PALETTE = [
    '#ffe14d', '#ffab6b', '#ff9aa8', '#e3a9f0', '#8fb4ff',
    '#7fd6f5', '#7ae0c3', '#a6e77f', '#d5db5c', '#c0b6a8',
  ];

  var el = function (id) { return document.getElementById(id); };

  var doc = null;
  var book = [];            // per page: { text, src, view }
  var vocab = new Map();
  var rows = [];
  var nextId = 1;
  var shells = [];
  var live = new Map();     // page index -> { canvas, task }
  var seen = new Set();     // pages the observer says are on the screen right now
  var watcher = null;
  var scale = 1;
  var scales = [];          // what each page is drawn at; a book need not be all one size
  var fit = 1;
  var spread = false;       // two pages side by side, the way a book lies open
  var zoom = null;          // null is fit to width, otherwise the scale asked for
  var walk = [];            // every showing hit, in reading order
  var shown = [];           // what the list is holding, all of them or one term
  var scope = null;         // the row the list is narrowed to, or null for all
  var at = -1;
  var baselines = new Map(); // font family -> its baseline, as a share of a one-line box

  var notes = [];           // the reader's own highlights and comments on this book
  var stray = [];           // kept notes whose words this copy of the file no longer has
  var shelf = null;         // the key this book's notes are kept under in the browser
  var labels = {};          // colour -> the label it carries in this book, set by the last note given one
  var warned = false;
  var ink = NotesCore.INKS[0].key;  // the colour the last highlight was made in
  var pending = null;       // the stretch the selection bar is offering to mark
  var pressed = false;      // a press began on the pages, so its release may be a selection
  var opened = null;        // the note the note box is editing
  var lit = null;           // the note last jumped to
  var notesInk = null;
  var notesLabel = '';
  var toastTimer = null;
  var selBar = el('selBar');
  var noteBox = el('noteBox');
  var noteInks = el('noteInks');
  var noteLabel = el('noteLabel');
  var noteText = el('noteText');

  /* --- opening a file ----------------------------------------------------- */

  function wireDrop() {
    var zone = el('drop');
    ['dragenter', 'dragover'].forEach(function (name) {
      zone.addEventListener(name, function (e) {
        e.preventDefault();
        zone.classList.add('over');
      });
    });
    ['dragleave', 'drop'].forEach(function (name) {
      zone.addEventListener(name, function (e) {
        e.preventDefault();
        zone.classList.remove('over');
      });
    });
    zone.addEventListener('drop', function (e) {
      var file = e.dataTransfer.files[0];
      if (file) open(file);
    });
    el('pick').addEventListener('click', function () { el('file').click(); });
    el('file').addEventListener('change', function () {
      if (this.files[0]) open(this.files[0]);
      this.value = '';
    });
    el('change').addEventListener('click', function () { el('file').click(); });
  }

  function open(file) {
    reset();
    el('noText').hidden = true;
    el('fileError').hidden = true;
    el('fileName').textContent = file.name;

    el('landing').hidden = true;
    el('app').hidden = false;
    el('progress').hidden = false;

    file.arrayBuffer().then(function (bytes) {
      return pdfjsLib.getDocument({ data: bytes }).promise;
    }).then(function (loaded) {
      doc = loaded;
      el('pageTotal').textContent = 'of ' + doc.numPages;
      el('pageNum').max = doc.numPages;
      return index();
    }).then(function () {
      el('progress').hidden = true;
      var written = book.reduce(function (n, page) { return n + page.text.length; }, 0);
      if (written < MIN_TEXT) { noTextLayer(); return; }
      shelve();
      layout();
      if (!rows.length) addRow();
      drawRows();
    }).catch(function (err) {
      el('progress').hidden = true;
      fail('That PDF could not be opened', err.message);
    });
  }

  function reset() {
    if (watcher) { watcher.disconnect(); watcher = null; }
    live.forEach(function (r) { if (r.task) r.task.cancel(); });
    live.clear();
    seen.clear();
    if (doc) doc.destroy();
    doc = null;
    book = [];
    shells = [];
    scales = [];
    vocab = new Map();
    notes = [];
    stray = [];
    shelf = null;
    labels = {};
    lit = null;
    closeNote();
    selBar.hidden = true;
    el('pages').textContent = '';
    el('density').textContent = '';
  }

  function fail(what, why) {
    var warn = el('fileError');
    warn.querySelector('h2').textContent = what;
    warn.querySelector('p').textContent = why;
    el('app').hidden = true;
    el('landing').hidden = false;
    warn.hidden = false;
    reset();
  }

  function noTextLayer() {
    el('app').hidden = true;
    el('landing').hidden = false;
    el('noText').hidden = false;
    reset();
  }

  /*
   * Once through the book, before the first search. Nothing is recognised here,
   * the text layer is already in the file, so this is reading rather than work.
   */
  function index() {
    var step = function (n) {
      if (n > doc.numPages) return Promise.resolve();
      return doc.getPage(n).then(function (page) {
        var view = page.getViewport({ scale: 1 });
        return page.getTextContent().then(function (content) {
          var built = IndexCore.buildPage(fromCorner(content.items, page));
          book.push({ text: built.text, src: built.src, width: view.width, height: view.height });
          MatchCore.addWords(built.text, vocab);
          page.cleanup();
          el('progressBar').style.width = Math.round(n / doc.numPages * 100) + '%';
          return step(n + 1);
        });
      });
    };
    return step(1);
  }

  // a cropped page's box need not start at the origin, and everything drawn is measured from its corner
  function fromCorner(items, page) {
    var x0 = page.view[0];
    var y0 = page.view[1];
    if (!x0 && !y0) return items;
    return items.map(function (item) {
      if (!item.transform) return item;
      var t = item.transform;
      return Object.assign({}, item, { transform: [t[0], t[1], t[2], t[3], t[4] - x0, t[5] - y0] });
    });
  }

  // where a browser font puts its baseline in a box one line high, so the invisible text sits on the printed text
  function baseline(family) {
    if (!baselines.has(family)) {
      var pen = document.createElement('canvas').getContext('2d');
      pen.font = '100px ' + family;
      var metrics = pen.measureText('');
      var up = metrics.fontBoundingBoxAscent / 100;
      var down = metrics.fontBoundingBoxDescent / 100;
      baselines.set(family, up ? (1 + up - down) / 2 : ASCENT);
    }
    return baselines.get(family);
  }

  /* --- the pages ---------------------------------------------------------- */

  /*
   * The width the book is mostly set in, which the odd landscape plate must not
   * be allowed to speak for.
   */
  function usualWidth() {
    var tally = new Map();
    var best = book[0].width;
    var most = 0;
    book.forEach(function (page) {
      var key = Math.round(page.width);
      var n = (tally.get(key) || 0) + 1;
      tally.set(key, n);
      if (n > most) { most = n; best = page.width; }
    });
    return best;
  }

  function layout() {
    var host = el('pages');
    closeNote();
    selBar.hidden = true;
    host.textContent = '';
    // back in at once, and first, so a lookup by id still finds them and .page:last-child stays the last page
    host.appendChild(selBar);
    host.appendChild(noteBox);
    shells = [];
    host.classList.toggle('two', spread);
    var room = host.clientWidth - 36;
    var each = spread ? (room - SPREAD_GAP) / 2 : room;
    fit = Math.min(MAX_SCALE, each / usualWidth());
    scale = zoom === null ? fit : zoom;
    el('zoomLabel').textContent = zoom === null ? 'Fit' : Math.round(scale * 100) + '%';

    /*
     * A map or a plate is wider than the page the book is set in. Fitting that
     * one page down keeps it whole without shrinking every page of text to the
     * width of the widest thing in the volume.
     */
    scales = book.map(function (page) {
      return zoom === null ? Math.min(scale, each / page.width) : scale;
    });

    var pair = null;
    book.forEach(function (page, i) {
      var shell = document.createElement('div');
      shell.className = 'page';
      shell.style.width = Math.round(page.width * scales[i]) + 'px';
      shell.style.height = Math.round(page.height * scales[i]) + 'px';
      shell.dataset.page = i;
      var marks = document.createElement('div');
      marks.className = 'marks';
      shell.appendChild(marks);
      if (!spread) {
        host.appendChild(shell);
      } else {
        // a row of its own per pair: a wide plate elsewhere in the book then
        // cannot push every right-hand page away from the spine
        if (i % 2 === 0) {
          pair = document.createElement('div');
          pair.className = 'spread';
          host.appendChild(pair);
        }
        pair.appendChild(shell);
      }
      shells.push(shell);
    });

    watcher = new IntersectionObserver(onView, { root: host, rootMargin: '400px 0px' });
    shells.forEach(function (shell) { watcher.observe(shell); });
  }

  function onView(entries) {
    entries.forEach(function (entry) {
      var i = Number(entry.target.dataset.page);
      if (entry.isIntersecting) { seen.add(i); render(i); } else { seen.delete(i); }
    });
    release();
  }

  function render(i) {
    if (live.has(i) || !doc) return;
    var shell = shells[i];
    var canvas = document.createElement('canvas');
    var view = { width: book[i].width * scales[i], height: book[i].height * scales[i] };
    var ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(view.width * ratio);
    canvas.height = Math.round(view.height * ratio);
    canvas.style.width = Math.round(view.width) + 'px';
    canvas.style.height = Math.round(view.height) + 'px';
    shell.insertBefore(canvas, shell.firstChild);

    var entry = { canvas: canvas, task: null, layer: null, glyphs: null };
    live.set(i, entry);

    doc.getPage(i + 1).then(function (page) {
      if (live.get(i) !== entry) return;
      entry.task = page.render({
        canvasContext: canvas.getContext('2d'),
        viewport: page.getViewport({ scale: scales[i] * ratio }),
      });
      return entry.task.promise.then(function () {
        entry.task = null;
        return glyphLayer(i, page);
      });
    }).catch(function () { /* a cancelled render is the ordinary case here */ });
  }

  /*
   * The same glyphs the canvas shows, laid out invisibly in real text, so a
   * range over them can be measured. Each run is squeezed to the width the PDF
   * gives it, which is what pdf.js does for its own text layer.
   */
  function glyphLayer(i, page) {
    var entry = live.get(i);
    return page.getTextContent().then(function (content) {
      if (live.get(i) !== entry) return;
      var layer = document.createElement('div');
      layer.className = 'glyphs';
      entry.glyphs = [];

      var here = scales[i];
      var before = null;
      var items = fromCorner(content.items, page);
      items.forEach(function (item, n) {
        if (!item.str) { entry.glyphs.push(null); return; }
        var size = (item.height || 10) * here;
        var span = document.createElement('span');
        var style = content.styles[item.fontName];
        var family = (style && style.fontFamily) || 'serif';
        span.textContent = item.str;
        span.style.fontFamily = family;
        span.style.fontSize = size + 'px';
        span.style.left = (item.transform[4] * here) + 'px';
        span.style.top = ((book[i].height - item.transform[5]) * here - size * baseline(family)) + 'px';

        /*
         * What a copy needs and the boxes do not: where the lines and words
         * end. It has to stay out of the flow like everything else here. A
         * plain text node or a br would lay itself out down the left edge, and
         * a drag that ended over that column, rather than over a glyph, would
         * run the selection to the end of it.
         */
        if (before) {
          var height = Math.max(before.h, item.height || 10);
          var broke = Math.abs(item.transform[5] - before.y) > height * 0.5;
          var apart = item.transform[4] - before.x1 > before.charW * 0.25;
          // a run that already ends in a space, or one that opens with it, has
          // the gap written into it: adding another gives the copy two
          var spaced = before.space || /^\s/.test(item.str);
          if (broke || (apart && !spaced)) {
            var gap = document.createElement('span');
            gap.className = 'gap';
            gap.textContent = broke ? '\n' : ' ';
            layer.appendChild(gap);
          }
        }

        layer.appendChild(span);
        entry.glyphs.push(span);
        before = {
          x1: item.transform[4] + item.width,
          y: item.transform[5],
          h: item.height || 10,
          charW: (item.width || size) / item.str.length,
          space: /\s$/.test(item.str),
        };
      });

      shells[i].appendChild(layer);
      entry.layer = layer;
      items.forEach(function (item, n) {
        var span = entry.glyphs[n];
        if (!span || !item.width) return;
        var drawn = span.offsetWidth;
        if (drawn) span.style.transform = 'scaleX(' + (item.width * here / drawn) + ')';
      });
      paint(i);
    });
  }

  /*
   * Counting pages from the top one is not enough on its own: two pages to a
   * row puts six on the screen at a low zoom, and a page still in view would be
   * wiped. What the eye can see is kept whatever its number says.
   */
  function release() {
    var middle = topPage();
    live.forEach(function (entry, i) {
      if (seen.has(i) || Math.abs(i - middle) <= KEEP_RENDERED) return;
      if (entry.task) entry.task.cancel();
      if (entry.canvas.parentNode) entry.canvas.parentNode.removeChild(entry.canvas);
      if (entry.layer && entry.layer.parentNode) entry.layer.parentNode.removeChild(entry.layer);
      live.delete(i);
    });
  }

  function topPage() {
    var host = el('pages');
    var y = host.scrollTop;
    for (var i = 0; i < shells.length; i++) {
      if (shells[i].offsetTop + shells[i].offsetHeight > y) return i;
    }
    return 0;
  }

  function onScroll() {
    el('pageNum').value = topPage() + 1;
  }

  function goTo(i) {
    if (!shells.length) return;
    var n = Math.max(0, Math.min(shells.length - 1, i));
    el('pages').scrollTop = shells[n].offsetTop;
  }

  /* --- the rows ----------------------------------------------------------- */

  function addRow() {
    rows.push({
      id: nextId++,
      color: PALETTE[(rows.length) % PALETTE.length],
      mode: 'start',
      terms: [''],
      on: true,
      hits: [],
    });
    drawRows();
  }

  function recount(row) {
    row.hits = book.map(function (page) {
      var found = [];
      row.terms.forEach(function (term) {
        var folded = IndexCore.foldText(term);
        if (!folded) return;
        MatchCore.findAll(page.text, folded, row.mode).forEach(function (hit) { found.push(hit); });
      });
      found.sort(function (a, b) { return a.start - b.start; });
      return found;
    });
    row.at = -1;
  }

  function total(row) {
    return row.hits.reduce(function (n, page) { return n + page.length; }, 0);
  }

  function drawRows() {
    var host = el('rows');
    host.textContent = '';
    rows.forEach(function (row) {
      if (book.length && !row.hits.length) recount(row);
      host.appendChild(rowNode(row));
    });
    paintAll();
    drawDensity();
  }

  function rowNode(row) {
    var node = document.createElement('div');
    node.className = 'row' + (row.on ? '' : ' off');
    node.dataset.row = row.id;

    var swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'swatch';
    swatch.style.background = row.color;
    swatch.title = 'Change the colour';
    swatch.addEventListener('click', function () {
      picker.hidden = !picker.hidden;
    });

    var term = document.createElement('input');
    term.type = 'text';
    term.className = 'term';
    term.value = row.terms[0];
    term.placeholder = 'a term, as it is written';
    // through the row on screen now, which a redraw may have replaced meanwhile
    var settle = debounce(function () {
      recount(row);
      var onScreen = document.querySelector('.row[data-row="' + row.id + '"]');
      if (onScreen) {
        onScreen.querySelector('.count').textContent = total(row);
        onScreen.querySelectorAll('.walk button, .listing').forEach(function (one) { one.disabled = !total(row); });
        fillSuggestions(row, onScreen.querySelector('.suggest'));
      }
      paintAll();
      drawDensity();
    }, 200);

    // the typing lands at once and only the counting waits, so a redraw that
    // arrives mid-word still shows the word
    term.addEventListener('input', function () {
      row.terms[0] = term.value;
      settle();
    });

    var count = document.createElement('span');
    count.className = 'count';
    count.textContent = total(row);

    var under = document.createElement('div');
    under.className = 'under';

    var mode = document.createElement('select');
    [['start', 'starts with'], ['word', 'whole word'], ['any', 'anywhere']].forEach(function (pair) {
      var option = document.createElement('option');
      option.value = pair[0];
      option.textContent = pair[1];
      if (row.mode === pair[0]) option.selected = true;
      mode.appendChild(option);
    });
    mode.addEventListener('change', function () {
      row.mode = mode.value;
      recount(row);
      count.textContent = total(row);
      node.querySelectorAll('.walk button, .listing').forEach(function (one) { one.disabled = !total(row); });
      paintAll();
      drawDensity();
    });

    var show = document.createElement('label');
    show.className = 'check';
    var box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = row.on;
    box.addEventListener('change', function () {
      row.on = box.checked;
      node.classList.toggle('off', !row.on);
      paintAll();
      drawDensity();
    });
    show.appendChild(box);
    show.appendChild(document.createTextNode('show'));

    var drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'link';
    drop.textContent = 'remove';
    drop.addEventListener('click', function () {
      rows = rows.filter(function (other) { return other !== row; });
      drawRows();
    });

    under.appendChild(mode);
    under.appendChild(show);
    under.appendChild(drop);

    var spellings = document.createElement('div');
    spellings.className = 'spellings';
    row.terms.slice(1).forEach(function (extra, at) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.textContent = extra + ' ×';
      chip.title = 'Drop this spelling';
      chip.addEventListener('click', function () {
        row.terms.splice(at + 1, 1);
        recount(row);
        drawRows();
      });
      spellings.appendChild(chip);
    });

    var more = document.createElement('button');
    more.type = 'button';
    more.className = 'add';
    more.textContent = '+ spelling';
    more.title = 'Another spelling of this term, counted under the same colour';
    more.addEventListener('click', function () {
      var typed = document.createElement('input');
      var settled = false;

      // committing takes the input out of the page, which blurs it: only once
      function keep(text) {
        if (settled) return;
        settled = true;
        var wanted = text.trim();
        if (wanted) row.terms.push(wanted);
        recount(row);
        drawRows();
      }

      typed.type = 'text';
      typed.className = 'adding';
      typed.placeholder = 'another spelling';
      typed.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') keep(typed.value);
        if (e.key === 'Escape') keep('');
      });
      typed.addEventListener('blur', function () { keep(typed.value); });
      spellings.replaceChild(typed, more);
      typed.focus();
    });
    spellings.appendChild(more);

    var suggest = document.createElement('details');
    suggest.className = 'suggest';
    suggest.addEventListener('toggle', function () { row.open = suggest.open; });
    fillSuggestions(row, suggest);

    var picker = pickerNode(row, swatch);

    var walkers = document.createElement('div');
    walkers.className = 'walk';
    [['‹', -1, 'Previous mention of this term'], ['›', 1, 'Next mention of this term']]
      .forEach(function (one) {
        var arrow = document.createElement('button');
        arrow.type = 'button';
        arrow.textContent = one[0];
        arrow.title = one[2];
        arrow.disabled = !total(row);
        arrow.addEventListener('click', function () { jumpIn(row, one[1]); });
        walkers.appendChild(arrow);
      });

    var listing = document.createElement('button');
    listing.type = 'button';
    listing.className = 'listing';
    listing.textContent = '≡  List every mention';
    listing.title = 'Every mention of this term and its spellings, with its context';
    listing.disabled = !total(row);
    listing.addEventListener('click', function () { openFound(row); });

    var head = document.createElement('div');
    head.className = 'head';
    head.appendChild(swatch);
    head.appendChild(term);
    head.appendChild(count);
    head.appendChild(walkers);

    node.appendChild(head);
    node.appendChild(picker);
    node.appendChild(under);
    node.appendChild(listing);
    node.appendChild(spellings);
    node.appendChild(suggest);
    return node;
  }

  /*
   * Ten colours that stay legible over black type, and a hex box beside them,
   * because a set of names that has to be told apart at a glance is nobody's
   * business but the reader's.
   */
  function pickerNode(row, swatch) {
    var host = document.createElement('div');
    host.className = 'picker';
    host.hidden = true;

    var grid = document.createElement('div');
    grid.className = 'grid';
    var wells = [];

    var repaint = debounce(function () {
      paintAll();
      drawDensity();
    }, 80);

    /*
     * from is the control the colour came from, and it is the one control not
     * written back to: a wheel dragged live sends a stream of these, and setting
     * its own value underneath the pointer makes it jump.
     */
    function wear(color, from) {
      row.color = color;
      swatch.style.background = color;
      if (from !== 'hex') hex.value = color;
      if (from !== 'wheel') own.value = color;
      wells.forEach(function (well) {
        well.classList.toggle('on', well.dataset.color === color);
      });
      repaint();
    }

    PALETTE.forEach(function (color) {
      var well = document.createElement('button');
      well.type = 'button';
      well.dataset.color = color;
      well.style.background = color;
      well.title = color;
      well.addEventListener('click', function () { wear(color); });
      grid.appendChild(well);
      wells.push(well);
    });

    var line = document.createElement('div');
    line.className = 'own';

    var hex = document.createElement('input');
    hex.type = 'text';
    hex.value = row.color;
    hex.maxLength = 7;
    hex.spellcheck = false;
    hex.setAttribute('aria-label', 'Colour as hex');
    hex.addEventListener('input', function () {
      var typed = hex.value.trim();
      if (/^#[0-9a-fA-F]{6}$/.test(typed)) wear(typed.toLowerCase(), 'hex');
    });

    var own = document.createElement('input');
    own.type = 'color';
    own.value = row.color;
    own.setAttribute('aria-label', 'Colour');
    own.addEventListener('input', function () { wear(own.value, 'wheel'); });
    own.addEventListener('change', function () { wear(own.value, 'wheel'); });

    line.appendChild(hex);
    line.appendChild(own);
    host.appendChild(grid);
    host.appendChild(line);
    wells.forEach(function (well) {
      well.classList.toggle('on', well.dataset.color === row.color);
    });
    return host;
  }

  function fillSuggestions(row, host) {
    host.textContent = '';
    var seed = row.terms[0];
    if (!seed || !vocab.size) { host.hidden = true; return; }
    var offered = MatchCore.suggest(vocab, seed, { exclude: row.terms, limit: SUGGEST_SHOWN });
    if (!offered.length) { host.hidden = true; return; }
    host.hidden = false;
    host.open = !!row.open;

    var head = document.createElement('summary');
    head.textContent = offered.length === 1
      ? '1 other spelling in this book'
      : offered.length + ' other spellings in this book';
    host.appendChild(head);

    offered.forEach(function (one) {
      var line = document.createElement('label');
      var box = document.createElement('input');
      box.type = 'checkbox';
      box.addEventListener('change', function () {
        row.terms.push(one.word);
        recount(row);
        drawRows();
      });
      var name = document.createElement('span');
      name.textContent = one.word;
      var count = document.createElement('span');
      count.className = 'count';
      count.textContent = one.count;
      line.appendChild(box);
      line.appendChild(name);
      line.appendChild(count);
      host.appendChild(line);
    });
  }

  /* --- the paint ---------------------------------------------------------- */

  function paintAll() {
    shells.forEach(function (shell, i) { paint(i); });
    walk = [];
    rows.forEach(function (row) {
      if (!row.on) return;
      row.hits.forEach(function (found, i) {
        found.forEach(function (hit) {
          walk.push({ page: i, start: hit.start, end: hit.end, color: row.color });
        });
      });
    });
    walk.sort(function (a, b) { return a.page - b.page || a.start - b.start; });
    if (at >= walk.length) at = -1;
    tell();
    drawFound();
  }

  function tell() {
    el('hitInfo').textContent = !walk.length ? 'no hits'
      : (at < 0 ? walk.length + ' hits' : (at + 1) + ' / ' + walk.length);
    el('prevHit').disabled = el('nextHit').disabled = !walk.length;
  }

  function paint(i) {
    var marks = shells[i].querySelector('.marks');
    marks.textContent = '';
    var page = book[i];
    var here = scales[i];
    var glyphs = live.has(i) ? live.get(i).glyphs : null;
    var origin = glyphs ? shells[i].getBoundingClientRect() : null;

    function draw(start, end, color) {
      return IndexCore.spans(page, start, end).map(function (part) {
        var real = origin ? measure(glyphs[part.item], part, origin) : null;
        var mark = document.createElement('i');
        mark.style.background = color;
        mark.style.left = (real ? real.left : part.x * here) + 'px';
        mark.style.width = (real ? real.width : part.w * here) + 'px';
        mark.style.top = ((page.height - part.y - part.h * ASCENT) * here) + 'px';
        mark.style.height = (part.h * here) + 'px';
        marks.appendChild(mark);
        return mark;
      });
    }

    notes.forEach(function (note) {
      var part = NotesCore.onPage(note, i, page.text.length);
      if (!part) return;
      var drawn = draw(part.start, part.end, NotesCore.ink(note.ink).color);
      drawn.forEach(function (mark) {
        mark.className = note.id === lit ? 'note now' : 'note';
        mark.dataset.note = note.id;
      });
      var last = drawn[drawn.length - 1];
      if (!last || i !== note.endPage || !note.comment.trim()) return;
      var pin = document.createElement('b');
      pin.className = 'pin';
      pin.style.left = (parseFloat(last.style.left) + parseFloat(last.style.width)) + 'px';
      pin.style.top = last.style.top;
      marks.appendChild(pin);
    });

    rows.forEach(function (row) {
      if (!row.on || !row.hits[i]) return;
      row.hits[i].forEach(function (hit) {
        draw(hit.start, hit.end, row.color).forEach(function (mark) { mark.dataset.start = hit.start; });
      });
    });
  }

  /*
   * How wide the name really is. The even split across a fragment is only an
   * estimate, and on a fragment that holds a whole line it is a bad one: a
   * capital M is twice an i. So where the page is drawn, the glyphs are
   * measured in the browser instead, and only the horizontal reading is taken.
   */
  function measure(span, part, origin) {
    if (!span || !span.firstChild) return null;
    var range = document.createRange();
    try {
      range.setStart(span.firstChild, part.from);
      range.setEnd(span.firstChild, Math.min(part.to, span.firstChild.length));
    } catch (err) {
      return null;
    }
    var box = range.getBoundingClientRect();
    if (!box.width) return null;
    return { left: box.left - origin.left, width: box.width };
  }

  /*
   * Hit to hit through the book, in reading order, whichever rows are showing.
   */
  function jump(step) {
    if (!walk.length) return;
    at = (at + step + walk.length) % walk.length;
    goToHit(walk[at]);
  }

  /* The same walk, but down one term only, which is what a term row asks for. */
  function jumpIn(row, step) {
    var mine = mentions(row);
    if (!mine.length) return;
    row.at = ((row.at === undefined ? -1 : row.at) + step + mine.length) % mine.length;
    goToHit(mine[row.at]);
  }

  /* Every hit of one row, its added spellings among them, in reading order. */
  function mentions(row) {
    var mine = [];
    row.hits.forEach(function (found, i) {
      found.forEach(function (hit) {
        mine.push({ page: i, start: hit.start, end: hit.end, color: row.color });
      });
    });
    return mine;
  }

  function reveal(n, start) {
    var page = book[n];
    var high = 0;
    for (var i = start; i < page.src.length; i++) {
      if (page.src[i]) { high = (page.height - page.src[i].y - page.src[i].h) * scales[n]; break; }
    }
    el('pages').scrollTop = shells[n].offsetTop + high - el('pages').clientHeight / 3;
  }

  function unlight() {
    lit = null;
    document.querySelectorAll('.marks i.now').forEach(function (mark) { mark.classList.remove('now'); });
  }

  function goToHit(hit) {
    reveal(hit.page, hit.start);
    unlight();
    shells[hit.page].querySelectorAll('.marks i').forEach(function (mark) {
      if (Number(mark.dataset.start) === hit.start) mark.classList.add('now');
    });

    // the bar counts every showing hit, so a walk down one term still moves it
    at = walk.findIndex(function (one) {
      return one.page === hit.page && one.start === hit.start;
    });
    markFound(hit);
    tell();
  }

  /*
   * Every mention in one list, the way a word processor shows what it found:
   * half a line either side, the page it is on, and the colour of the term it
   * belongs to. Reading them here beats scrolling for them.
   */
  // the list may be showing one term while the walk counts them all, so the
  // line to mark is found by where it is in the book, not by its number
  function openFound(row) {
    var panel = el('found');
    var same = panel.hidden ? false : scope === (row || null);
    scope = row || null;
    panel.hidden = same;
    if (!panel.hidden) showNotes(false);
    el('listAll').classList.toggle('on', !panel.hidden && !scope);
    refit();
  }

  function markFound(hit) {
    if (el('found').hidden) return;
    var here = hit || walk[at];
    var lines = el('foundList').children;
    var mark = -1;
    if (here) {
      for (var n = 0; n < shown.length; n++) {
        if (shown[n].page === here.page && shown[n].start === here.start) { mark = n; break; }
      }
    }
    for (var i = 0; i < lines.length; i++) lines[i].classList.toggle('on', i === mark);
    if (mark >= 0) lines[mark].scrollIntoView({ block: 'nearest' });
  }

  function drawFound() {
    if (el('found').hidden) return;
    if (scope && rows.indexOf(scope) < 0) scope = null;

    var host = el('foundList');
    host.textContent = '';
    shown = scope ? mentions(scope) : walk.slice();

    var what = shown.length === 1 ? '1 mention' : shown.length + ' mentions';
    el('foundCount').textContent = scope
      ? what + ' of ' + (scope.terms[0] || 'this term')
      : what;
    el('foundAll').hidden = !scope;

    shown.forEach(function (hit, n) {
      var page = book[hit.page];
      var line = listLine(hit.color, 'p. ' + (hit.page + 1), function () { goToHit(hit); });
      var said = line.querySelector('.said');
      said.appendChild(document.createTextNode(lead(page, hit)));
      var word = document.createElement('mark');
      word.textContent = IndexCore.original(page, hit.start, hit.end);
      said.appendChild(word);
      said.appendChild(document.createTextNode(trail(page, hit)));
      host.appendChild(line);
    });
    markFound();
  }

  function listLine(color, where, go) {
    var line = document.createElement('button');
    line.type = 'button';
    line.className = 'find';
    [['dot', ''], ['where', where], ['said', '']].forEach(function (part) {
      var span = document.createElement('span');
      span.className = part[0];
      span.textContent = part[1];
      line.appendChild(span);
    });
    line.querySelector('.dot').style.background = color;
    line.addEventListener('click', go);
    return line;
  }

  function lead(page, hit) {
    var from = Math.max(0, hit.start - CONTEXT);
    var text = IndexCore.original(page, from, hit.start);
    return from > 0 ? '…' + text.replace(/^\S*\s/, '') : text;
  }

  function trail(page, hit) {
    var to = Math.min(page.text.length, hit.end + CONTEXT);
    var text = IndexCore.original(page, hit.end, to);
    return to < page.text.length ? text.replace(/\s\S*$/, '') + '…' : text;
  }

  /*
   * The whole book down one strip. Two colours at the same height is a page
   * where two names meet, which is the thing worth opening.
   */
  function drawDensity() {
    var strip = el('density');
    strip.textContent = '';
    if (!book.length) return;
    rows.forEach(function (row) {
      if (!row.on) return;
      row.hits.forEach(function (found, i) {
        found.forEach(function (hit) {
          var tick = document.createElement('i');
          tick.style.background = row.color;
          tick.style.top = ((i + within(book[i], hit)) / book.length * 100) + '%';
          strip.appendChild(tick);
        });
      });
    });
  }

  function within(page, hit) {
    for (var i = hit.start; i < hit.end; i++) {
      var at = page.src[i];
      if (at) return Math.max(0, Math.min(1, 1 - at.y / page.height));
    }
    return 0.5;
  }

  /* --- highlights and comments --------------------------------------------- */

  // under the file's own fingerprint, so the same book opened again finds its notes
  function shelve() {
    shelf = 'research-pdf-reader:notes:' + doc.fingerprints[0];
    warned = false;
    var kept = [];
    try {
      kept = JSON.parse(localStorage.getItem(shelf) || '[]');
    } catch (err) { /* storage refused or unreadable: this book starts with none */ }
    try {
      labels = NotesCore.inkLabels(JSON.parse(localStorage.getItem(shelf + ':labels') || '{}'));
    } catch (err) { /* nor any labels */ }
    kept.forEach(function (raw) {
      var note = NotesCore.place(book, raw);
      if (note) notes.push(note); else stray.push(raw);
    });
    if (stray.length) say(plural(stray.length, 'kept note') + ' no longer match the text of this file. They are set aside, not deleted.');
    drawNotes();
  }

  function keep() {
    drawNotes();
    if (!shelf) return;
    try {
      if (notes.length || stray.length) localStorage.setItem(shelf, JSON.stringify(notes.concat(stray)));
      else localStorage.removeItem(shelf);
      if (Object.keys(labels).length) localStorage.setItem(shelf + ':labels', JSON.stringify(labels));
      else localStorage.removeItem(shelf + ':labels');
    } catch (err) {
      if (!warned) say('This browser will not keep your notes. Save them to a file from the Notes panel.');
      warned = true;
    }
  }

  function plural(n, word) {
    return n + ' ' + word + (n === 1 ? '' : 's');
  }

  function noteId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function textIndex(i, node, offset) {
    var entry = live.get(i);
    var span = node.nodeType === 3 ? node.parentNode : node;
    var n = entry.glyphs.indexOf(span);
    if (n >= 0) {
      var within = node.nodeType === 3 ? offset : (offset ? span.textContent.length : 0);
      return IndexCore.locate(book[i], n, within);
    }
    // a separator or the layer itself: the point sits before the next glyph along
    var next = node === entry.layer ? entry.layer.childNodes[offset] : span.nextSibling;
    while (next && entry.glyphs.indexOf(next) < 0) next = next.nextSibling;
    return next ? IndexCore.locate(book[i], entry.glyphs.indexOf(next), 0) : book[i].text.length;
  }

  function selection() {
    var picked = window.getSelection();
    if (!picked.rangeCount || picked.isCollapsed) return null;
    var range = picked.getRangeAt(0);
    var from = null;
    var to = null;
    Array.from(live.keys()).sort(function (a, b) { return a - b; }).forEach(function (i) {
      var layer = live.get(i).layer;
      if (!layer || !range.intersectsNode(layer)) return;
      var start = layer.contains(range.startContainer) ? textIndex(i, range.startContainer, range.startOffset) : 0;
      var end = layer.contains(range.endContainer) ? textIndex(i, range.endContainer, range.endOffset) : book[i].text.length;
      if (!from) from = { page: i, at: start };
      to = { page: i, at: end };
    });
    return from ? NotesCore.anchor(book, from, to) : null;
  }

  // in the scrolling pages rather than over them, so it travels with the words it belongs to
  function float(panel, x, y) {
    var host = el('pages');
    panel.hidden = false;
    var origin = host.getBoundingClientRect();
    var left = x - origin.left + host.scrollLeft - panel.offsetWidth / 2;
    var most = host.scrollLeft + host.clientWidth - panel.offsetWidth - 8;
    var below = y + 12 + panel.offsetHeight < origin.bottom;
    var top = below ? y + 12 : y - 12 - panel.offsetHeight;
    panel.style.left = Math.max(host.scrollLeft + 8, Math.min(most, left)) + 'px';
    panel.style.top = (top - origin.top + host.scrollTop) + 'px';
  }

  function noteAt(shell, x, y) {
    var found = null;
    shell.querySelectorAll('.marks i.note').forEach(function (mark) {
      var box = mark.getBoundingClientRect();
      if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) found = mark.dataset.note;
    });
    return found && notes.find(function (note) { return note.id === found; });
  }

  function repaint(note) {
    for (var i = note.page; i <= note.endPage; i++) paint(i);
  }

  function highlight(key) {
    if (!pending) return null;
    var note = Object.assign({ id: noteId(), ink: key, label: labels[key] || '', comment: '' }, pending);
    note.quote = NotesCore.quote(book, note);
    notes.push(note);
    ink = key;
    pending = null;
    window.getSelection().removeAllRanges();
    selBar.hidden = true;
    repaint(note);
    keep();
    return note;
  }

  function openNote(note, x, y) {
    opened = note;
    showInk(noteInks, note.ink);
    noteLabel.value = note.label;
    noteText.value = note.comment;
    selBar.hidden = true;
    float(noteBox, x, y);
    noteText.focus({ preventScroll: true });
  }

  function closeNote() {
    opened = null;
    noteBox.hidden = true;
  }

  function deleteNote() {
    var gone = opened;
    notes = notes.filter(function (note) { return note !== gone; });
    closeNote();
    repaint(gone);
    keep();
    say('Highlight deleted.', function () {
      notes.push(gone);
      repaint(gone);
      keep();
    });
  }

  function goToNote(note) {
    reveal(note.page, note.start);
    unlight();
    lit = note.id;
    document.querySelectorAll('.marks i[data-note="' + note.id + '"]').forEach(function (mark) {
      mark.classList.add('now');
    });
  }

  function showNotes(on) {
    el('notes').hidden = !on;
    el('notesOpen').classList.toggle('on', on);
    if (!on) return;
    el('found').hidden = true;
    scope = null;
    el('listAll').classList.remove('on');
    drawNotes();
  }

  function drawNotes() {
    if (el('notes').hidden) return;
    var host = el('notesList');
    host.textContent = '';
    var showing = notes.filter(function (note) {
      return (!notesInk || note.ink === notesInk) && (!notesLabel || note.label === notesLabel);
    }).sort(NotesCore.order);
    var all = plural(notes.length, 'note');
    el('notesCount').textContent = showing.length === notes.length ? all : showing.length + ' of ' + all;
    el('exportNotes').disabled = el('saveNotes').disabled = !notes.length;

    if (!notes.length) {
      var empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'Nothing marked yet. Select words on a page, then pick a colour ' +
        'to highlight them, or Comment to write a note beside them.';
      host.appendChild(empty);
    }

    showing.forEach(function (note) {
      var line = listLine(NotesCore.ink(note.ink).color, NotesCore.pages(note), function () { goToNote(note); });
      var label = NotesCore.label(note.label);
      if (label) {
        var tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = label.name;
        line.querySelector('.where').appendChild(tag);
      }
      line.querySelector('.said').textContent = note.quote;
      if (note.comment.trim()) {
        var remark = document.createElement('span');
        remark.className = 'remark';
        remark.textContent = note.comment.trim();
        line.appendChild(remark);
      }
      host.appendChild(line);
    });
  }

  function inkButtons(host, title, pick) {
    NotesCore.INKS.forEach(function (one) {
      var button = document.createElement('button');
      button.type = 'button';
      button.dataset.ink = one.key;
      button.style.background = one.color;
      button.title = title + ' ' + one.name.toLowerCase();
      button.addEventListener('click', function () { pick(one.key); });
      host.appendChild(button);
    });
  }

  function nameInks() {
    selBar.querySelectorAll('.inks button').forEach(function (button) {
      var label = NotesCore.label(labels[button.dataset.ink]);
      button.title = 'Highlight in ' + NotesCore.ink(button.dataset.ink).name.toLowerCase() +
        (label ? ' · ' + label.name : '');
    });
  }

  function showInk(host, key) {
    host.querySelectorAll('button').forEach(function (button) {
      button.classList.toggle('on', button.dataset.ink === key);
    });
  }

  function labelOptions(select, none) {
    [{ key: '', name: none }].concat(NotesCore.LABELS).forEach(function (one) {
      var option = document.createElement('option');
      option.value = one.key;
      option.textContent = one.name;
      select.appendChild(option);
    });
  }

  function bookTitle() {
    return el('fileName').textContent.replace(/\.pdf$/i, '');
  }

  function saveNotes() {
    var kept = { version: 1, book: el('fileName').textContent, labels: labels, notes: notes.concat(stray) };
    download(JSON.stringify(kept, null, 2), bookTitle() + '.notes.json', 'application/json');
  }

  // added to what is here, never in place of it, so loading a colleague's file loses nothing of yours
  function loadNotes(file) {
    file.text().then(function (text) {
      var read = JSON.parse(text);
      if (!read || !Array.isArray(read.notes)) throw new Error('it is not a file of notes');
      labels = Object.assign(NotesCore.inkLabels(read.labels), labels);
      var have = new Set(notes.map(function (note) { return note.id; }));
      var added = 0;
      var missed = 0;
      read.notes.forEach(function (raw) {
        var note = NotesCore.place(book, raw);
        if (!note) { missed++; return; }
        if (have.has(note.id)) return;
        if (!note.id) note.id = noteId();
        have.add(note.id);
        notes.push(note);
        added++;
      });
      paintAll();
      keep();
      say(plural(added, 'note') + ' added' + (missed ? ', ' + missed + ' did not match this book' : '') + '.');
    }).catch(function (err) {
      say('That file of notes could not be read: ' + err.message + '.');
    });
  }

  function say(text, undo) {
    var toast = el('toast');
    toast.querySelector('span').textContent = text;
    var button = toast.querySelector('button');
    button.hidden = !undo;
    button.onclick = function () {
      toast.hidden = true;
      undo();
    };
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.hidden = true; }, 8000);
  }

  /* --- profiles ----------------------------------------------------------- */

  function saveProfile() {
    var kept = {
      version: 1,
      rows: rows.map(function (row) {
        return { color: row.color, mode: row.mode, terms: row.terms, on: row.on };
      }),
    };
    download(JSON.stringify(kept, null, 2), 'names.json', 'application/json');
  }

  function download(text, name, type) {
    var url = URL.createObjectURL(new Blob([text], { type: type }));
    var link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);
  }

  function loadProfile(file) {
    file.text().then(function (text) {
      var read = JSON.parse(text);
      if (!read || !Array.isArray(read.rows)) throw new Error('not a name set');
      rows = read.rows.map(function (row) {
        return {
          id: nextId++,
          color: row.color || PALETTE[0],
          mode: row.mode || 'start',
          terms: Array.isArray(row.terms) && row.terms.length ? row.terms : [''],
          on: row.on !== false,
          hits: [],
        };
      });
      drawRows();
    }).catch(function (err) {
      fail('That name set could not be read', err.message);
    });
  }

  /* --- wiring ------------------------------------------------------------- */

  function stepZoom(step) {
    if (!book.length) return;
    var here = scale;
    var wanted = null;
    if (step > 0) {
      for (var i = 0; i < LADDER.length; i++) {
        if (LADDER[i] > here + 0.001) { wanted = LADDER[i]; break; }
      }
    } else {
      for (var k = LADDER.length - 1; k >= 0; k--) {
        if (LADDER[k] < here - 0.001) { wanted = LADDER[k]; break; }
      }
    }
    if (wanted === null) return;
    zoom = wanted;
    refit();
  }

  function refit() {
    if (!book.length) return;
    var was = topPage();
    live.forEach(function (entry) { if (entry.task) entry.task.cancel(); });
    live.clear();
    seen.clear();
    layout();
    drawRows();
    goTo(was);
  }

  function debounce(fn, wait) {
    var timer = null;
    return function () {
      clearTimeout(timer);
      timer = setTimeout(fn, wait);
    };
  }

  wireDrop();
  el('pages').addEventListener('scroll', onScroll);
  el('addRow').addEventListener('click', addRow);
  el('help').addEventListener('click', function () { el('helpBox').showModal(); });
  el('helpClose').addEventListener('click', function () { el('helpBox').close(); });
  // a click on the backdrop lands on the dialog itself, never on what is inside it
  el('helpBox').addEventListener('click', function (e) {
    if (e.target === this) this.close();
  });
  el('toggleSide').addEventListener('click', function () {
    var away = el('side').classList.toggle('away');
    this.title = away ? 'Show the terms' : 'Hide the terms';
    refit();
  });
  el('prevHit').addEventListener('click', function () { jump(-1); });
  el('nextHit').addEventListener('click', function () { jump(1); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeNote(); selBar.hidden = true; }
    // in a comment the same keys select a word, which is what the writer wants
    if (!e.ctrlKey || !e.shiftKey || e.target === noteText) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); jump(1); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); jump(-1); }
  });
  el('spread').addEventListener('click', function () {
    spread = !spread;
    this.classList.toggle('on', spread);
    this.title = spread ? 'One page at a time' : 'Two pages side by side';
    refit();
  });
  el('listAll').addEventListener('click', function () { openFound(null); });
  el('foundAll').addEventListener('click', function () {
    scope = null;
    el('listAll').classList.add('on');
    drawFound();
  });
  el('foundClose').addEventListener('click', function () {
    el('found').hidden = true;
    scope = null;
    el('listAll').classList.remove('on');
    refit();
  });
  el('zoomIn').addEventListener('click', function () { stepZoom(1); });
  el('zoomOut').addEventListener('click', function () { stepZoom(-1); });
  el('zoomLabel').addEventListener('click', function () { zoom = null; refit(); });
  el('pages').addEventListener('wheel', function (e) {
    if (!e.ctrlKey) return;
    e.preventDefault();
    stepZoom(e.deltaY < 0 ? 1 : -1);
  }, { passive: false });

  // a picker is done with the moment the eye goes somewhere else
  document.addEventListener('mousedown', function (e) {
    document.querySelectorAll('.picker').forEach(function (open) {
      if (open.hidden || open.contains(e.target)) return;
      var mine = open.closest('.row');
      if (mine && mine.contains(e.target) && e.target.closest('.swatch')) return;
      open.hidden = true;
    });
  });

  el('prev').addEventListener('click', function () { goTo(topPage() - 1); });
  el('next').addEventListener('click', function () { goTo(topPage() + 1); });
  el('pageNum').addEventListener('change', function () { goTo(Number(this.value) - 1); });
  el('saveProfile').addEventListener('click', saveProfile);
  el('loadProfile').addEventListener('click', function () { el('profileFile').click(); });
  el('profileFile').addEventListener('change', function () {
    if (this.files[0]) loadProfile(this.files[0]);
    this.value = '';
  });
  el('density').addEventListener('click', function (e) {
    var box = this.getBoundingClientRect();
    goTo(Math.floor((e.clientY - box.top) / box.height * book.length));
  });

  el('pages').addEventListener('mousedown', function (e) {
    pressed = e.button === 0 && !selBar.contains(e.target) && !noteBox.contains(e.target);
  });
  document.addEventListener('mouseup', function (e) {
    if (!pressed) return;
    pressed = false;
    var shell = e.target instanceof Element && e.target.closest('.glyphs') ? e.target.closest('.page') : null;
    // the selection has only settled once the mouseup has run its course
    setTimeout(function () {
      pending = selection();
      if (pending) { closeNote(); nameInks(); float(selBar, e.clientX, e.clientY); return; }
      selBar.hidden = true;
      var note = shell && noteAt(shell, e.clientX, e.clientY);
      if (note) openNote(note, e.clientX, e.clientY);
    }, 0);
  });
  el('pages').addEventListener('mousemove', function (e) {
    var shell = !e.buttons && e.target.closest('.glyphs') ? e.target.closest('.page') : null;
    this.classList.toggle('over-note', !!shell && !!noteAt(shell, e.clientX, e.clientY));
  });
  document.addEventListener('mousedown', function (e) {
    if (!noteBox.hidden && !noteBox.contains(e.target)) closeNote();
    if (!selBar.hidden && !selBar.contains(e.target)) selBar.hidden = true;
  });

  // a press on the bar would otherwise take the selection away before the click lands
  selBar.addEventListener('mousedown', function (e) { e.preventDefault(); });
  inkButtons(el('selInks'), 'Highlight in', highlight);
  el('selComment').addEventListener('click', function () {
    var spot = selBar.getBoundingClientRect();
    var note = highlight(ink);
    if (note) openNote(note, spot.left + spot.width / 2, spot.top);
  });

  inkButtons(noteInks, 'Make it', function (key) {
    // a label that only came with the old colour gives way to the new colour's
    if (opened.label === (labels[opened.ink] || '')) opened.label = labels[key] || '';
    opened.ink = ink = key;
    noteLabel.value = opened.label;
    showInk(noteInks, key);
    repaint(opened);
    keep();
  });
  labelOptions(noteLabel, 'No label');
  noteLabel.addEventListener('change', function () {
    opened.label = labels[opened.ink] = this.value;
    keep();
  });
  noteText.addEventListener('input', function () {
    opened.comment = this.value;
    repaint(opened);
    keep();
  });
  el('noteDone').addEventListener('click', closeNote);
  el('noteDelete').addEventListener('click', deleteNote);

  el('notesOpen').addEventListener('click', function () {
    showNotes(el('notes').hidden);
    refit();
  });
  el('notesClose').addEventListener('click', function () {
    showNotes(false);
    refit();
  });
  inkButtons(el('notesInks'), 'Show only', function (key) {
    notesInk = notesInk === key ? null : key;
    showInk(el('notesInks'), notesInk);
    drawNotes();
  });
  labelOptions(el('notesLabel'), 'Any label');
  el('notesLabel').addEventListener('change', function () {
    notesLabel = this.value;
    drawNotes();
  });
  el('exportNotes').addEventListener('click', function () {
    download(NotesCore.markdown(bookTitle(), notes), bookTitle() + '.notes.md', 'text/markdown');
  });
  el('saveNotes').addEventListener('click', saveNotes);
  el('loadNotes').addEventListener('click', function () { el('notesFile').click(); });
  el('notesFile').addEventListener('change', function () {
    if (this.files[0]) loadNotes(this.files[0]);
    this.value = '';
  });
  window.addEventListener('resize', debounce(refit, 250));
})();
