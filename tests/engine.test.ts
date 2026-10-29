import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createRoom, applyAction, tick, buildPlan, mixedLanguageOrder, scoreFor, ranked, viewFor, snippetById,
  DIFFICULTY_BY_ROUND, LANGUAGES, CODE_ALPHABET, makeRoomCode, DISCONNECT_MS, ROUNDS,
} from "../src/engine.ts";
import type { Room, Rng } from "../src/engine.ts";
import { SNIPPETS } from "../src/snippets.ts";

const seeded = (seed: number): Rng => () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

function setup(lang = "python", n = 3, rng = seeded(1)) {
  let now = 1_000_000;
  const { room, player: host } = createRoom("ABCDEF", "Host", lang, now, rng);
  const players = [host];
  for (let i = 1; i < n; i++) {
    const r = applyAction(room, { type: "JOIN", name: `P${i}` }, now, rng);
    players.push(room.players.find((p) => p.id === r.playerId)!);
  }
  return { room, players, rng, now };
}
const act = (room: Room, p: { id: string; token: string }, type: string, now: number, rng: Rng, extra = {}) =>
  applyAction(room, { type, playerId: p.id, token: p.token, ...extra } as never, now, rng);
const bug = (room: Room) => snippetById(room.plan[room.round - 1].snippetId).bugLine;

test("scoring formula, clamped to 0..30 s", () => {
  assert.equal(scoreFor(0), 150);
  assert.equal(scoreFor(15000), 125);
  assert.equal(scoreFor(30000), 100);
  assert.equal(scoreFor(45000), 100);
  assert.equal(scoreFor(-5), 150);
  assert.equal(scoreFor(10000), Math.round(100 + 50 * (1 - 10 / 30)));
});

test("room codes avoid confusing characters", () => {
  for (const ch of "0O1I") assert.ok(!CODE_ALPHABET.includes(ch));
  const rng = seeded(7);
  for (let i = 0; i < 500; i++) assert.match(makeRoomCode(rng), /^[A-HJ-NP-Z2-9]{6}$/);
});

test("difficulty order and no repeats for every language", () => {
  for (const lang of [...LANGUAGES, "mixed"] as const) {
    for (let seed = 1; seed <= 200; seed++) {
      const plan = buildPlan(lang, seeded(seed));
      assert.equal(plan.length, 8);
      assert.deepEqual(plan.map((p) => p.difficulty), DIFFICULTY_BY_ROUND);
      assert.equal(new Set(plan.map((p) => p.snippetId)).size, 8);
      for (const p of plan) {
        const s = snippetById(p.snippetId);
        assert.equal(s.language, p.language);
        assert.equal(s.difficulty, p.difficulty);
        if (lang !== "mixed") assert.equal(s.language, lang);
      }
    }
  }
});

test("mixed mode: each language exactly twice, never 3 in a row", () => {
  for (let seed = 1; seed <= 2000; seed++) {
    const order = mixedLanguageOrder(seeded(seed));
    for (const l of LANGUAGES) assert.equal(order.filter((x) => x === l).length, 2);
    for (let i = 2; i < order.length; i++) assert.ok(!(order[i] === order[i - 1] && order[i] === order[i - 2]));
  }
});

test("bank has 3 snippets per language/difficulty bucket", () => {
  assert.equal(SNIPPETS.length, 48);
  for (const l of LANGUAGES) for (const d of new Set(DIFFICULTY_BY_ROUND))
    assert.equal(SNIPPETS.filter((s) => s.language === l && s.difficulty === d).length, 3);
});

test("nickname rules: trim, 2-18 chars, case-insensitive unique", () => {
  const { room, rng, now } = setup("python", 1);
  assert.throws(() => applyAction(room, { type: "JOIN", name: " a " }, now, rng), /2 to 18/);
  assert.throws(() => applyAction(room, { type: "JOIN", name: "x".repeat(19) }, now, rng), /2 to 18/);
  assert.throws(() => applyAction(room, { type: "JOIN", name: "  hOsT " }, now, rng), (e: Error) => e.message === "That name is taken in this room, try another.");
  const r = applyAction(room, { type: "JOIN", name: "  Zed  " }, now, rng);
  assert.equal(room.players.find((p) => p.id === r.playerId)!.name, "Zed");
});

test("room full at 8 players", () => {
  const { room, rng, now } = setup("python", 8);
  assert.throws(() => applyAction(room, { type: "JOIN", name: "Ninth" }, now, rng), /full/);
});

test("only host starts, needs 2 players", () => {
  const solo = setup("python", 1);
  assert.throws(() => act(solo.room, solo.players[0], "START", solo.now, solo.rng), /at least 2/);
  const { room, players, rng, now } = setup();
  assert.throws(() => act(room, players[1], "START", now, rng), /Only the host/);
  act(room, players[0], "START", now, rng);
  assert.equal(room.phase, "countdown");
});

