# Cascade

A daily word puzzle with lexical gravity, from the same workshop as Tumbler, Currents and Typeset. Vowels rise and consonants sink. Spell words to lighten the columns and drop all three weights off the board in as few moves as you can.

## Run it

No build step and no dependencies. Open `index.html` in a browser (it works from `file://`), or serve the folder:

```sh
npx serve .            # or: python3 -m http.server
```

URL parameters for testing:

- `?date=2026-11-03` opens another day's board.
- `?debug` logs the par solver's line to the console.

## Rules

1. **Spell words.** Drag (or tap) through touching tiles, diagonals included, to make a word of 3+ letters. Each word is one move.
2. **Oil and water.** After a word, every column it touched closes up. Vowels rise above consonants, and new tiles drop in from the chute above the column. The next two tiles in each chute are shown. Untouched columns keep their order.
3. **Drop the weights.** A weight breaks loose once its column holds **more vowels than consonants** (stone counts as a consonant). The ▲/▼ meter under each weight keeps count.
4. **Cascades.** If the shifting tiles line up an everyday word on their own, reading → or ↓, it clears for free. Cascades can chain.
5. **Stone** can't be spelled and sinks like a consonant. A word touching it smashes it.
6. **Wildcard (?)** can be any letter, but a word that uses it costs 2 moves.
7. **Pinch.** A column that empties completely is closed up by shifting the outer columns toward the centre.
8. **Par** is the solver's best line + 1. Finishing under par earns a Birdie (−1) or Eagle (−2 or better), as in Currents.

## Why the rules changed from the original spec

The first build followed the spec literally: vowels float into gaps, consonants fall into gaps, and anchors drop when the cell above them is empty. Playtesting with the solver and a simulated casual player showed three problems:

| Problem | Evidence | Fix |
| --- | --- | --- |
| The physics separates the board | In ~70% of dead ends, no vowel touched any consonant: vowels on the ceiling, consonants on the floor, an empty band between | **Packed gravity**: columns close up, vowels sit *above* consonants, so the two layers always touch |
| The board runs dry | Without refill, ~95% of random games got stuck | **Chutes**: each column has a seeded queue of 20 tiles, half of them vowels |
| Vowels didn't matter | The objective was "delete every consonant in columns 1, 3 and 5" | **Buoyancy rule**: a weight drops when vowels outnumber consonants. Spend consonants and save vowels, so long consonant-heavy words pay off |

Diagonal cascades were also tried. With packed gravity they fired on 34% of moves, including chains of five, so they're off (`rules.diagonals`).

Current numbers (`node scripts/balance.mjs 10`):

- Par: 5–7.
- Daily board build: ~65ms.
- Casual-player bot: clears 17 of 20 runs.
- Cascades fire on ~24% of moves.
- Hint lookups: ~13ms median.

## Shared workshop conventions

Cascade deliberately matches its sibling games:

- **Design tokens:** the same palette, Fraunces and Libre Franklin fonts, 10px corners, and dark mode, copied from Currents.
- **Masthead:** ? / archive / stats on the left, More games / theme on the right.
- **Modals:** the `.win` card with an × close; a Typeset-style slide deck for How to play.
- **Grades and stats:** Eagle / Birdie / Par / Bogey / Over, using Currents' stats schema (`played`, `currentStreak`, `maxStreak`, `lastWonDay`, `dist`). Only today's solve counts toward the streak.
- **Hint and share:** a gold hint glow (first press shows the start tile, second shows the whole word). The share text uses Currents' format: `Cascade #N ★★★ / BIRDIE · 5/6 · 🔥3 · 💡1`, then one 🟢 per move, ⚡ per cascade and ⚫ per weight dropped.
- **More games:** cards for Tumbler, Currents and Typeset, plus a Keep playing row on the results card.
- **Daily leaderboard:** Typeset's design and flow (trophy button, Today/Yesterday tabs, a name card on first win), stored in the shared Firebase under `cascade/daily/{day}/{playerId}`. Score is moves + hint taps (a wildcard word already counts as 2 moves), lower is better; ties go to the faster solve. Only the first win on today's board posts. Replays and archive solves never do. The clock runs while the board is on screen and pauses while the tab is hidden; undo and reset don't rewind it.

Puzzle #1 is **27 Oct 2026**, launch day (`EPOCH` in `js/app.js`).

## Files

| Path | What it is |
| --- | --- |
| `index.html`, `css/styles.css` | Page shell, modals and styles (shared tokens + the board) |
| `js/engine.js` | Pure game logic: seeded generation, gravity, chutes, weights, pinch, cascades, solver, hint. Runs in Node too. Rule knobs live in `rules`. |
| `js/app.js` | UI: drag/tap input, phase-by-phase animation, undo/reset, hint, archive, stats, share |
| `js/words.js` | Generated dictionary: ENABLE for valid words, ~7k common words for cascades, par and hints |
| `scripts/build-words.mjs` | Rebuilds `js/words.js` from `data/` |
| `scripts/test-engine.mjs` | Replays the solver on daily boards and checks each rule on hand-built boards |
| `scripts/balance.mjs` | Par spread, build time and casual-player outcomes; `RULES='{"diagonals":true}'` tries variants |

```sh
node scripts/build-words.mjs
node scripts/test-engine.mjs 10
node scripts/balance.mjs 10
```

Progress (per day, including the clock), stats, theme, the daily seed cache and the leaderboard name/player ID are stored in `localStorage`.
