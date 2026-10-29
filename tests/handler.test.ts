import { test } from "node:test";
import assert from "node:assert/strict";
import handler, { __setTestHooks } from "../netlify/functions/game.ts";
import { MockStore } from "./mock-store.ts";
import { SNIPPETS } from "../src/snippets.ts";

let now = 10_000_000;
let store = new MockStore();
__setTestHooks({ store: () => store, clock: () => now });

const FORBIDDEN = ["bugLine", "explanation", "fixed"];
const DURING_PLAY = new Set(["countdown", "playing", "allin"]);
const leaks: string[] = [];

async function call(body: Record<string, unknown>) {
  const res = await handler(new Request("https://x.test/.netlify/functions/game", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  const text = await res.text();
  const data = JSON.parse(text);
  if (data.state && DURING_PLAY.has(data.state.phase)) {
    for (const k of FORBIDDEN) if (text.includes(`"${k}"`)) leaks.push(`${data.state.phase}:${k}`);
    if (text.includes('"correct"')) leaks.push(`${data.state.phase}:correct`);
  }
  return { status: res.status, ...data };
}
type Seat = { playerId: string; token: string; code: string };
const as = (s: Seat, action: string, extra = {}) => call({ action, code: s.code, playerId: s.playerId, token: s.token, ...extra });
const bugFor = (code: string) => {
  const room = store.room(code);
  return SNIPPETS.find((s) => s.id === room.plan[room.round - 1].snippetId)!.bugLine;
};

async function newGame(lang: string, n: number) {
  store = new MockStore();
  const c = await call({ action: "create", name: "Host", lang });
  assert.equal(c.ok, true);
  const code = c.state.code;
  const seats: Seat[] = [{ playerId: c.playerId, token: c.token, code }];
  for (let i = 1; i < n; i++) {
    const j = await call({ action: "join", code: code.toLowerCase(), name: `Player${i}` });
    assert.equal(j.ok, true, j.message);
    seats.push({ playerId: j.playerId, token: j.token, code });
  }
  return { code, seats };
}

const pollAll = (seats: Seat[]) => Promise.all(seats.map((s) => as(s, "state")));
async function playFullGame(lang: string, seats: Seat[], start = true) {
  const host = seats[0];
  if (start) {
    const s = await as(host, "start");
    assert.equal(s.state.phase, "countdown");
  }
  const seen: string[] = [];
  for (let round = 1; round <= 8; round++) {
    let st = await as(host, "state");
    assert.equal(st.state.phase, "countdown");
    assert.equal(st.state.round, round);
    assert.ok(st.state.badge.language && st.state.badge.difficulty);
    assert.equal(st.state.snippet, undefined, "code hidden during countdown");
    now += 3000;
    await pollAll(seats);
    st = await as(host, "state");
    assert.equal(st.state.phase, "playing");
    assert.ok(st.state.snippet.code.length >= 5);
    seen.push(store.room(host.code).plan[round - 1].snippetId);
    const bug = bugFor(host.code);
    for (let i = 0; i < seats.length; i++) {
      now += 500;
      const line = i === seats.length - 1 && round % 2 === 0 ? (bug % st.state.snippet.code.length) + 1 : bug;
      const a = await as(seats[i], "answer", { line });
      assert.equal(a.ok, true, a.message);
      assert.equal(a.state.myLine, line);
    }
    st = await as(host, "state");
    assert.equal(st.state.phase, "allin");
    now += 1000;
    st = await as(seats[1], "state");
    assert.equal(st.state.phase, "reveal");
    assert.equal(st.state.reveal.bugLine, bug);
    now += 8000;
    await pollAll(seats);
    st = await as(host, "state");
    assert.equal(st.state.phase, "leaderboard");
    assert.ok(st.state.players.some((p: any) => p.lastPoints > 0));
    if (round % 2 === 0) { now += 15000; await pollAll(seats); st = await as(seats[1], "state"); }
    else st = await as(host, "next");
    assert.equal(st.ok, true, st.message);
    assert.equal(st.state.phase, round === 8 ? "finished" : "countdown");
  }
  assert.equal(new Set(seen).size, 8, "no snippet repeated within a game");
  const fin = await as(seats[0], "state");
  assert.equal(fin.state.final.length, seats.length);
  assert.equal(fin.state.review.length, 8);
  return { fin, seen };
}

test("complete game through the handler: create, join, start, 8 rounds, finish, play again", async () => {
  const { seats } = await newGame("python", 3);
  const { fin, seen } = await playFullGame("python", seats);
  const hostRow = fin.state.final.find((r: any) => r.id === seats[0].playerId);
  assert.equal(hostRow.accuracy, 100);
  assert.equal(hostRow.correct, 8);
  const loser = fin.state.final.find((r: any) => r.id === seats[2].playerId);
  assert.equal(loser.correct, 4);
  const pa = await as(seats[1], "playAgain");
  assert.equal(pa.error, "NOT_HOST");
  const again = await as(seats[0], "playAgain");
  assert.equal(again.state.phase, "countdown");
  assert.equal(again.state.round, 1);
  assert.ok(again.state.players.every((p: any) => p.score === 0));
  assert.equal(again.state.players.length, 3);
  const plan2 = store.room(seats[0].code).plan.map((p: any) => p.snippetId);
  assert.ok(plan2.filter((id: string) => seen.includes(id)).length < 8);
  await playFullGame("python", seats, false); // second game also completes
});

for (const lang of ["python", "javascript", "java", "c", "mixed"]) {
  test(`full 8-round game in ${lang} with no bank exhaustion`, async () => {
    const { seats } = await newGame(lang, 2);
    const { seen } = await playFullGame(lang, seats);
    const langs = seen.map((id) => SNIPPETS.find((s) => s.id === id)!.language);
    if (lang === "mixed") {
      for (const l of ["python", "javascript", "java", "c"]) assert.equal(langs.filter((x) => x === l).length, 2);
    } else assert.ok(langs.every((l) => l === lang));
  });
}

test("concurrency: 4 players answer the same round at the same moment", async () => {
  let raced = 0;
  for (let trial = 0; trial < 10; trial++) {
    const { code, seats } = await newGame("mixed", 4);
    await as(seats[0], "start");
    now += 3000;
    await as(seats[0], "state");
    const bug = bugFor(code);
    now += 1234;
    const before = store.conflicts;
    const results = await Promise.all(seats.map((s) => as(s, "answer", { line: bug })));
    for (const r of results) assert.equal(r.ok, true, r.message);
    const room = store.room(code);
    assert.equal(Object.keys(room.answers).length, 4);
    for (const s of seats) assert.equal(room.answers[s.playerId].line, bug);
    assert.equal(room.phase, "allin");
    raced += store.conflicts - before;
  }
  assert.ok(raced > 0, "write conflicts actually occurred and were retried");
  console.log(`  concurrency: ${raced} lost write races were retried successfully over 10 trials`);
});

test("polling is read-only between heartbeats", async () => {
  const { seats } = await newGame("java", 2);
  const w0 = store.writes;
  for (let i = 0; i < 9; i++) { now += 1000; for (const s of seats) await as(s, "state"); }
  assert.equal(store.writes, w0, "no writes for 9 s of polling in lobby");
  now += 1000;
  await as(seats[0], "state");
  assert.equal(store.writes, w0 + 1, "one heartbeat write after 10 s");
});

test("friendly errors: room not found, name taken, room full, finished", async () => {
  const nf = await call({ action: "join", code: "ZZZZZZ", name: "Bob" });
  assert.equal(nf.status, 404);
  assert.equal(nf.message, "We couldn't find that room. Check the code and try again.");
  const { code, seats } = await newGame("c", 8);
  const full = await call({ action: "join", code, name: "Ninth" });
  assert.equal(full.error, "ROOM_FULL");
  const taken = await call({ action: "join", code, name: "player1" });
  assert.equal(taken.message, "That name is taken in this room, try another.");
  const bad = await call({ action: "explode" });
  assert.equal(bad.ok, false);
  const r = await handler(new Request("https://x.test/", { method: "POST", body: "not json" }));
  assert.equal((await r.json()).error, "BAD_REQUEST");
  const fin = await newGame("python", 2);
  await playFullGame("python", fin.seats);
  const late = await call({ action: "join", code: fin.code, name: "Latecomer" });
  assert.equal(late.error, "GAME_FINISHED");
  void seats;
});

test("late joiner and host migration through the handler", async () => {
  const { code, seats } = await newGame("javascript", 3);
  await as(seats[0], "start");
  now += 3000;
  await as(seats[1], "state");
  const late = await call({ action: "join", code, name: "Late" });
  assert.equal(late.state.pending, true);
  // host vanishes for 21 s while others keep polling
  for (let i = 0; i < 21; i++) { now += 1000; await as(seats[1], "state"); await as(seats[2], "state"); await call({ action: "state", code, playerId: late.playerId, token: late.token }); }
  const st = await as(seats[1], "state");
  assert.equal(st.state.hostId, seats[1].playerId);
  assert.equal(st.state.notice.text, "Player1 is now the host.");
  const back = await as(seats[0], "rejoin");
  assert.equal(back.state.isHost, false);
});

test("security: no bugLine/explanation/fixed in any response during play", () => {
  assert.deepEqual(leaks, []);
});
