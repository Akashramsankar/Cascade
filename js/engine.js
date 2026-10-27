/* Cascade — game engine.
 * Pure logic, no DOM: board generation, lexical gravity, chain reactions and the
 * par solver. Runs in the browser (self.CascadeEngine) and in Node (module.exports).
 *
 * Board: a flat array of ROWS*COLS cells, index = row*COLS + col, row 0 at the top.
 * Each cell is null or a tile { id, t, ch } where t is one of LETTER/WEIGHT/STONE/WILD.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CascadeEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = 3; // bump to change every future board (part of the seed)
  const COLS = 5;
  const ROWS = 6;
  const SIZE = COLS * ROWS;
  const FLOOR = ROWS - 1;
  const CENTER = 2;
  const WEIGHT_COLS = [0, 2, 4];
  const MIN_WORD = 3;
  const PAR_CUSHION = 1; // par = solver's best + this (as in Currents)

  const LETTER = 'L';
  const WEIGHT = 'G';
  const STONE = 'S';
  const WILD = 'W';

  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const VOWELS = new Set('AEIOU');
  const VOWEL_WEIGHTS = { E: 12, A: 9, I: 8, O: 8, U: 4 };
  const CONSONANT_WEIGHTS = {
    R: 6, T: 6, N: 6, S: 6, L: 5, D: 4, C: 3, M: 3, P: 3, H: 3, G: 3,
    B: 2, F: 2, W: 2, Y: 2, K: 2, V: 1, X: 1, Z: 1, J: 1,
  };
  const RARE = new Set('JKVXZ');

  // Tunable rules (exposed so the balance script can compare variants).
  const rules = {
    weightDrops: 'light', // 'light': more vowels than consonants above it · 'gap': no consonant resting on it · 'clear': column empty
    diagonals: false, // cascades also read ↘ and ↗ (fires too often with packed gravity)
    reserve: 20, // tiles queued above each column that drop in as space opens (more than a game uses)
    chuteVowels: 0.5, // share of vowels arriving from the chutes
    gravity: 'packed', // 'packed': disturbed columns close up, vowels above consonants · 'gaps': tiles only move through empty cells
  };

  const row = (i) => Math.floor(i / COLS);
  const col = (i) => i % COLS;

  // 8-way neighbours for every cell.
  const NEIGHBORS = [];
  for (let i = 0; i < SIZE; i++) {
    const list = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const r = row(i) + dr;
        const c = col(i) + dc;
        if (r >= 0 && r < ROWS && c >= 0 && c < COLS) list.push(r * COLS + c);
      }
    }
    NEIGHBORS.push(list);
  }
  const isAdjacent = (a, b) => NEIGHBORS[a].includes(b);

  // Reading lines for cascade detection, always left→right or top→bottom.
  const inside = (r, c) => r >= 0 && r < ROWS && c >= 0 && c < COLS;
  function lineFrom(r, c, dr, dc) {
    const out = [];
    for (; inside(r, c); r += dr, c += dc) out.push(r * COLS + c);
    return out;
  }
  const STRAIGHT = [];
  const DIAGONAL = [];
  for (let r = 0; r < ROWS; r++) STRAIGHT.push(lineFrom(r, 0, 0, 1));
  for (let c = 0; c < COLS; c++) STRAIGHT.push(lineFrom(0, c, 1, 0));
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (!inside(r - 1, c - 1)) DIAGONAL.push(lineFrom(r, c, 1, 1)); // ↘
      if (!inside(r + 1, c - 1)) DIAGONAL.push(lineFrom(r, c, -1, 1)); // ↗
    }
  }
  const linesToRead = () => (rules.diagonals ? STRAIGHT.concat(DIAGONAL) : STRAIGHT).filter((l) => l.length >= MIN_WORD);

  const isVowel = (t) => t.t === LETTER && VOWELS.has(t.ch);
  const isBuoyant = (t) => t.t === WILD || isVowel(t);
  const isDense = (t) => t.t === STONE || (t.t === LETTER && !VOWELS.has(t.ch));
  const isSpellable = (t) => !!t && (t.t === LETTER || t.t === WILD);

  // ---------------------------------------------------------------- randomness

  function hashString(str) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^ (h >>> 16)) >>> 0;
  }

  function mulberry32(seed) {
    let a = seed;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function pickWeighted(rng, weights) {
    const entries = Object.entries(weights);
    let total = 0;
    for (const [, w] of entries) total += w;
    let x = rng() * total;
    for (const [k, w] of entries) {
      if ((x -= w) < 0) return k;
    }
    return entries[entries.length - 1][0];
  }

  function shuffle(rng, arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // ---------------------------------------------------------------- dictionary

  let dict = new Set();
  let common = new Set();
  let trie = {};
  let commonTrie = {};
  const TRIE_MAX = 7; // longest word the solver / stuck-detector looks for

  function buildTrie(words) {
    const t = {};
    for (const w of words) {
      if (w.length > TRIE_MAX) continue;
      let node = t;
      for (const ch of w) node = node[ch] || (node[ch] = {});
      node.$ = 1;
    }
    return t;
  }

  function loadDictionary(words, commonWords) {
    dict = new Set(words);
    common = new Set(commonWords.filter((w) => w.length >= MIN_WORD && dict.has(w)));
    trie = buildTrie(dict);
    commonTrie = buildTrie(common);
  }

  /** Resolve a list of letters ('?' = wildcard) to a dictionary word, or null. */
  function matchWord(letters) {
    if (letters.length < MIN_WORD) return null;
    const q = letters.indexOf('?');
    if (q < 0) {
      const w = letters.join('');
      return dict.has(w) ? w : null;
    }
    let fallback = null;
    for (const ch of ALPHABET) {
      const copy = letters.slice();
      copy[q] = ch;
      const w = copy.join('');
      if (common.has(w)) return w; // prefer the word the player most likely meant
      if (!fallback && dict.has(w)) fallback = w;
    }
    return fallback;
  }

  const pathLetters = (cells, path) => path.map((i) => (cells[i].t === WILD ? '?' : cells[i].ch));

  // ---------------------------------------------------------------- generation

  function generate(dateKey, salt = 0) {
    const rng = mulberry32(hashString(`cascade:v${VERSION}:${dateKey}:${salt}`));
    const cells = new Array(SIZE).fill(null);
    let id = 0;

    const slots = [];
    for (let i = 0; i < SIZE; i++) {
      if (row(i) === FLOOR && WEIGHT_COLS.includes(col(i))) cells[i] = { id: id++, t: WEIGHT, ch: '' };
      else slots.push(i);
    }

    const stoneChoices = slots.filter((i) => row(i) >= 1 && row(i) < FLOOR);
    const stoneAt = stoneChoices[Math.floor(rng() * stoneChoices.length)];
    // The wildcard never starts in a weight column, so it can't lighten one for free.
    const wildChoices = slots.filter((i) => i !== stoneAt && row(i) < FLOOR && !WEIGHT_COLS.includes(col(i)));
    const wildAt = wildChoices[Math.floor(rng() * wildChoices.length)];
    cells[stoneAt] = { id: id++, t: STONE, ch: '' };
    cells[wildAt] = { id: id++, t: WILD, ch: '?' };

    const rareSeen = new Set();
    const draw = (weights) => {
      for (;;) {
        const ch = pickWeighted(rng, weights);
        if (RARE.has(ch)) {
          if (rareSeen.has(ch) || rareSeen.size >= 3) continue;
          rareSeen.add(ch);
        }
        return ch;
      }
    };

    // Weight columns start clearly heavy (one vowel, the rest consonants);
    // the middle columns are vowel-rich so the board always has words in it.
    for (let c = 0; c < COLS; c++) {
      const open = [];
      for (let r = 0; r < ROWS; r++) if (!cells[r * COLS + c]) open.push(r * COLS + c);
      const vowels = WEIGHT_COLS.includes(c) ? 1 : Math.round(open.length / 2);
      const letters = open.map((_, k) => draw(k < vowels ? VOWEL_WEIGHTS : CONSONANT_WEIGHTS));
      shuffle(rng, letters);
      open.forEach((i, k) => { cells[i] = { id: id++, t: LETTER, ch: letters[k] }; });
    }

    const queue = Array.from({ length: COLS }, () =>
      Array.from({ length: rules.reserve }, () =>
        ({ id: id++, t: LETTER, ch: draw(rng() < rules.chuteVowels ? VOWEL_WEIGHTS : CONSONANT_WEIGHTS) })));
    return { cells, queue };
  }

  // ---------------------------------------------------------------- physics

  /**
   * Packed lexical gravity: every disturbed column closes up onto the floor (or its weight),
   * with vowels & wildcard rising above consonants & stone, like oil on water.
   * Untouched columns keep their order. Returns true if anything moved.
   */
  function settlePacked(cells, dirty) {
    let movedAny = false;
    for (const c of dirty) {
      const weight = cells[FLOOR * COLS + c] && cells[FLOOR * COLS + c].t === WEIGHT ? cells[FLOOR * COLS + c] : null;
      const tiles = [];
      for (let r = 0; r < ROWS; r++) {
        const t = cells[r * COLS + c];
        if (t && t !== weight) tiles.push(t);
      }
      const stack = tiles.filter(isBuoyant).concat(tiles.filter((t) => !isBuoyant(t)));
      const bottom = weight ? FLOOR - 1 : FLOOR;
      for (let r = 0; r <= bottom; r++) {
        const k = stack.length - (bottom - r) - 1;
        const t = k >= 0 ? stack[k] : null;
        if (cells[r * COLS + c] !== t) movedAny = true;
        cells[r * COLS + c] = t;
      }
    }
    dirty.clear();
    return movedAny;
  }

  /** Lexical gravity: consonants & stone sink, vowels & wildcard float. Returns true if anything moved. */
  function settle(cells, dirty) {
    if (rules.gravity === 'packed') return settlePacked(cells, dirty);
    let movedAny = false;
    for (let changed = true; changed; ) {
      changed = false;
      for (let r = FLOOR - 1; r >= 0; r--) {
        for (let c = 0; c < COLS; c++) {
          const i = r * COLS + c;
          const t = cells[i];
          if (t && isDense(t) && !cells[i + COLS]) {
            cells[i + COLS] = t;
            cells[i] = null;
            changed = true;
          }
        }
      }
      for (let r = 1; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const i = r * COLS + c;
          const t = cells[i];
          if (t && isBuoyant(t) && !cells[i - COLS]) {
            cells[i - COLS] = t;
            cells[i] = null;
            changed = true;
          }
        }
      }
      movedAny = movedAny || changed;
    }
    return movedAny;
  }

  /** Floaters minus sinkers in a column (stone counts as a sinker). */
  function buoyancy(cells, c) {
    let n = 0;
    for (let r = 0; r < FLOOR; r++) {
      const t = cells[r * COLS + c];
      if (t) n += isBuoyant(t) ? 1 : -1;
    }
    return n;
  }

  function weightIsFree(cells, c) {
    if (rules.weightDrops === 'light') return buoyancy(cells, c) > 0 || columnEmptyAbove(cells, c);
    if (rules.weightDrops === 'gap') {
      const above = cells[(FLOOR - 1) * COLS + c];
      return !above || (rules.gravity === 'packed' && isBuoyant(above));
    }
    for (let r = 0; r < FLOOR; r++) if (cells[r * COLS + c]) return false;
    return true;
  }

  /** Weights with nothing left above them fall off the board. Returns dropped weight ids. */
  function dropWeights(cells, dirty) {
    const dropped = [];
    for (let c = 0; c < COLS; c++) {
      const i = FLOOR * COLS + c;
      const t = cells[i];
      if (t && t.t === WEIGHT && weightIsFree(cells, c)) {
        cells[i] = null;
        dropped.push(t.id);
        dirty.add(c);
      }
    }
    return dropped;
  }

  const columnEmptyAbove = (cells, c) => {
    for (let r = 0; r < FLOOR; r++) if (cells[r * COLS + c]) return false;
    return true;
  };
  const columnEmpty = (cells, c) => {
    for (let r = 0; r < ROWS; r++) if (cells[r * COLS + c]) return false;
    return true;
  };
  const anyTilesIn = (cells, from, to) => {
    for (let c = from; c <= to; c++) if (!columnEmpty(cells, c)) return true;
    return false;
  };
  const moveColumn = (cells, from, to) => {
    for (let r = 0; r < ROWS; r++) {
      cells[r * COLS + to] = cells[r * COLS + from];
      cells[r * COLS + from] = null;
    }
  };

  /** Lateral collapse: empty columns are closed by shifting outer columns toward the centre. */
  function pinch(cells) {
    let movedAny = false;
    for (let guard = 0; guard < COLS * COLS; guard++) {
      let moved = false;
      for (const c of [CENTER, CENTER - 1, CENTER + 1, CENTER - 2, CENTER + 2]) {
        if (c < 0 || c >= COLS || !columnEmpty(cells, c)) continue;
        const left = c > 0 && anyTilesIn(cells, 0, c - 1);
        const right = c < COLS - 1 && anyTilesIn(cells, c + 1, COLS - 1);
        if (c >= CENTER && right) {
          for (let k = c; k < COLS - 1; k++) moveColumn(cells, k + 1, k);
          moved = true;
        } else if (c <= CENTER && left) {
          for (let k = c; k > 0; k--) moveColumn(cells, k - 1, k);
          moved = true;
        }
        if (moved) break;
      }
      if (!moved) break;
      movedAny = true;
    }
    return movedAny;
  }

  /** Each column's chute drops its next tile into an empty top cell. Returns the ids that entered. */
  function refill(cells, queue, dirty) {
    const entered = [];
    for (let c = 0; c < COLS; c++) {
      if (!cells[c] && queue[c].length) {
        const t = queue[c][0];
        queue[c] = queue[c].slice(1);
        cells[c] = t;
        entered.push(t.id);
        dirty.add(c);
      }
    }
    return entered;
  }

  function positionsById(cells) {
    const pos = new Map();
    cells.forEach((t, i) => t && pos.set(t.id, i));
    return pos;
  }

  /** A line of tiles only counts as "newly formed" if its tiles didn't all move together. */
  function isNewFormation(cells, path, start) {
    let dr = null;
    let dc = null;
    for (const i of path) {
      const s = start.get(cells[i].id);
      if (s === undefined) return true; // arrived from a chute this move
      const r = row(i) - row(s);
      const c = col(i) - col(s);
      if (dr === null) { dr = r; dc = c; } else if (r !== dr || c !== dc) return true;
    }
    return false;
  }

  /** Longest common word the last shuffle created on its own, reading → or ↓ (and ↘ ↗ if enabled). */
  function findCascade(cells, start) {
    let best = null;
    for (const line of linesToRead()) {
      let a = 0;
      while (a < line.length) {
        if (!cells[line[a]] || cells[line[a]].t !== LETTER) { a++; continue; }
        let b = a;
        while (b < line.length && cells[line[b]] && cells[line[b]].t === LETTER) b++;
        for (let s = a; s < b; s++) {
          for (let e = b; e - s >= MIN_WORD; e--) {
            if (best && e - s <= best.path.length) break;
            const seg = line.slice(s, e);
            const w = seg.map((i) => cells[i].ch).join('');
            if (common.has(w) && isNewFormation(cells, seg, start)) best = { word: w, path: seg };
          }
        }
        a = b;
      }
    }
    return best;
  }

  /** Remove the given tiles plus any stone touching them. */
  function clearTiles(cells, path, dirty) {
    const ids = [];
    const stones = [];
    const set = new Set(path);
    for (const i of path) {
      ids.push(cells[i].id);
      for (const n of NEIGHBORS[i]) {
        const t = cells[n];
        if (t && t.t === STONE && !set.has(n)) {
          set.add(n);
          stones.push(t.id);
          cells[n] = null;
          dirty.add(col(n));
        }
      }
      cells[i] = null;
      dirty.add(col(i));
    }
    return { ids, stones };
  }

  const countWeights = (cells) => cells.reduce((n, t) => n + (t && t.t === WEIGHT ? 1 : 0), 0);

  /**
   * Play a word and run the board until it is still.
   * Returns the new board, what happened, and (if trackPhases) a list of
   * snapshots for the UI to animate: pop → settle → drop → pinch → cascade → …
   */
  function resolveMove(state, path, { trackPhases = true } = {}) {
    const cells = state.cells.slice();
    const queue = state.queue.slice();
    const start = positionsById(cells);
    const phases = [];
    const snap = (phase) => trackPhases && phases.push(Object.assign(phase, { cells: cells.slice(), queue: queue.slice() }));

    const word = matchWord(pathLetters(cells, path));
    const usedWild = path.some((i) => cells[i].t === WILD);
    const dirty = new Set();
    const popped = clearTiles(cells, path, dirty);
    snap({ type: 'pop', word, ids: popped.ids, stones: popped.stones });

    let weights = 0;
    let pinches = 0;
    const cascades = [];
    for (let guard = 0; guard < 64; guard++) {
      if (settle(cells, dirty)) snap({ type: 'settle' });
      const dropped = dropWeights(cells, dirty);
      if (dropped.length) {
        weights += dropped.length;
        snap({ type: 'drop', ids: dropped });
        continue;
      }
      if (pinch(cells)) {
        pinches++;
        snap({ type: 'pinch' });
        continue;
      }
      const entered = refill(cells, queue, dirty);
      if (entered.length) {
        snap({ type: 'refill', ids: entered });
        continue;
      }
      const found = findCascade(cells, start);
      if (found) {
        const cleared = clearTiles(cells, found.path, dirty);
        cascades.push(found.word);
        snap({ type: 'cascade', word: found.word, chain: cascades.length, ids: cleared.ids, stones: cleared.stones });
        continue;
      }
      break;
    }

    return { state: { cells, queue }, phases, word, usedWild, weights, pinches, cascades, weightsLeft: countWeights(cells) };
  }

  // ---------------------------------------------------------------- search

  /**
   * Every distinct playable tile-set on the board (one word per set of tiles).
   * commonOnly restricts to everyday words — what par is measured against.
   */
  function findAllWords(cells, { allowWild = false, limit = Infinity, commonOnly = false } = {}) {
    const found = new Map();
    const path = [];
    const used = new Uint8Array(SIZE);
    let done = false;

    function dfs(i, node, word) {
      const t = cells[i];
      const choices = t.t === WILD ? (allowWild ? ALPHABET : '') : t.ch;
      for (const ch of choices) {
        const next = node[ch];
        if (!next) continue;
        path.push(i);
        used[i] = 1;
        const w = word + ch;
        if (next.$ && path.length >= MIN_WORD) {
          const key = path.slice().sort((x, y) => x - y).join(',');
          if (!found.has(key)) {
            found.set(key, { word: w, path: path.slice() });
            if (found.size >= limit) done = true;
          }
        }
        if (!done && path.length < TRIE_MAX) {
          for (const n of NEIGHBORS[i]) {
            if (!used[n] && isSpellable(cells[n])) dfs(n, next, w);
            if (done) break;
          }
        }
        path.pop();
        used[i] = 0;
        if (done) return;
      }
    }

    const top = commonOnly ? commonTrie : trie;
    for (let i = 0; i < SIZE && !done; i++) if (isSpellable(cells[i])) dfs(i, top, '');
    return [...found.values()];
  }

  const hasAnyWord = (cells) => findAllWords(cells, { allowWild: true, limit: 1 }).length > 0;

  const signature = (state) => state.cells.map((t) => (t ? t.ch || t.t : '.')).join('') + state.queue.map((q) => q.length).join('');

  /** Lower is better: weights left, and how much still sits on them. */
  function heuristic(cells) {
    let h = 0;
    let vowels = 0;
    let consonants = 0;
    for (const t of cells) {
      if (!t || t.t !== LETTER) continue;
      if (VOWELS.has(t.ch)) vowels++; else consonants++;
    }
    for (let c = 0; c < COLS; c++) {
      const w = cells[FLOOR * COLS + c];
      if (!w || w.t !== WEIGHT) continue;
      h += 10;
      if (rules.weightDrops === 'light') {
        h += 3 * Math.max(0, 1 - buoyancy(cells, c));
        continue;
      }
      for (let r = 0; r < FLOOR; r++) {
        const t = cells[r * COLS + c];
        if (!t) continue;
        if (rules.weightDrops === 'gap' && !isDense(t)) continue;
        h += t.t === STONE ? 4 : 3;
      }
    }
    if (vowels === 0) h += 40;
    return h - Math.min(vowels, consonants) * 0.25;
  }

  /** Beam search for a short solution using everyday words and no wildcard. Returns { moves } or null. */
  function solve(start, { beam = 24, maxDepth = 12 } = {}) {
    let frontier = [{ state: start, moves: [] }];
    const seen = new Set([signature(start)]);
    for (let depth = 1; depth <= maxDepth; depth++) {
      const next = [];
      for (const node of frontier) {
        for (const m of findAllWords(node.state.cells, { commonOnly: true })) {
          const res = resolveMove(node.state, m.path, { trackPhases: false });
          const key = signature(res.state);
          if (seen.has(key)) continue;
          seen.add(key);
          const moves = node.moves.concat([{ word: res.word, path: m.path }]);
          if (res.weightsLeft === 0) return { moves };
          next.push({ state: res.state, moves, h: heuristic(res.state.cells) });
        }
      }
      if (!next.length) return null;
      next.sort((x, y) => x.h - y.h);
      frontier = next.slice(0, beam);
    }
    return null;
  }

  /**
   * The solver's suggested next word from this position. If it can't see a full
   * route, falls back to the single word that best lightens the weights; null only
   * when no everyday word is left on the board.
   */
  function hint(state) {
    const sol = solve(state, { beam: 12, maxDepth: 6 });
    if (sol && sol.moves.length) return sol.moves[0];
    let best = null;
    for (const m of findAllWords(state.cells, { commonOnly: true })) {
      const res = resolveMove(state, m.path, { trackPhases: false });
      const h = heuristic(res.state.cells) - res.weights * 10;
      if (!best || h < best.h) best = { h, word: res.word, path: m.path };
    }
    return best && { word: best.word, path: best.path };
  }

  // 1–5 stars from the solver's best line, like Currents' starsFor().
  const starsFor = (best) => Math.min(5, Math.max(1, best - 2));

  /** Today's puzzle: the first seed whose board the solver clears in a sensible number of moves. */
  function buildDaily(dateKey, { minBest = 4, maxBest = 9 } = {}) {
    for (let salt = 0; salt < 60; salt++) {
      const state = generate(dateKey, salt);
      if (rules.weightDrops === 'light' && WEIGHT_COLS.some((c) => buoyancy(state.cells, c) >= 0)) continue;
      const sol = solve(state);
      if (sol && sol.moves.length >= minBest && sol.moves.length <= maxBest) {
        const best = sol.moves.length;
        return { dateKey, salt, state, best, par: best + PAR_CUSHION, stars: starsFor(best), solution: sol.moves.map((m) => m.word) };
      }
    }
    throw new Error(`No solvable board for ${dateKey}`);
  }

  /** Identifies the exact rule set: anything cached against an older fingerprint is stale. */
  const fingerprint = () => `${VERSION}:${JSON.stringify(rules)}`;

  return {
    VERSION, fingerprint, COLS, ROWS, SIZE, FLOOR, MIN_WORD, LETTER, WEIGHT, STONE, WILD, rules,
    row, col, isAdjacent, isVowel, isBuoyant, isDense, isSpellable,
    loadDictionary, matchWord, pathLetters,
    generate, resolveMove, findAllWords, hasAnyWord, solve, hint, buildDaily, countWeights, starsFor, heuristic,
  };
});
