// Balance check for the current engine rules: daily build time, par spread, and how a
// goal-aware casual player fares (everyday words only, picks at random among the 5
// moves that look best one move ahead).
// Usage: node scripts/balance.mjs [days]   ·   override rules: RULES='{"diagonals":true}'
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const E = require('../js/engine.js');
const ctx = { self: {} };
vm.runInNewContext(readFileSync(new URL('../js/words.js', import.meta.url), 'utf8'), ctx);
E.loadDictionary(ctx.self.CASCADE_WORDS.split(' '), ctx.self.CASCADE_COMMON.split(' '));
if (process.env.RULES) Object.assign(E.rules, JSON.parse(process.env.RULES));
const days = +(process.argv[2] || 10);
let seed = 11; const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const bests = {}; let ms = 0, salts = 0, fails = 0;
let runs = 0, clears = 0, clearMoves = 0, dead = 0, capped = 0, moves = 0, cas = 0, pinch = 0, overPar = [];
for (let d = 0; d < days; d++) {
  const date = new Date(Date.UTC(2026, 9, 26 + d)).toISOString().slice(0, 10);
  const t0 = performance.now();
  let daily; try { daily = E.buildDaily(date); } catch { fails++; continue; }
  ms += performance.now() - t0; salts += daily.salt + 1;
  bests[daily.best] = (bests[daily.best] || 0) + 1;
  for (let k = 0; k < 2; k++) {
    runs++; let b = daily.state, n = 0;
    for (; n < 25; n++) {
      const words = E.findAllWords(b.cells, { commonOnly: true });
      if (!words.length) { dead++; n = -1; break; }
      const sc = words.map((w) => ({ r: E.resolveMove(b, w.path, { trackPhases: false }) })).map((x) => ({ ...x, h: E.heuristic(x.r.state.cells) - x.r.weights * 10 })).sort((x, y) => x.h - y.h).slice(0, 5);
      const res = sc[Math.floor(rand() * sc.length)].r;
      moves++; cas += res.cascades.length ? 1 : 0; pinch += res.pinches ? 1 : 0;
      b = res.state;
      if (res.weightsLeft === 0) { clears++; clearMoves += n + 1; overPar.push(n + 1 - daily.par); n = -2; break; }
    }
    if (n === 25) capped++;
  }
}
console.log(JSON.stringify(E.rules), `\n build: ${(ms / (days - fails)).toFixed(0)}ms avg, ${(salts / (days - fails)).toFixed(1)} seeds tried, ${fails} days failed | solver best ${JSON.stringify(bests)}` +
  `\n casual: clears ${clears}/${runs} in ${(clearMoves / clears).toFixed(1)} moves (vs par ${overPar.length ? (overPar.reduce((a, b) => a + b, 0) / overPar.length).toFixed(1) : '-'}), dead-ends ${dead}, gave up at 25: ${capped} | cascade/move ${(cas / moves).toFixed(2)} pinch/move ${(pinch / moves).toFixed(2)}`);
