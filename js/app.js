/* Cascade — UI: input, animation, persistence, archive, stats and sharing.
   Game rules live in engine.js; conventions (archive, grades, stats, share)
   follow Currents so the workshop's games behave alike. */
(() => {
  'use strict';

  const E = self.CascadeEngine;
  const $ = (id) => document.getElementById(id);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const pace = (ms) => (reduceMotion ? Math.min(ms, 120) : ms);

  const WEIGHT_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7a3 3 0 0 1 6 0"/><path d="M6.5 9h11l2 11h-15z"/></svg>';

  /* ---------------- Puzzle selection (by date) ----------------
     Day 0 = puzzle #1 = launch day. dayNumber() is today's index; activeDay is
     whichever day the player has open (today, or one picked from the archive). */
  const EPOCH = new Date(2026, 9, 27); // months are 0-based -> 9 = October
  const DAY = 86400000;
  const pad = (n) => String(n).padStart(2, '0');
  const dayNumber = () => Math.floor((new Date() - EPOCH) / DAY);
  const dateForDay = (day) => new Date(EPOCH.getFullYear(), EPOCH.getMonth(), EPOCH.getDate() + day);
  const keyForDay = (day) => {
    const d = dateForDay(day);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const dayForKey = (key) => {
    const [y, m, d] = key.split('-').map(Number);
    return Math.round((new Date(y, m - 1, d) - EPOCH) / DAY);
  };

  /* ---------------- Storage ---------------- */
  const SAVE_KEY = 'cascade_progress_v2';
  const STATS_KEY = 'cascade_stats';
  const DAILY_KEY = 'cascade_daily_v2';
  const SEEN_KEY = 'cascade_seen';
  const readJSON = (key, fallback) => {
    try { return JSON.parse(localStorage.getItem(key) || 'null') || fallback; } catch (e) { return fallback; }
  };
  const writeJSON = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage blocked — progress just won't persist */ }
  };

  /* ---------------- State ---------------- */
  let activeDay = 0;
  let puzzle = null; // { day, dateKey, salt, best, par, stars, start }
  let game = null; // { state, moves, log, hints, wildUsed, won, history, time }
  let path = [];
  let busy = false;
  let hintMove = null;
  let hintLevel = 0;
  let hintText = ''; // shown in the word card while idle, so the board never shifts
  let tutorialMode = false; // the practice board is up (see Walkthrough below)
  let tutStep = 0;
  const tileEls = new Map();

  const sigOf = (p) => `${E.fingerprint()}:${p.salt}`;
  const freshGame = () => ({ state: puzzle.start, moves: 0, log: [], hints: 0, wildUsed: false, won: false, history: [], time: 0 });
  const snapshot = () => ({ state: game.state, moves: game.moves, log: game.log, wildUsed: game.wildUsed });

  function saveState() {
    if (tutorialMode) return; // practice moves never touch a real day's save
    const all = readJSON(SAVE_KEY, {});
    all[activeDay] = { sig: sigOf(puzzle), ...game, time: elapsedNow() };
    writeJSON(SAVE_KEY, all);
  }
  function loadState(day) {
    const s = readJSON(SAVE_KEY, {})[day];
    return s && s.sig === sigOf(puzzle) && s.state ? s : null;
  }

  /**
   * Today's board is deterministic; cache only the seed + par so reloads skip the solver.
   * The cache is keyed to the rule fingerprint, so a rules change can never replay an old seed.
   */
  function puzzleForDay(day) {
    const dateKey = keyForDay(day);
    const cache = readJSON(DAILY_KEY, {});
    let meta = cache[dateKey];
    if (!meta || meta.v !== E.fingerprint()) {
      const built = E.buildDaily(dateKey);
      meta = { v: E.fingerprint(), salt: built.salt, best: built.best, par: built.par, stars: built.stars, solution: built.solution };
      cache[dateKey] = meta;
      writeJSON(DAILY_KEY, cache);
    }
    return { day, dateKey, ...meta, start: E.generate(dateKey, meta.salt) };
  }

  /* ---------------- Stats & streaks (Currents' schema) ---------------- */
  const GRADE_KEYS = [['eagle', 'Eagle'], ['birdie', 'Birdie'], ['par', 'Par'], ['bogey', 'Bogey'], ['over', 'Over']];
  function loadStats() {
    const s = readJSON(STATS_KEY, {});
    if (typeof s.played !== 'number') s.played = 0;
    if (typeof s.currentStreak !== 'number') s.currentStreak = 0;
    if (typeof s.maxStreak !== 'number') s.maxStreak = 0;
    if (typeof s.lastWonDay !== 'number') s.lastWonDay = -999;
    if (!s.dist || typeof s.dist !== 'object') s.dist = {};
    GRADE_KEYS.forEach(([k]) => { if (typeof s.dist[k] !== 'number') s.dist[k] = 0; });
    return s;
  }
  const gradeKey = (diff) => (diff <= -2 ? 'eagle' : diff === -1 ? 'birdie' : diff === 0 ? 'par' : diff === 1 ? 'bogey' : 'over');
  function gradeFor(diff) {
    if (diff <= -2) return ['EAGLE', 'var(--color-close)'];
    if (diff === -1) return ['BIRDIE', 'var(--color-correct)'];
    if (diff === 0) return ['PAR', 'var(--accent)'];
    if (diff === 1) return ['BOGEY', 'var(--ink-muted)'];
    return [`+${diff} OVER`, 'var(--color-far)'];
  }
  // Only today's puzzle feeds the streak; archive solves are just for fun.
  function recordWin(diff) {
    if (activeDay !== dayNumber()) return;
    const s = loadStats();
    const day = dayNumber();
    if (s.lastWonDay === day) return;
    s.currentStreak = s.lastWonDay === day - 1 ? s.currentStreak + 1 : 1;
    s.maxStreak = Math.max(s.maxStreak, s.currentStreak);
    s.played++;
    s.dist[gradeKey(diff)]++;
    s.lastWonDay = day;
    writeJSON(STATS_KEY, s);
  }
  function renderStats(prefix, s, curKey) {
    $(prefix + 'Played').textContent = s.played;
    $(prefix + 'Streak').textContent = s.currentStreak;
    $(prefix + 'Max').textContent = s.maxStreak;
    const max = Math.max(1, ...GRADE_KEYS.map(([k]) => s.dist[k] || 0));
    $(prefix + 'Dist').innerHTML = s.played === 0
      ? '<div class="sempty">Solve today\'s puzzle to start your distribution.</div>'
      : GRADE_KEYS.map(([k, l]) => {
        const n = s.dist[k] || 0;
        const w = Math.max(10, (n / max) * 100);
        return `<div class="gd${k === curKey ? ' cur' : ''}"><span class="gl">${l}</span><div class="gb" style="width:${w}%">${n}</div></div>`;
      }).join('');
  }

  /* ---------------- Clock (as in Typeset) ----------------
     Runs while the board is on screen and unsolved; pauses while the tab is hidden.
     Undo and reset never rewind it, so the time a solve took is the leaderboard's tiebreak. */
  let runningSince = 0;
  const elapsedNow = () => (game ? game.time || 0 : 0) + (runningSince ? Date.now() - runningSince : 0);
  function startClock() { if (game && !tutorialMode && !game.won && !runningSince && !document.hidden) runningSince = Date.now(); }
  function pauseClock() { if (runningSince) { game.time = (game.time || 0) + Date.now() - runningSince; runningSince = 0; } }
  const fmtTime = (sec) => `${Math.floor(sec / 60)}:${pad(sec % 60)}`;
  function renderClock() {
    const txt = fmtTime(Math.floor(elapsedNow() / 1000));
    if ($('clock').textContent !== txt) $('clock').textContent = txt;
  }
  setInterval(() => { if (runningSince) renderClock(); }, 250);
  let resumeOnReturn = false;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { resumeOnReturn = !!runningSince; if (runningSince) { pauseClock(); saveState(); } }
    else if (resumeOnReturn) { resumeOnReturn = false; startClock(); }
  });
  window.addEventListener('pagehide', () => { if (runningSince) { pauseClock(); saveState(); } });

  /* ---------------- Rendering ---------------- */
  function kindOf(t) {
    if (t.t === E.WEIGHT) return 'weight';
    if (t.t === E.STONE) return 'stone';
    if (t.t === E.WILD) return 'wild';
    return E.isVowel(t) ? 'vowel' : 'consonant';
  }

  function makeTile(t) {
    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.dataset.kind = kindOf(t);
    const face = document.createElement('div');
    face.className = 'face';
    if (t.t === E.LETTER) face.textContent = t.ch;
    else if (t.t === E.WILD) face.textContent = '?';
    else if (t.t === E.WEIGHT) face.innerHTML = WEIGHT_SVG;
    tile.setAttribute('aria-label', t.t === E.LETTER ? t.ch : kindOf(t));
    tile.appendChild(face);
    face.addEventListener('animationend', (e) => {
      if (e.animationName === 'enter' || e.animationName === 'appear') tile.classList.remove('enter', 'appear');
    });
    tile.addEventListener('transitionend', (e) => {
      if (e.propertyName === 'transform' && tile.classList.contains('sinking') && !reduceMotion) {
        face.classList.remove('land');
        void face.offsetWidth;
        face.classList.add('land');
      }
    });
    return tile;
  }

  const place = (tile, r, c) => {
    tile.style.setProperty('--r', r);
    tile.style.setProperty('--c', c);
    tile.dataset.r = r;
    tile.dataset.c = c;
  };

  /** Sync the DOM to a board. Moved tiles animate; returns the longest move in ms. */
  function renderTiles(cells, { enter = false } = {}) {
    const present = new Set();
    let longest = 0;
    cells.forEach((t, i) => {
      if (!t) return;
      present.add(t.id);
      const r = E.row(i);
      const c = E.col(i);
      let tile = tileEls.get(t.id);
      if (!tile) {
        tile = makeTile(t);
        tileEls.set(t.id, tile);
        place(tile, r, c);
        tile.classList.add(enter ? 'enter' : 'appear');
        if (enter) tile.style.setProperty('--delay', `${(E.ROWS - 1 - r) * 45 + c * 20}ms`);
        $('tiles').appendChild(tile);
        return;
      }
      const pr = Number(tile.dataset.r);
      const pc = Number(tile.dataset.c);
      if (pr !== r || pc !== c) {
        const dur = pace(160 + (Math.abs(r - pr) + Math.abs(c - pc)) * 70);
        longest = Math.max(longest, dur);
        tile.style.setProperty('--dur', `${dur}ms`);
        tile.classList.toggle('sinking', r > pr);
        tile.classList.toggle('rising', r < pr);
        tile.classList.toggle('sliding', r === pr);
        place(tile, r, c);
      }
    });
    for (const [id, tile] of tileEls) {
      if (!present.has(id)) {
        tile.remove();
        tileEls.delete(id);
      }
    }
    return longest;
  }

  const tileAt = (i) => (game.state.cells[i] ? tileEls.get(game.state.cells[i].id) : null);
  const tilesById = (ids) => ids.map((id) => tileEls.get(id)).filter(Boolean);

  function renderWells() {
    const wells = $('wells');
    wells.innerHTML = '';
    for (let i = 0; i < E.SIZE; i++) {
      const s = document.createElement('span');
      if (E.row(i) === E.FLOOR) s.className = 'floor';
      wells.appendChild(s);
    }
  }

  function renderChutes(queue) {
    $('chutes').innerHTML = queue.map((q) => {
      if (!q.length) return '<div class="chute"><span class="empty">—</span></div>';
      return `<div class="chute">${q.slice(0, 2).map((t) =>
        `<i class="${E.isVowel(t) ? 'vw' : ''}">${t.ch}</i>`).join('')}</div>`;
    }).join('');
  }

  /** Per-column floaters vs sinkers under each weight. */
  function columnCounts(cells, c) {
    let up = 0;
    let dn = 0;
    for (let r = 0; r < E.FLOOR; r++) {
      const t = cells[r * E.COLS + c];
      if (t) { if (E.isBuoyant(t)) up++; else dn++; }
    }
    return { up, dn };
  }
  let lastMeter = [];
  function renderMeters(cells) {
    const html = [];
    const now = [];
    for (let c = 0; c < E.COLS; c++) {
      const w = cells[E.FLOOR * E.COLS + c];
      if (!w || w.t !== E.WEIGHT) { html.push('<div class="meter"></div>'); now.push(''); continue; }
      const { up, dn } = columnCounts(cells, c);
      const key = `${up}:${dn}`;
      now.push(key);
      const close = up === dn ? ' close' : '';
      const bump = lastMeter[c] && lastMeter[c] !== key ? ' bump' : '';
      html.push(`<div class="meter${close}${bump}" title="Vowels ${up} · consonants ${dn}"><span class="up">▲${up}</span><span class="dn">▼${dn}</span></div>`);
    }
    lastMeter = now;
    $('meters').innerHTML = html.join('');
    setTimeout(() => $('meters').querySelectorAll('.bump').forEach((m) => m.classList.remove('bump')), 220);
  }

  function renderHud() {
    const dropped = 3 - E.countWeights(game.state.cells);
    $('moves').textContent = game.moves;
    $('par').textContent = puzzle.par;
    $('weights').textContent = `${dropped}/3`;
    $('moves').parentElement.classList.toggle('over', game.moves > puzzle.par);
    $('undoBtn').disabled = busy || tutorialMode || game.won || !game.history.length;
    $('resetBtn').disabled = busy || tutorialMode || game.won || (!game.moves && !game.history.length);
    $('hintBtn').disabled = busy || tutorialMode || game.won;
    renderClock();
  }

  const DIFF_LABELS = ['', 'Very Easy', 'Easy', 'Medium', 'Hard', 'Expert'];
  function renderHeader() {
    if (tutorialMode) {
      $('dateLabel').textContent = 'Walkthrough · practice board';
      $('difficulty').textContent = 'Practice';
      return;
    }
    const today = dayNumber();
    const d = dateForDay(activeDay).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    $('dateLabel').textContent = `#${activeDay + 1} · ${d}${activeDay !== today ? ' · Archive' : ''}`;
    $('difficulty').innerHTML = `<span class="stars">${'★'.repeat(puzzle.stars)}${'☆'.repeat(5 - puzzle.stars)}</span> ${DIFF_LABELS[puzzle.stars]}`;
  }

  /* ---------------- Word line ---------------- */
  function showIdle() {
    const line = $('wordLine');
    line.className = 'word-line';
    line.innerHTML = game.won
      ? `<span class="ph">${tutorialMode ? 'Practice board cleared.' : 'All three weights dropped. See you tomorrow.'}</span>`
      : hintText
        ? `<span class="msg gd">${hintText}</span>`
        : '<span class="ph">Drag across touching letters to spell a word</span>';
  }
  function showMessage(text, kind = '') {
    const line = $('wordLine');
    line.className = 'word-line';
    line.innerHTML = `<span class="msg ${kind}">${text}</span>`;
  }

  function metrics() {
    const rect = $('grid').getBoundingClientRect();
    const gap = parseFloat(getComputedStyle($('stage')).getPropertyValue('--gap')) || 6;
    const step = (rect.width + gap) / E.COLS;
    return { rect, step, cell: step - gap };
  }

  function renderPath() {
    for (const tile of tileEls.values()) tile.classList.remove('in-path', 'ok');
    const overlay = $('overlay');
    if (!path.length) {
      $('trace').setAttribute('points', '');
      overlay.classList.remove('ok');
      showIdle();
      return;
    }
    const letters = E.pathLetters(game.state.cells, path);
    const word = E.matchWord(letters);
    for (const i of path) {
      const tile = tileAt(i);
      tile.classList.add('in-path');
      if (word) tile.classList.add('ok');
    }
    const { cell, step } = metrics();
    $('trace').setAttribute('points', path.map((i) => `${E.col(i) * step + cell / 2},${E.row(i) * step + cell / 2}`).join(' '));
    overlay.classList.toggle('ok', !!word);

    const shown = word || letters.join('');
    const line = $('wordLine');
    line.className = `word-line${word ? ' ok' : ''}`;
    line.innerHTML = `<span class="w">${[...shown].map((ch, k) => (letters[k] === '?' ? `<span class="wc">${ch}</span>` : ch)).join('')}</span>` +
      (letters.includes('?') ? '<span class="tag">Wildcard · +1 move</span>' : '');
  }

  /* ---------------- Toast & effects ---------------- */
  let toastTimer;
  function toast(msg, bad) {
    const t = $('toast');
    t.textContent = msg;
    t.className = `toast show${bad ? ' bad' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = 'toast'; }, 1800);
  }

  function floatLabel(tiles, text, kind = '', host = $('tiles')) {
    if (!tiles.length) return;
    let r = 0;
    let c = 0;
    for (const t of tiles) { r += Number(t.dataset.r); c += Number(t.dataset.c); }
    const f = document.createElement('div');
    f.className = `float ${kind}`;
    f.style.setProperty('--r', r / tiles.length);
    f.style.setProperty('--c', c / tiles.length);
    f.innerHTML = `<span>${text}</span>`;
    host.appendChild(f);
    setTimeout(() => f.remove(), 1000);
  }

  function popTiles(ids, cls) {
    for (const tile of tilesById(ids)) {
      tile.classList.remove('in-path', 'ok', 'zap', 'hint-lane');
      tile.firstChild.classList.add(cls);
    }
  }

  /* ---------------- Hint (as in Currents: glow where to go next) ---------------- */
  function clearHint() {
    hintMove = null;
    hintLevel = 0;
    hintText = '';
    for (const tile of tileEls.values()) tile.classList.remove('hint-lane');
  }
  function showHintText(text) {
    hintText = text;
    if (!path.length) showIdle();
  }
  function showMoveHint() {
    if (busy || tutorialMode || game.won) return;
    if (!hintMove) {
      showHintText('Looking for a way through…');
      setTimeout(() => {
        hintMove = E.hint(game.state);
        if (!hintMove) {
          showHintText('No clear route from here. Try Undo.');
          return;
        }
        hintLevel = 0;
        stepHint();
      }, 30);
      return;
    }
    stepHint();
  }
  function stepHint() {
    if (hintLevel >= 2) return; // the word is already showing; another tap mustn't cost a point
    hintLevel++;
    game.hints++;
    saveState();
    const lit = hintLevel === 1 ? hintMove.path.slice(0, 1) : hintMove.path;
    for (const tile of tileEls.values()) tile.classList.remove('hint-lane');
    lit.forEach((i) => tileAt(i) && tileAt(i).classList.add('hint-lane'));
    showHintText(hintLevel === 1
      ? `Start a ${hintMove.word.length}-letter word on the glowing tile. Tap Hint again to see it.`
      : `Try ${hintMove.word}.`);
  }

  /* ---------------- Input ---------------- */
  function hitTest(e, loose) {
    const { rect, step, cell } = metrics();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const c = Math.floor(x / step);
    const r = Math.floor(y / step);
    if (c < 0 || c >= E.COLS || r < 0 || r >= E.ROWS) return -1;
    if (!loose && Math.hypot(x - (c * step + cell / 2), y - (r * step + cell / 2)) > cell * 0.42) return -1;
    return r * E.COLS + c;
  }

  let dragging = false;
  let dragMoved = false;
  let tappedLast = false;
  const grid = $('grid');

  grid.addEventListener('pointerdown', (e) => {
    if (busy || game.won || e.button > 0 || (tutorialMode && !tutWord())) return;
    const i = hitTest(e, true);
    const t = i >= 0 ? game.state.cells[i] : null;
    if (!E.isSpellable(t)) {
      if (t && t.t === E.STONE) showMessage('Stone can’t be spelled. Play a word touching it.', 'bad');
      else if (t && t.t === E.WEIGHT) showMessage('Weights drop once their column holds more vowels than consonants.', 'gd');
      path = [];
      for (const tile of tileEls.values()) tile.classList.remove('in-path', 'ok');
      $('trace').setAttribute('points', '');
      return;
    }
    e.preventDefault();
    grid.setPointerCapture(e.pointerId);
    dragging = true;
    dragMoved = false;
    const last = path[path.length - 1];
    tappedLast = i === last;
    if (!path.length) path = [i];
    else if (tappedLast) { /* decided on pointerup */ }
    else if (path.includes(i)) path = path.slice(0, path.indexOf(i) + 1);
    else if (E.isAdjacent(last, i)) path.push(i);
    else path = [i];
    renderPath();
  });

  grid.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const i = hitTest(e, false);
    if (i < 0) return;
    const last = path[path.length - 1];
    if (i === last) return;
    if (path.length >= 2 && i === path[path.length - 2]) {
      path.pop();
      dragMoved = true;
      renderPath();
      return;
    }
    if (path.includes(i) || !E.isSpellable(game.state.cells[i]) || !E.isAdjacent(last, i)) return;
    path.push(i);
    dragMoved = true;
    renderPath();
  });

  grid.addEventListener('pointerup', () => {
    if (!dragging) return;
    dragging = false;
    if (dragMoved) submit();
    else if (tappedLast) {
      // Tapping the last tile again plays the word (or deselects a stub).
      if (path.length >= E.MIN_WORD) submit();
      else { path = []; renderPath(); }
    }
  });
  grid.addEventListener('pointercancel', () => {
    dragging = false;
    path = [];
    renderPath();
  });
  document.addEventListener('pointerdown', (e) => {
    if (path.length && !grid.contains(e.target) && !e.target.closest('.modal')) {
      path = [];
      renderPath();
    }
  });
  document.addEventListener('keydown', (e) => {
    const open = document.querySelector('.modal.show');
    if (open) {
      if (e.key === 'Escape') closeModal(open);
      return;
    }
    if (busy) return;
    if (e.key === 'Escape' && path.length) { path = []; renderPath(); }
    else if (e.key === 'Backspace' && path.length) { path.pop(); renderPath(); }
    else if (e.key === 'Enter' && path.length) submit();
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undoMove(); }
  });

  /* ---------------- Playing a word ---------------- */
  function reject(tiles, text) {
    showMessage(text, 'bad');
    tiles.forEach((t) => { t.classList.remove('in-path', 'ok'); t.classList.add('bad'); });
    $('trace').setAttribute('points', '');
    if (navigator.vibrate) navigator.vibrate(40);
    setTimeout(() => tiles.forEach((t) => t.classList.remove('bad')), 420);
  }

  async function submit() {
    const played = path;
    path = [];
    if (played.length < E.MIN_WORD) {
      if (played.length > 1) { const tiles = played.map(tileAt); renderPath(); reject(tiles, 'Words need at least 3 letters'); }
      else renderPath();
      return;
    }
    const letters = E.pathLetters(game.state.cells, played);
    const word = E.matchWord(letters);
    if (tutorialMode && !tutAccepts(played, word)) {
      const tiles = played.map(tileAt);
      renderPath();
      reject(tiles, `Spell ${tutWord()} on the glowing tiles`);
      return;
    }
    if (!word) {
      const tiles = played.map(tileAt);
      renderPath();
      reject(tiles, `${letters.join('')} isn’t in the word list`);
      return;
    }

    busy = true;
    clearHint();
    if (tutorialMode) hideCoach();
    game.history = game.history.concat([snapshot()]);
    const res = E.resolveMove(game.state, played);
    game.moves += res.usedWild ? 2 : 1;
    renderPath();
    renderHud();
    showMessage(word, 'ok');
    if (res.usedWild) toast('Wildcard used: +1 move');

    await playPhases(res.phases);

    game.state = res.state;
    game.wildUsed = game.wildUsed || res.usedWild;
    game.log = game.log.concat([{ word: res.word, wild: res.usedWild, cascades: res.cascades, weights: res.weights }]);
    renderTiles(game.state.cells);
    renderChutes(game.state.queue);
    renderMeters(game.state.cells);

    if (res.weightsLeft === 0) {
      pauseClock();
      game.won = true;
      if (!tutorialMode) {
        recordWin(game.moves - puzzle.par);
        lbRecordFirstWin();
      }
    }
    busy = false;
    saveState();
    renderHud();
    if (game.won) await celebrate();
    else if (tutorialMode) { showIdle(); tutGo(tutStep + 1); }
    else { showIdle(); checkStuck(); }
  }

  async function playPhases(phases) {
    for (const ph of phases) {
      if (ph.type === 'pop') {
        popTiles(ph.ids, 'pop');
        popTiles(ph.stones, 'smash');
        if (ph.stones.length) toast('Stone smashed');
        await wait(pace(280));
        renderTiles(ph.cells);
        renderMeters(ph.cells);
      } else if (ph.type === 'settle' || ph.type === 'pinch' || ph.type === 'refill') {
        const d = renderTiles(ph.cells);
        if (ph.type === 'refill') renderChutes(ph.queue);
        if (ph.type === 'pinch') toast('Empty column: the board pinches in');
        renderMeters(ph.cells);
        await wait(Math.max(d, ph.type === 'refill' ? pace(200) : 0) + 50);
      } else if (ph.type === 'drop') {
        const tiles = tilesById(ph.ids);
        floatLabel(tiles, 'Dropped!', 'drop');
        for (const tile of tiles) {
          tile.classList.add('dropping');
          tile.style.setProperty('--r', E.ROWS + 0.8);
        }
        toast(ph.ids.length > 1 ? `${ph.ids.length} weights dropped` : 'Weight dropped');
        if (navigator.vibrate) navigator.vibrate([20, 40, 20]);
        $('weights').textContent = `${3 - E.countWeights(ph.cells)}/3`;
        await wait(pace(700));
        renderTiles(ph.cells);
        renderMeters(ph.cells);
      } else if (ph.type === 'cascade') {
        const tiles = tilesById(ph.ids);
        tiles.forEach((t) => t.classList.add('zap'));
        showMessage(`⚡ Cascade${ph.chain > 1 ? ` ×${ph.chain}` : ''}: ${ph.word}. Free clear!`, 'jp');
        floatLabel(tiles, ph.word, '');
        await wait(pace(650));
        popTiles(ph.ids, 'pop');
        popTiles(ph.stones, 'smash');
        await wait(pace(280));
        renderTiles(ph.cells);
        renderMeters(ph.cells);
      }
    }
  }

  async function celebrate() {
    showIdle();
    [...tileEls.values()].forEach((tile, k) => {
      tile.classList.add('won');
      tile.style.setProperty('--delay', `${k * 35}ms`);
    });
    await wait(pace(1000));
    if (tutorialMode) tutFinish();
    else showWin();
  }

  function checkStuck() {
    $('stuck').hidden = game.won || E.hasAnyWord(game.state.cells);
  }

  /* ---------------- Undo / reset ---------------- */
  function restore(snap) {
    Object.assign(game, snap);
    path = [];
    clearHint();
    renderTiles(game.state.cells);
    renderChutes(game.state.queue);
    renderMeters(game.state.cells);
    renderPath();
    renderHud();
    checkStuck();
    saveState();
  }
  function undoMove() {
    if (busy || tutorialMode || game.won || !game.history.length) return;
    const prev = game.history[game.history.length - 1];
    game.history = game.history.slice(0, -1);
    restore(prev);
    showMessage('Move undone');
  }
  function resetBoard() {
    if (busy || tutorialMode) return;
    if (game.won) { // "Try for fewer moves" after a finish: a clean replay
      closeModal($('winModal'));
      game = freshGame();
      tileEls.forEach((t) => t.remove());
      tileEls.clear();
      renderTiles(game.state.cells, { enter: true });
      restore({});
      startClock();
      return;
    }
    if (!game.moves && !game.history.length) return;
    game.history = game.history.concat([snapshot()]);
    restore({ state: puzzle.start, moves: 0, log: [], wildUsed: false });
    toast('Board reset. Undo brings it back.');
  }

  /* ---------------- Win modal ---------------- */
  function shareText() {
    const s = loadStats();
    const [g] = gradeFor(game.moves - puzzle.par);
    const dots = game.log.map((m) => (m.wild ? '🟡🟡' : '🟢') + '⚡'.repeat(m.cascades.length) + '⚫'.repeat(m.weights)).join('');
    const hintTag = game.hints > 0 ? ` · 💡${game.hints}` : '';
    return `Cascade #${activeDay + 1} ${'★'.repeat(puzzle.stars)}\n${g} · ${game.moves}/${puzzle.par} · 🔥${s.currentStreak}${hintTag}\n${dots}`;
  }

  let countdownTimer;
  function nextBoardIn() {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const s = Math.max(0, Math.floor((next - now) / 1000));
    return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  }

  function showWin() {
    const diff = game.moves - puzzle.par;
    const [g, colr] = gradeFor(diff);
    const gr = $('grade');
    gr.textContent = g;
    gr.style.background = `color-mix(in srgb, ${colr} 12%, transparent)`;
    gr.style.color = colr;
    gr.style.border = `1px solid ${colr}`;
    $('winMoves').textContent = `${game.moves} moves`;
    const cascades = game.log.reduce((n, m) => n + m.cascades.length, 0);
    const fastest = game.moves <= puzzle.best;
    $('breakdown').textContent =
      (fastest ? 'Shortest line cracked: you matched or beat the solver.' :
        diff === 0 ? 'Right on target, dead on par.' :
          diff < 0 ? `You beat par by ${-diff} move${diff < -1 ? 's' : ''}!` :
            `${diff} over par. Still a clear for today.`) +
      (cascades ? ` ${cascades} cascade${cascades > 1 ? 's' : ''} for free.` : '');
    $('trail').innerHTML = game.log.map((m) =>
      `<span class="${m.wild ? 'wc' : ''}">${m.word}</span>` + m.cascades.map((w) => `<span class="cs">⚡ ${w}</span>`).join('')).join('');
    renderStats('st', loadStats(), activeDay === dayNumber() ? gradeKey(diff) : null);
    $('share').textContent = shareText();
    $('retryBtn').hidden = fastest;
    lbAfterWin();
    $('countdown').textContent = nextBoardIn();
    clearInterval(countdownTimer);
    countdownTimer = setInterval(() => { $('countdown').textContent = nextBoardIn(); }, 1000);
    openModal($('winModal'));
  }

  async function shareResult() {
    const text = $('share').textContent;
    if (navigator.share && navigator.canShare && navigator.canShare({ text })) {
      try { await navigator.share({ text }); return; } catch (err) { if (err && err.name === 'AbortError') return; }
    }
    if (navigator.clipboard && window.isSecureContext) {
      try { await navigator.clipboard.writeText(text); toast('Result copied!'); return; } catch (e) { /* fall through */ }
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      toast('Result copied!');
    } catch (e) { toast('Copy failed', true); }
  }

  /* ---------------- Daily leaderboard (as in Typeset) ----------------
     One public board per day, stored in the workshop's Firebase under
     cascade/daily/{day}/{playerId}. Only the first win on today's puzzle posts
     (replays and archive solves never do). Score = moves + hint taps, lower is
     better; ties go to the faster solve. */
  const FIREBASE_CONFIG = {
    apiKey: 'AIzaSyD5C8uPGGb_jMuA0ceP5VlWChMV-Ggfles',
    authDomain: 'tumbler-51e42.firebaseapp.com',
    databaseURL: 'https://tumbler-51e42-default-rtdb.asia-southeast1.firebasedatabase.app/',
    projectId: 'tumbler-51e42',
    appId: '1:907072959576:web:641facf27c204c7bb8862d',
  };
  const LB_PID_KEY = 'cascade_pid';
  const LB_NAME_KEY = 'cascade_name';
  const LB_POSTED_KEY = 'cascade_lb_posted';
  const LB_ASKED_KEY = 'cascade_lb_asked';
  const LB_ENTRY_KEY = 'cascade_lb_entry'; // { day, entry }: today's first win, which is what posts
  const LB_SHOW = 50;
  const LB_TIMEOUT = 8000;
  const lbGet = (k) => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } };
  const lbSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } };
  const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  let lbName = cleanName(lbGet(LB_NAME_KEY));
  let lbPidCache = '';
  function lbPid() {
    if (lbPidCache) return lbPidCache;
    let id = lbGet(LB_PID_KEY);
    if (!/^[a-z0-9]{12,}$/.test(id)) {
      id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => (b % 36).toString(36)).join('');
      lbSet(LB_PID_KEY, id);
    }
    return (lbPidCache = id);
  }
  function lbSetName(n) { lbName = n; lbSet(LB_NAME_KEY, n); }
  function loadScript(src) {
    return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
  }
  // Firebase reads never reject while offline — they just wait — so every call gets a deadline.
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
  let lbDbPromise = null;
  function lbDb() {
    if (!lbDbPromise) {
      const base = 'https://www.gstatic.com/firebasejs/10.7.1/';
      lbDbPromise = loadScript(`${base}firebase-app-compat.js`)
        .then(() => loadScript(`${base}firebase-database-compat.js`))
        .then(() => (firebase.apps.length ? firebase.app() : firebase.initializeApp(FIREBASE_CONFIG)).database())
        .catch((e) => { lbDbPromise = null; throw e; });
    }
    return withTimeout(lbDbPromise, LB_TIMEOUT);
  }
  async function markVisit() {
    try {
      const db = await lbDb();
      const profile = { lastUpdated: firebase.database.ServerValue.TIMESTAMP };
      if (lbName) profile.name = lbName;
      await withTimeout(db.ref(`cascade/userProfile/${lbPid()}`).update(profile), LB_TIMEOUT);
    } catch (e) { /* Visit tracking is best effort and must not block the game. */ }
  }
  async function lbPost(day, entry) {
    const db = await lbDb();
    const ref = db.ref(`cascade/daily/${day}/${lbPid()}`);
    const row = { ...entry, at: firebase.database.ServerValue.TIMESTAMP };
    await withTimeout(ref.transaction((cur) => (cur === null ? row : undefined)), LB_TIMEOUT); // first result stands
    lbSet(LB_POSTED_KEY, String(day));
    void markVisit(); // a posted score always comes with a profile
  }
  async function lbFetch(day) {
    const db = await lbDb();
    const snap = await withTimeout(db.ref(`cascade/daily/${day}`).once('value'), LB_TIMEOUT);
    const rows = [];
    snap.forEach((c) => {
      const v = c.val() || {};
      if (typeof v.s === 'number') rows.push({ pid: c.key, n: cleanName(v.n) || 'Anonymous', s: v.s | 0, h: v.h | 0, t: v.t | 0, at: +v.at || 0 });
    });
    rows.sort((a, b) => a.s - b.s || a.t - b.t || a.at - b.at);
    return rows;
  }
  const hintTag = (h) => (h > 0 ? `💡${h}` : '');
  function lbRow(r, rank, me) {
    const el = document.createElement('div');
    el.className = `lb-row${r.pid === me ? ' you' : ''}`;
    el.innerHTML = `<span class="lr">${rank}</span><span class="ln"></span><span class="lm">${hintTag(r.h)}</span>` +
      `<span class="ls">${r.s}</span><span class="lt">${fmtTime(r.t)}</span>`;
    el.querySelector('.ln').textContent = r.n;
    if (r.pid === me) el.querySelector('.ln').insertAdjacentHTML('beforeend', '<small>You</small>');
    return el;
  }
  function renderLbYou(day) {
    const you = $('lbYou');
    const isToday = day === dayNumber();
    if (!lbName) { you.textContent = isToday ? "Solve today's board to put your name on the leaderboard." : ''; return; }
    you.innerHTML = 'Playing as <b></b> · <button class="lnk" type="button" id="lbRename">Change name</button>' +
      (!isToday || lbGet(LB_POSTED_KEY) === String(day) ? '' : "<br>Solve today's board to post your score.");
    you.querySelector('b').textContent = lbName;
    $('lbRename').onclick = () => openNameCard('rename', dayNumber(), null); // a rename only touches today's entry
  }
  // ago: 0 = today's board, 1 = yesterday's (read-only — only today's live result ever posts).
  let lbReq = 0;
  let lbAgo = 0;
  async function openLeaderboard(ago = 0) {
    const today = Math.max(0, dayNumber());
    if (today < 1) ago = 0;
    lbAgo = ago;
    const day = today - ago;
    const list = $('lbList');
    const req = ++lbReq;
    document.querySelector('.lb-tabs').hidden = today < 1; // launch day: nothing to look back on
    document.querySelectorAll('.lb-tab').forEach((t) => {
      const on = Number(t.dataset.ago) === ago;
      t.classList.toggle('on', on);
      t.setAttribute('aria-selected', on);
    });
    const p = day === activeDay && !tutorialMode ? puzzle : puzzleForDay(day);
    const dstr = dateForDay(day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    $('lbSub').innerHTML = `Board #${day + 1} · ${dstr} · <span class="stars">${'★'.repeat(p.stars)}</span> · Par ${p.par}<br>Ranked by score (moves + hints), then time`;
    list.innerHTML = '<div class="lb-empty">Loading…</div>';
    renderLbYou(day);
    openModal($('lbModal'));
    try {
      const rows = await lbFetch(day);
      const me = lbPid();
      if (req !== lbReq) return; // the player switched tabs while this was loading
      list.innerHTML = '';
      if (!rows.length) { list.innerHTML = `<div class="lb-empty">${ago ? "No one made yesterday's board." : "No one's on the board yet. Solve today's to be first."}</div>`; return; }
      rows.slice(0, LB_SHOW).forEach((r, i) => list.appendChild(lbRow(r, i + 1, me)));
      const mine = rows.findIndex((r) => r.pid === me);
      if (mine >= LB_SHOW) { const el = lbRow(rows[mine], mine + 1, me); el.classList.add('gap'); list.appendChild(el); }
    } catch (e) {
      if (req !== lbReq) return;
      list.innerHTML = '<div class="lb-empty">Couldn\'t reach the leaderboard. Check your connection and try again.</div>';
    }
  }
  // The first win on today's board is the one that counts, even if the player replays for fewer moves.
  function lbRecordFirstWin() {
    const day = dayNumber();
    if (activeDay !== day || lbEntryFor(day)) return;
    writeJSON(LB_ENTRY_KEY, { day, entry: { s: game.moves + game.hints, mv: game.moves, h: game.hints, t: Math.round(game.time / 1000) } });
  }
  function lbEntryFor(day) {
    const e = readJSON(LB_ENTRY_KEY, null);
    return e && e.day === day && e.entry ? e.entry : null;
  }
  // Win card: today's first win posts itself once a name is known; archive replays never post.
  // With no name yet, the name card opens over the result once per day.
  function lbAfterWin() {
    const day = dayNumber();
    const box = $('lbJoin');
    const entry = activeDay === day ? lbEntryFor(day) : null;
    box.hidden = !entry;
    if (!entry) return;
    if (lbGet(LB_POSTED_KEY) === String(day)) { lbShowRank(day); return; }
    if (lbName) { lbSubmit(day, entry); return; }
    lbShowJoinLink(day, entry);
    if (lbGet(LB_ASKED_KEY) === String(day)) return;
    lbSet(LB_ASKED_KEY, String(day));
    // let the result land first, then ask
    setTimeout(() => {
      if (activeDay === day && $('winModal').classList.contains('show')) openNameCard('join', day, entry);
    }, 700);
  }
  function lbShowJoinLink(day, entry) {
    $('lbJoinMsg').innerHTML = 'You\'re not on today\'s leaderboard yet. <button class="lnk" type="button" id="lbAdd">Add your name</button>';
    $('lbAdd').onclick = () => openNameCard('join', day, entry);
  }
  async function lbSubmit(day, entry) {
    const msg = $('lbJoinMsg');
    msg.textContent = "Posting to today's leaderboard…";
    try { await lbPost(day, { n: lbName, ...entry }); await lbShowRank(day); } catch (e) {
      msg.innerHTML = 'Couldn\'t reach the leaderboard. <button class="lnk" type="button" id="lbRetry">Try again</button>';
      $('lbRetry').onclick = () => lbSubmit(day, entry);
    }
  }
  async function lbShowRank(day) {
    const msg = $('lbJoinMsg');
    msg.textContent = "Checking today's leaderboard…";
    try {
      const rows = await lbFetch(day);
      const i = rows.findIndex((r) => r.pid === lbPid());
      msg.innerHTML = i < 0 ? "You're on today's leaderboard." : `You're <b>#${i + 1}</b> of ${rows.length} on today's leaderboard.`;
    } catch (e) { msg.textContent = "You're on today's leaderboard."; }
  }

  /* Name card: one dedicated step for joining the board (mode "join", with the
     result about to be posted shown as a preview row) and for renaming later. */
  let nameCtx = null;
  function renderNamePreview() {
    const n = cleanName($('nameInput').value);
    const ln = $('namePreview').querySelector('.ln');
    ln.textContent = n || 'Your name';
    ln.classList.toggle('ph', !n);
  }
  function openNameCard(mode, day, entry) {
    const join = mode === 'join';
    $('nameTitle').textContent = join ? 'Sign your board' : 'Change your name';
    $('nameText').textContent = join
      ? "Pick a name to post today's result. Everyone who solves today's board is ranked by score (moves + hints), then time."
      : 'This is the name other players see next to your result.';
    $('nameSave').textContent = join ? 'Post to leaderboard' : 'Save name';
    $('nameSkip').textContent = join ? 'Not now' : 'Cancel';
    const pv = $('namePreview');
    pv.hidden = !entry;
    if (entry) {
      pv.querySelector('.lm').textContent = hintTag(entry.h);
      pv.querySelector('.ls').textContent = entry.s;
      pv.querySelector('.lt').textContent = fmtTime(entry.t);
    }
    $('nameInput').value = lbName;
    $('nameInput').classList.remove('shake');
    renderNamePreview();
    openModal($('nameModal'));
    nameCtx = { mode, day, entry };
    setTimeout(() => $('nameInput').focus(), 60);
  }
  $('nameInput').addEventListener('input', () => { $('nameInput').classList.remove('shake'); renderNamePreview(); });
  $('nameForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('nameInput');
    const n = cleanName(input.value);
    if (!n) { input.classList.remove('shake'); void input.offsetWidth; input.classList.add('shake'); input.focus(); return; }
    const ctx = nameCtx;
    if (!ctx) return;
    lbSetName(n);
    closeModal($('nameModal'));
    if (ctx.mode === 'join') {
      if (ctx.day === dayNumber()) lbSubmit(ctx.day, ctx.entry);
      return;
    }
    if (lbGet(LB_POSTED_KEY) === String(ctx.day)) {
      try { const db = await lbDb(); await withTimeout(db.ref(`cascade/daily/${ctx.day}/${lbPid()}/n`).set(n), LB_TIMEOUT); } catch (err) { toast("Couldn't update your name", true); }
    }
    openLeaderboard(lbAgo);
  });
  $('lbBtn').addEventListener('click', () => openLeaderboard());
  $('lbJoinOpen').addEventListener('click', () => openLeaderboard());
  document.querySelectorAll('.lb-tab').forEach((t) => t.addEventListener('click', () => openLeaderboard(Number(t.dataset.ago))));

  /* ---------------- Modals ---------------- */
  function openModal(m) { m.classList.add('show'); }
  function closeModal(m) {
    m.classList.remove('show');
    if (m.id === 'winModal') clearInterval(countdownTimer);
    if (m.id === 'rulesModal') { stopDemos(); try { localStorage.setItem(SEEN_KEY, '1'); } catch (e) { /* ignore */ } startClock(); }
    if (m.id === 'nameModal') nameCtx = null;
  }
  document.querySelectorAll('.modal').forEach((m) => {
    m.addEventListener('click', (e) => {
      if (e.target === m || e.target.closest('.x-close') || e.target.closest('[data-close]')) closeModal(m);
    });
  });

  // How to play: Typeset-style deck
  const slides = [...document.querySelectorAll('#rulesModal .slide')];
  let slideAt = 0;
  function showSlide(n) {
    slideAt = n;
    slides.forEach((s, k) => s.classList.toggle('on', k === n));
    $('deckDots').innerHTML = slides.map((_, k) => `<button type="button" class="${k === n ? 'on' : ''}" aria-label="Slide ${k + 1}"></button>`).join('');
    $('deckDots').querySelectorAll('button').forEach((b, k) => b.addEventListener('click', () => showSlide(k)));
    $('deckNext').textContent = n === slides.length - 1 ? 'Got it — let’s play' : 'Next';
    const demo = slides[n].querySelector('.demo');
    if (demo && $('rulesModal').classList.contains('show')) playDemo(demo);
    else stopDemos();
  }
  $('deckNext').addEventListener('click', () => {
    if (slideAt < slides.length - 1) showSlide(slideAt + 1);
    else closeModal($('rulesModal'));
  });
  $('helpBtn').addEventListener('click', () => { openModal($('rulesModal')); showSlide(0); });
  $('tutBtn').addEventListener('click', startTutorial);

  $('statsBtn').addEventListener('click', () => { renderStats('sm', loadStats(), null); openModal($('statsModal')); });
  $('gamesBtn').addEventListener('click', () => openModal($('gamesModal')));

  /* ---------------- How-to-play clips ----------------
     Each slide loops a few seconds of play, like a GIF, drawn with the real
     tile renderer so it matches the board in both themes. Only the slide on
     screen plays; changing slide or closing the deck stops it. */
  const DEMO_CELL = 30;
  const DEMO_STEP = DEMO_CELL + 4;
  const DEMO_STOP = {};
  let demoRun = 0;
  const stopDemos = () => { demoRun++; };

  /** A tiny board in `host`: rows of letters ('.' empty, '@' weight), keyed by starting cell ('rc'). */
  function demoStage(host, run) {
    const tiles = new Map();
    let rowsN = 0;
    let grid;
    let trace;
    const get = (keys) => keys.map((k) => tiles.get(k)).filter(Boolean);
    const d = {
      board(rows, { chute = '', meter = false } = {}) {
        rowsN = rows.length;
        const cols = rows[0].length;
        host.innerHTML = `<div class="demo-board" style="--cols:${cols};--rows:${rowsN}">` +
          (chute ? '<div class="chutes demo-chutes"></div>' : '') +
          '<div class="demo-grid"><div class="wells"></div><div class="demo-tiles"></div><svg class="demo-trace"><polyline/></svg></div>' +
          (meter ? '<div class="meters demo-meters"><div class="meter"></div></div>' : '') +
          '</div><div class="demo-word"></div>';
        host.querySelector('.wells').innerHTML = rows.map((line) =>
          [...line].map((ch) => `<span${ch === '@' ? ' class="floor"' : ''}></span>`).join('')).join('');
        grid = host.querySelector('.demo-tiles');
        trace = host.querySelector('.demo-trace');
        rows.forEach((line, r) => [...line].forEach((ch, c) => { if (ch !== '.') d.add(`${r}${c}`, ch, r, c, false); }));
        if (chute) d.chute(chute);
      },
      add(key, ch, r, c, appear = true) {
        const tile = makeTile(ch === '@' ? { t: E.WEIGHT, ch: '' } : { t: E.LETTER, ch });
        place(tile, r, c);
        if (appear) tile.classList.add('appear');
        grid.appendChild(tile);
        tiles.set(key, tile);
      },
      async step(ms) {
        await wait(ms);
        if (run !== demoRun) throw DEMO_STOP;
      },
      say(text, kind = '') { host.querySelector('.demo-word').innerHTML = `<span class="${kind}">${text}</span>`; },
      mark(keys, cls) { get(keys).forEach((t) => t.classList.add(cls)); },
      /** The traced path, as on the board: tiles light up and a line joins them. */
      path(keys, ok = false) {
        for (const t of tiles.values()) t.classList.remove('in-path', 'ok');
        get(keys).forEach((t) => t.classList.add('in-path', ...(ok ? ['ok'] : [])));
        trace.classList.toggle('ok', ok);
        trace.firstChild.setAttribute('points', get(keys).map((t) =>
          `${t.dataset.c * DEMO_STEP + DEMO_CELL / 2},${t.dataset.r * DEMO_STEP + DEMO_CELL / 2}`).join(' '));
      },
      pop(keys) {
        get(keys).forEach((t) => { t.classList.remove('in-path', 'ok', 'zap'); t.firstChild.classList.add('pop'); });
        keys.forEach((k) => tiles.delete(k));
      },
      move(key, r, c) {
        const t = tiles.get(key);
        const dist = Math.abs(r - t.dataset.r) + Math.abs(c - t.dataset.c);
        t.style.setProperty('--dur', `${pace(160 + dist * 70)}ms`);
        t.classList.toggle('sinking', r > t.dataset.r);
        t.classList.toggle('rising', r < t.dataset.r);
        place(t, r, c);
      },
      drop(key) {
        const t = tiles.get(key);
        t.classList.add('dropping');
        t.style.setProperty('--r', rowsN + 0.8);
        floatLabel([t], 'Dropped!', 'drop', grid);
      },
      float(keys, text) { floatLabel(get(keys), text, '', grid); },
      chute(chs) {
        host.querySelector('.demo-chutes').innerHTML = `<div class="chute">${[...chs].slice(0, 2).map((ch) =>
          `<i class="${'AEIOU'.includes(ch) ? 'vw' : ''}">${ch}</i>`).join('')}</div>`;
      },
      meter(up, dn, done = false) {
        const m = host.querySelector('.meter');
        m.className = `meter${up === dn ? ' close' : ''}${done ? ' done' : ''}`;
        m.innerHTML = `<span class="up">▲${up}</span><span class="dn">▼${dn}</span>`;
      },
    };
    return d;
  }

  const DEMOS = {
    // Trace C → A → T (the last step is diagonal), then the word clears.
    async spell(d) {
      d.board(['SCO', 'RAI', 'TPN']);
      d.say('Drag across touching tiles');
      await d.step(900);
      const cat = ['01', '11', '20'];
      for (let k = 1; k <= cat.length; k++) {
        d.path(cat.slice(0, k));
        d.say('CAT'.slice(0, k), 'w');
        await d.step(450);
      }
      d.path(cat, true);
      d.say('CAT', 'w ok');
      await d.step(800);
      d.path([]);
      d.pop(cat);
      d.say('One word, one move');
      await d.step(1800);
    },
    // T is spent; the column closes up with vowels on top, then the chute tops it up.
    async sort(d) {
      d.board(['R', 'E', 'T', 'O', 'S'], { chute: 'AU' });
      d.say('A column, mid-game');
      await d.step(900);
      d.mark(['20'], 'in-path');
      d.say('T is spent in a word');
      await d.step(800);
      d.pop(['20']);
      await d.step(450);
      d.move('30', 2, 0);
      d.move('00', 3, 0);
      d.say('<span class="vw">Vowels rise</span> · consonants sink');
      await d.step(1300);
      d.add('in', 'A', 0, 0);
      d.chute('U');
      d.say('A new tile drops in from the chute');
      await d.step(2000);
    },
    // Spend N and D: the chute adds a vowel, ▲ passes ▼ and the weight falls.
    async weight(d) {
      d.board(['A', 'N', 'D', 'T', '@'], { chute: 'IE', meter: true });
      d.meter(1, 3);
      d.say('▲1 vowel · ▼3 consonants');
      await d.step(1100);
      d.mark(['10', '20'], 'in-path');
      d.say('Spend two consonants');
      await d.step(800);
      d.pop(['10', '20']);
      d.meter(1, 1);
      await d.step(400);
      d.move('00', 2, 0);
      await d.step(500);
      d.add('in', 'I', 0, 0);
      d.chute('E');
      await d.step(300);
      d.move('in', 1, 0);
      d.meter(2, 1);
      d.say('▲2 beats ▼1');
      await d.step(700);
      d.drop('40');
      d.meter(2, 1, true);
      await d.step(500);
      d.move('in', 2, 0);
      d.move('00', 3, 0);
      d.move('30', 4, 0);
      d.say('Weight dropped');
      await d.step(1800);
    },
    // GET clears; U falls between S and N and SUN reads across by itself.
    async cascade(d) {
      d.board(['.U.', '.GE', 'STN']);
      d.say('Play a word…');
      await d.step(900);
      const get = ['11', '12', '21'];
      for (let k = 1; k <= get.length; k++) {
        d.path(get.slice(0, k));
        d.say('GET'.slice(0, k), 'w');
        await d.step(420);
      }
      d.path(get, true);
      await d.step(500);
      d.path([]);
      d.pop(get);
      await d.step(400);
      d.move('01', 2, 1);
      await d.step(600);
      d.mark(['20', '01', '22'], 'zap');
      d.say('⚡ SUN lined up: a free clear', 'jp');
      d.float(['01'], 'SUN');
      await d.step(900);
      d.pop(['20', '01', '22']);
      await d.step(1800);
    },
  };

  async function playDemo(host) {
    const run = ++demoRun;
    try {
      for (;;) await DEMOS[host.dataset.demo](demoStage(host, run));
    } catch (e) {
      if (e !== DEMO_STOP) throw e;
    }
  }

  /* ---------------- Walkthrough (as in Typeset) ----------------
     A hand-built practice board, outside the daily rotation, played on the live
     engine. Each step lights the tiles of one word; the player's own drag plays
     it, and a coach card explains what the board just did. tutorialMode keeps
     the clock, saves, stats and leaderboard out of it. Line checked against the
     engine: REST drops the left weight, PACE fires a free ONES cascade that drops
     the right one, KIND smashes the stone and drops the last. */
  const TUTORIAL = {
    rows: ['A I I I A', 'E O E O E', 'T O N E S', 'S E N T W', 'R C G D #', '@ R @ L @'],
    chutes: ['OUEAIOEAIU', 'PSAUIOEE', 'KLEIECBO', 'UAAHBIOA', 'EAGWORAA'],
  };
  const TUT_STEPS = [
    { t: 'Welcome', next: 'Show me',
      x: 'This practice board plays out one short game. Three <b>weights</b> sit on the floor, and you want all three gone. A weight drops once its column holds <b>more vowels than consonants</b>. The <span class="vw">▲</span>/▼ meter under it keeps count.' },
    { t: 'Spell a word', word: 'REST', at: [[4, 0], [3, 1], [3, 0], [2, 0]],
      x: 'Drag through the glowing tiles to spell <b>REST</b>, starting on the R. Diagonals count. It spends three consonants from the left column, which is exactly what that weight needs.' },
    { t: 'One down',
      x: 'Only vowels were left above the left weight, so it fell off the board. Then the column closed up, <span class="vw">vowels on top</span>, and new tiles dropped in from the chute above it.' },
    { t: 'Watch for cascades', word: 'PACE', at: [[3, 1], [4, 0], [4, 1], [5, 0]],
      x: 'Now spell <b>PACE</b>. Keep an eye on the third row while the tiles settle.' },
    { t: 'A free clear',
      x: 'The shifting tiles lined up <span class="jp">ONES</span> on their own, so it cleared for free. It took an S out of the right column, a vowel dropped in, and that weight fell too. Cascades never cost a move.' },
    { t: 'Smash the stone', word: 'KIND', at: [[2, 2], [2, 1], [3, 2], [4, 3]],
      x: 'Last weight. The hatched tile in the corner is <b>stone</b>: it can\'t be spelled and sinks like a consonant. Spell <b>KIND</b>. Its D touches the stone, which smashes it.' },
  ];
  const tutWord = () => (tutorialMode && TUT_STEPS[tutStep] && TUT_STEPS[tutStep].word) || '';
  // The step's word on exactly its tiles (in either order the dictionary accepts).
  function tutAccepts(played, word) {
    const st = TUT_STEPS[tutStep];
    if (!st || !st.at || word !== st.word) return false;
    const want = st.at.map(([r, c]) => r * E.COLS + c);
    return played.length === want.length && want.every((i) => played.includes(i));
  }

  function tutorialBoard() {
    let id = 0;
    const tile = (ch) => (ch === '@' ? { id: id++, t: E.WEIGHT, ch: '' } : ch === '#' ? { id: id++, t: E.STONE, ch: '' } : { id: id++, t: E.LETTER, ch });
    return {
      cells: TUTORIAL.rows.flatMap((line) => line.split(' ').map(tile)),
      queue: TUTORIAL.chutes.map((q) => [...q].map(tile)),
    };
  }

  function coach(title, text, { next = null, prog = '', skip = true } = {}) {
    $('coachTitle').textContent = title;
    $('coachText').innerHTML = text;
    $('coachProg').textContent = prog;
    $('coachNext').hidden = !next;
    $('coachNext').textContent = next || '';
    $('coachSkip').hidden = !skip;
    $('coach').classList.add('show');
  }
  function hideCoach() { $('coach').classList.remove('show'); }
  /* The coach sits over the bottom of the viewport, so pad the page by its
     height and scroll the board up to just above it. */
  function tutScroll() {
    const pad = $('coach').offsetHeight + 28;
    document.body.style.paddingBottom = `${pad}px`;
    $('stage').style.scrollMarginBottom = `${pad}px`;
    $('stage').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'end' });
  }
  function tutGo(step) {
    tutStep = step;
    clearHint();
    const st = TUT_STEPS[step];
    if (!st) return;
    if (st.at) st.at.forEach(([r, c]) => { const t = tileAt(r * E.COLS + c); if (t) t.classList.add('hint-lane'); });
    setTimeout(() => {
      if (!tutorialMode || tutStep !== step) return;
      coach(st.t, st.x, { next: st.word ? null : st.next || 'Next', prog: `${step + 1} / ${TUT_STEPS.length}` });
      tutScroll();
    }, 150);
  }
  function tutFinish() {
    coach('All three weights dropped 🎉',
      'That\'s Cascade. Each day brings a new board and a <b>par</b> to beat: finish under it for a Birdie or Eagle. A gold <span class="gd">?</span> wildcard can be any letter but costs 2 moves, and <b>Hint</b> lights up a word when you\'re stuck.',
      { next: 'Play today\'s puzzle', skip: false });
    tutScroll();
  }
  function startTutorial() {
    if (busy) return;
    stopDemos();
    document.querySelectorAll('.modal.show').forEach((m) => m.classList.remove('show'));
    clearInterval(countdownTimer);
    try { localStorage.setItem(SEEN_KEY, '1'); } catch (e) { /* ignore */ }
    if (!tutorialMode && game) { pauseClock(); saveState(); } // bank the real board before swapping it out
    tutorialMode = true;
    puzzle = { day: activeDay, par: TUT_STEPS.filter((st) => st.word).length, best: 3, stars: 1, start: tutorialBoard() };
    game = freshGame();
    showBoard();
    tutGo(0);
  }
  // Drop the practice board without loading another (loadDay does that).
  function leaveTutorial() {
    tutorialMode = false;
    tutStep = 0;
    game = null;
    hideCoach();
    document.body.style.paddingBottom = '';
  }
  function endTutorial() {
    leaveTutorial();
    loadDay(activeDay);
    window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
  }
  $('coachNext').addEventListener('click', () => {
    if (game && game.won) endTutorial(); // the closing card
    else tutGo(tutStep + 1);
  });
  $('coachSkip').addEventListener('click', endTutorial);

  function buildArchive() {
    const today = Math.max(0, dayNumber());
    const saves = readJSON(SAVE_KEY, {});
    const list = $('archList');
    list.innerHTML = '';
    for (let day = today; day >= 0; day--) {
      const s = saves[day];
      const solved = s && s.won;
      const started = s && !s.won && (s.moves > 0 || (s.history && s.history.length));
      const row = document.createElement('button');
      row.className = `arch-row${day === activeDay ? ' current' : ''}`;
      const dstr = dateForDay(day).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
      const badge = day === today ? '<span class="atoday">Today</span>' : '';
      const status = solved ? '<span class="as done">✓</span>' : started ? '<span class="as">▶</span>' : '<span class="as"></span>';
      row.innerHTML = `<span class="an">#${day + 1}</span><span class="ad">${dstr}</span>${badge}${status}`;
      row.addEventListener('click', () => { closeModal($('archiveModal')); loadDay(day); });
      list.appendChild(row);
    }
  }
  $('calBtn').addEventListener('click', () => { buildArchive(); openModal($('archiveModal')); });

  $('hintBtn').addEventListener('click', showMoveHint);
  $('undoBtn').addEventListener('click', undoMove);
  $('resetBtn').addEventListener('click', resetBoard);
  $('retryBtn').addEventListener('click', resetBoard);
  $('copyBtn').addEventListener('click', shareResult);

  /* ---------------- Boot ---------------- */
  function loadDay(day) {
    if (tutorialMode) leaveTutorial();
    else if (game) { pauseClock(); saveState(); }
    activeDay = day;
    puzzle = puzzleForDay(day);
    if (new URLSearchParams(location.search).has('debug')) console.info(`Cascade #${day + 1} par ${puzzle.par}:`, puzzle.solution.join(' → '));
    const saved = loadState(day);
    game = saved ? { ...freshGame(), ...saved } : freshGame();
    showBoard();
    if (game.won) setTimeout(showWin, 600);
    else if (!$('rulesModal').classList.contains('show')) startClock();
  }

  function showBoard() {
    path = [];
    clearHint();
    tileEls.forEach((t) => t.remove());
    tileEls.clear();
    lastMeter = [];
    renderHeader();
    renderTiles(game.state.cells, { enter: true });
    renderChutes(game.state.queue);
    renderMeters(game.state.cells);
    renderHud();
    showIdle();
    checkStuck();
  }

  function boot() {
    E.loadDictionary(self.CASCADE_WORDS.split(' '), self.CASCADE_COMMON.split(' '));
    self.CASCADE_WORDS = self.CASCADE_COMMON = null;
    renderWells();
    const asked = new URLSearchParams(location.search).get('date');
    const day = asked && /^\d{4}-\d{2}-\d{2}$/.test(asked) ? Math.max(0, dayForKey(asked)) : Math.max(0, dayNumber());
    let seen = false;
    try { seen = !!localStorage.getItem(SEEN_KEY); } catch (e) { /* ignore */ }
    showSlide(0);
    loadDay(day);
    if (!seen) startTutorial(); // first visit plays the walkthrough; after that ? opens the deck
    void markVisit();
    $('loading').classList.add('gone');
    setTimeout(() => $('loading').remove(), 300);
  }

  // Let the loading veil paint before the dictionary + solver run.
  requestAnimationFrame(() => setTimeout(boot, 30));
})();
