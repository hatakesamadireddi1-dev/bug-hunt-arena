# Bug Hunt Arena

Live multiplayer bug-spotting game for CS placement and interview prep. 2 to 8 players, 8 rounds, one buggy line per snippet.

**Play it live:** https://bug-hunt-arena.netlify.app

## How it works
- One player creates a room and shares the code. Friends join from any device.
- Each round shows a short code snippet in Python, JavaScript, Java or C with exactly one bug.
- Tap the buggy line before time runs out. Faster correct answers score more.
- After each round you see the fix and a short explanation.

## Tech stack
Plain HTML, CSS and JavaScript frontend. One Netlify Function in TypeScript. Netlify Blobs for room state. No external services.

## Roadmap
- Solo practice mode with timed rounds
- More snippets and topics (DSA, OS, DBMS, networks)
- Player accounts, rankings and progress history
- Difficulty picker and AI-generated challenges

## Deploy
Drag this folder (or the zip) into Netlify. Nothing else to set up: no accounts, keys, environment variables, or database.
- `public/` is the static frontend (plain HTML/CSS/JS, no build step) and is the publish folder.
- `netlify/functions/game.ts` is the only function. The frontend calls `/.netlify/functions/game` directly.
- Room state lives in Netlify Blobs (strong consistency, conditional writes with `onlyIfMatch` / `onlyIfNew`, bounded retries).

## Layout
- `src/engine.ts`: game rules (pure functions, no I/O). `src/snippets.ts` is generated from `snippets/*.txt`.
- `snippets/*.txt`: the 48-snippet bank (12 per language), human-editable. Run `npm run snippets` after editing.
- `tests/`: engine tests, handler tests with an in-memory Blobs mock, snippet execution harness and drivers, local dev server.

## Test (Node 22.6+, plus python3, java 11+, gcc for the snippet harness)
    npm install
    npm test          # executes all 48 snippets, then engine + handler tests
    npm run dev       # local server on http://localhost:8888 with an in-memory store