test("full round flow, scoring, early all-in, tie-break", () => {
  const { room, players, rng } = setup("javascript", 3);
  let now = 2_000_000;
  for (const p of players) p.lastSeen = now;
  act(room, players[0], "START", now, rng);
  now += 3000; tick(room, now);
  assert.equal(room.phase, "playing");
  const t0 = room.phaseStartedAt;
  act(room, players[0], "ANSWER", t0 + 6000, rng, { line: bug(room) });
  act(room, players[1], "ANSWER", t0 + 6000, rng, { line: bug(room) });
  const wrong = bug(room) === 1 ? 2 : 1;
  act(room, players[2], "ANSWER", t0 + 7000, rng, { line: wrong });
  assert.equal(room.phase, "allin");
  assert.throws(() => act(room, players[2], "ANSWER", t0 + 7000, rng, { line: bug(room) }), /isn't possible|already/);
  tick(room, t0 + 8000);
  assert.equal(room.phase, "reveal");
  assert.equal(players[0].score, scoreFor(6000));
  assert.equal(players[0].score, 140);
  assert.equal(players[2].score, 0);
  // tie-break: same points, lower total correct time ranks higher
  players[0].correctMs = 9000; players[1].correctMs = 4000;
  assert.deepEqual(ranked(room.players).map((p) => p.name), ["P1", "Host", "P2"]);
});

test("wrong tap locks out; disconnected players don't block the round", () => {
  const { room, players, rng } = setup("c", 3);
  let now = 3_000_000;
  for (const p of players) p.lastSeen = now;
  act(room, players[0], "START", now, rng);
  now += 3000; tick(room, now);
  players[2].lastSeen = now - DISCONNECT_MS - 1; // P2 gone
  act(room, players[0], "ANSWER", now + 1000, rng, { line: bug(room) });
  assert.equal(room.phase, "playing");
  act(room, players[1], "ANSWER", now + 2000, rng, { line: (bug(room) % 3) + 1 });
  assert.equal(room.phase, "allin");
});

test("round times out at 30 s with no answers", () => {
  const { room, players, rng } = setup("java", 2);
  let now = 4_000_000;
  for (const p of players) p.lastSeen = now;
  act(room, players[0], "START", now, rng);
  tick(room, now + 3000);
  for (const p of players) p.lastSeen = now + 25000;
  tick(room, now + 3000 + 30000);
  assert.equal(room.phase, "reveal");
  assert.ok(players.every((p) => p.score === 0 && p.history[0].line === null));
});

test("host migration to earliest-joined connected player; old host returns as normal player", () => {
  const { room, players, rng } = setup("python", 3);
  let now = 5_000_000;
  players[0].lastSeen = now - DISCONNECT_MS - 5;
  players[1].lastSeen = now; players[2].lastSeen = now;
  players[2].joinedAt = players[1].joinedAt + 5;
  act(room, players[1], "STATE", now, rng);
  assert.equal(room.hostId, players[1].id);
  assert.equal(room.notice!.text, "P1 is now the host.");
  act(room, players[0], "REJOIN", now + 1000, rng);
  assert.equal(room.hostId, players[1].id);
});

test("reconnect: same nickname only while that player is disconnected", () => {
  const { room, players, rng } = setup("python", 2);
  const now = 6_000_000;
  players[1].lastSeen = now;
  assert.throws(() => applyAction(room, { type: "JOIN", name: "p1" }, now, rng), /taken/);
  players[1].lastSeen = now - DISCONNECT_MS - 1;
  const oldToken = players[1].token;
  const r = applyAction(room, { type: "JOIN", name: "p1" }, now, rng);
  assert.equal(r.playerId, players[1].id);
  assert.notEqual(r.token, oldToken);
  assert.throws(() => applyAction(room, { type: "STATE", playerId: players[1].id, token: oldToken }, now, rng), /expired/);
});

test("late joiner waits for the next round, starts at 0, doesn't block", () => {
  const { room, players, rng } = setup("python", 2);
  let now = 7_000_000;
  for (const p of players) p.lastSeen = now;
  act(room, players[0], "START", now, rng);
  now += 3000; tick(room, now);
  const r = applyAction(room, { type: "JOIN", name: "Late" }, now + 500, rng);
  const late = room.players.find((p) => p.id === r.playerId)!;
  assert.equal(late.pending, true);
  assert.throws(() => act(room, late, "ANSWER", now + 600, rng, { line: 1 }), /next round/);
  act(room, players[0], "ANSWER", now + 1000, rng, { line: bug(room) });
  act(room, players[1], "ANSWER", now + 1000, rng, { line: bug(room) });
  assert.equal(room.phase, "allin");
  tick(room, now + 2000); tick(room, now + 10000);
  assert.equal(room.phase, "leaderboard");
  act(room, players[0], "NEXT", now + 10500, rng);
  assert.equal(room.round, 2);
  assert.equal(late.pending, false);
  assert.equal(late.score, 0);
});

test("game finishes after 8 rounds; Play Again resets scores and draws fresh snippets", () => {
  const { room, players, rng } = setup("mixed", 2);
  let now = 8_000_000;
  for (const p of players) p.lastSeen = now;
  act(room, players[0], "START", now, rng);
  const firstPlan = room.plan.map((p) => p.snippetId);
  for (let r = 1; r <= ROUNDS; r++) {
    now = room.phaseStartedAt + 3000;
    for (const p of players) p.lastSeen = now;
    tick(room, now);
    for (const p of players) act(room, p, "ANSWER", now + 2000, rng, { line: bug(room) });
    now += 3000; tick(room, now); now += 8000; tick(room, now);
    assert.equal(room.phase, "leaderboard");
    act(room, players[0], "NEXT", now, rng);
  }
  assert.equal(room.phase, "finished");
  assert.ok(players[0].score > 0);
  const v = viewFor(room, players[0].id, now) as any;
  assert.equal(v.final[0].accuracy, 100);
  assert.equal(v.review.length, 8);
  act(room, players[0], "PLAY_AGAIN", now, rng);
  assert.equal(room.phase, "countdown");
  assert.equal(room.round, 1);
  assert.ok(room.players.every((p) => p.score === 0 && p.history.length === 0));
  assert.equal(room.players.length, 2);
  const overlap = room.plan.filter((p) => firstPlan.includes(p.snippetId)).length;
  assert.ok(overlap < 8, "second game should draw different snippets");
});
