// Engine checks: builds a run of daily boards and replays the solver's solutions,
// then exercises each rule on a small hand-built board.
// Usage: node scripts/test-engine.mjs [days]
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const E = require('../js/engine.js');
const ctx = { self: {} };
vm.runInNewContext(readFileSync(new URL('../js/words.js', import.meta.url), 'utf8'), ctx);
E.loadDictionary(ctx.self.CASCADE_WORDS.split(' '), ctx.self.CASCADE_COMMON.split(' '));

let failed = 0;
const assert = (cond, msg) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} - ${msg}`);
  if (!cond) failed++;
};

// ---- daily boards -------------------------------------------------------
const days = Number(process.argv[2] || 10);
const pars = {};
for (let d = 0; d < days; d++) {
  const date = new Date(Date.UTC(2026, 9, 26 + d)).toISOString().slice(0, 10);
  const t0 = performance.now();
  const daily = E.buildDaily(date);
  const ms = performance.now() - t0;
  pars[daily.par] = (pars[daily.par] || 0) + 1;
  let state = daily.state;
  for (const m of E.solve(state).moves) state = E.resolveMove(state, m.path).state;
  console.log(`${date} par ${daily.par} ★${daily.stars} ${ms.toFixed(0)}ms  ${daily.solution.join(' → ')}`);
  assert(E.countWeights(state.cells) === 0, `${date}: solver line drops every weight`);
}
console.log('par distribution', pars);

// ---- rule checks on hand-built boards ------------------------------------
let nextId = 1000;
const tile = (ch) => {
  if (ch === '.') return null;
  if (ch === '@') return { id: nextId++, t: E.WEIGHT, ch: '' };
  if (ch === '#') return { id: nextId++, t: E.STONE, ch: '' };
  if (ch === '?') return { id: nextId++, t: E.WILD, ch: '?' };
  return { id: nextId++, t: E.LETTER, ch };
};
const board = (rows, queue = ['', '', '', '', '']) => ({
  cells: rows.flatMap((line) => line.split(' ').map(tile)),
  queue: queue.map((q) => [...q].map(tile)),
});
const at = (r, c) => r * E.COLS + c;
const column = (cells, c) => Array.from({ length: E.ROWS }, (_, r) => cells[at(r, c)]).map((t) => (!t ? '.' : t.ch || t.t)).join('');

// Z-filled columns stay untouched and never spell anything.
{
  // RAT leaves S N on the weight; the chute drops E, I, O in and the column turns light.
  const st = board(['T Z Z Z Z', 'A Z Z Z Z', 'R Z Z Z Z', 'S Z Z Z Z', 'N Z Z Z Z', '@ Z Z Z Z'], ['EIO', '', '', '', '']);
  const res = E.resolveMove(st, [at(2, 0), at(1, 0), at(0, 0)]);
  assert(res.word === 'RAT', 'RAT is played');
  assert(res.weights === 1, 'chute vowels lift the column to more vowels than consonants: weight drops');
  assert(res.phases.some((p) => p.type === 'refill'), 'refill phase emitted for the UI');
}
{
  // Same move, consonant-heavy chute: the weight holds and the column sorts vowels on top.
  const st = board(['T Z Z Z Z', 'A Z Z Z Z', 'R Z Z Z Z', 'S Z Z Z Z', 'N Z Z Z Z', '@ Z Z Z Z'], ['PED', '', '', '', '']);
  const res = E.resolveMove(st, [at(2, 0), at(1, 0), at(0, 0)]);
  assert(res.weights === 0, 'weight holds while consonants outnumber vowels');
  assert(column(res.state.cells, 0) === 'EDPSNG', `column closes up with vowels above consonants (got ${column(res.state.cells, 0)})`);
  assert(column(res.state.cells, 1) === 'ZZZZZZ', 'untouched columns keep their order');
}
{
  // BOX leaves N A D; sorting lifts A over N, so AND reads down the column and clears for free.
  const st = board(['B Z Z Z Z', 'O Z Z Z Z', 'X Z Z Z Z', 'N Z Z Z Z', 'A Z Z Z Z', 'D Z Z Z Z']);
  const res = E.resolveMove(st, [at(0, 0), at(1, 0), at(2, 0)]);
  assert(res.cascades.join() === 'AND', `automatic cascade AND (got ${res.cascades.join() || 'none'})`);
  assert(res.phases.some((p) => p.type === 'cascade'), 'cascade phase emitted for the UI');
}
{
  // TOP touches the stone above it (smashed); column 1 empties, so column 0 pinches in.
  const st = board(['. . Z Z Z', '. . Z Z Z', '. # Z Z Z', '. T Z Z Z', '. O Z Z Z', 'K P Z Z Z']);
  const res = E.resolveMove(st, [at(3, 1), at(4, 1), at(5, 1)]);
  assert(!res.state.cells.some((t) => t && t.t === E.STONE), 'adjacent stone is smashed');
  assert(res.pinches > 0 && res.state.cells[at(5, 1)]?.ch === 'K', 'empty column pinches: outer column shifts toward the centre');
}
{
  // The walkthrough's practice board (TUTORIAL in js/app.js): its coach copy describes exactly this line.
  const st = board(['A I I I A', 'E O E O E', 'T O N E S', 'S E N T W', 'R C G D #', '@ R @ L @'],
    ['OUEAIOEAIU', 'PSAUIOEE', 'KLEIECBO', 'UAAHBIOA', 'EAGWORAA']);
  const rest = E.resolveMove(st, [at(4, 0), at(3, 1), at(3, 0), at(2, 0)]);
  assert(rest.word === 'REST' && rest.weights === 1 && !rest.cascades.length, 'walkthrough: REST drops the left weight, no cascade');
  const pace = E.resolveMove(rest.state, [at(3, 1), at(4, 0), at(4, 1), at(5, 0)]);
  assert(pace.word === 'PACE' && pace.cascades.join() === 'ONES' && pace.weights === 1 && pace.state.cells[at(5, 2)]?.t === E.WEIGHT,
    `walkthrough: PACE cascades ONES and drops the right weight (got ${pace.cascades.join() || 'none'})`);
  const kind = E.resolveMove(pace.state, [at(2, 2), at(2, 1), at(3, 2), at(4, 3)]);
  assert(kind.word === 'KIND' && kind.weightsLeft === 0 && kind.phases.some((p) => p.stones?.length) && !kind.cascades.length,
    'walkthrough: KIND smashes the stone and drops the last weight');
}
assert(E.matchWord(['C', '?', 'T']) !== null, 'wildcard C?T resolves to a word');
assert(E.matchWord(['Z', 'Z', 'Z']) === null, 'ZZZ is rejected');

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
