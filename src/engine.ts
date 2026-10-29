// Bug Hunt Arena game engine. Pure functions over a Room object; the caller supplies `now` (server ms).
import { SNIPPETS } from "./snippets.ts";
import type { Snippet, Language, Difficulty } from "./snippets.ts";

export type GameLang = Language | "mixed";
export type Phase = "lobby" | "countdown" | "playing" | "allin" | "reveal" | "leaderboard" | "finished";

export const ROUNDS = 8;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;
export const COUNTDOWN_MS = 3000;
export const ANSWER_MS = 30000;
export const ALLIN_MS = 1000;
export const REVEAL_MS = 8000;
export const LEADERBOARD_MS = 15000;
export const HEARTBEAT_MS = 10000;
export const DISCONNECT_MS = 20000;
export const LOBBY_PRUNE_MS = 120000;
const STALE_CHAIN_MS = 2000;

export const LANGUAGES: Language[] = ["python", "javascript", "java", "c"];
export const GAME_LANGS: GameLang[] = ["python", "javascript", "java", "c", "mixed"];
export const DIFFICULTY_BY_ROUND: Difficulty[] = ["easy", "easy", "medium", "medium", "hard", "hard", "expert", "expert"];
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

export interface HistoryEntry { round: number; snippetId: string; line: number | null; correct: boolean; ms: number | null; points: number }
export interface Player {
  id: string; token: string; name: string; joinedAt: number; lastSeen: number;
  pending: boolean; score: number; correctMs: number; lastPoints: number; history: HistoryEntry[];
}
export interface Answer { line: number; ms: number; correct: boolean; points: number }
export interface PlanItem { language: Language; difficulty: Difficulty; snippetId: string }
export interface Room {
  code: string; createdAt: number; lang: GameLang; hostId: string; phase: Phase; phaseStartedAt: number;
  round: number; plan: PlanItem[]; answers: Record<string, Answer>; players: Player[];
  notice: { id: number; text: string } | null; noticeSeq: number; gameNo: number; prevSnippetIds: string[];
}

export class GameError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

export const MESSAGES: Record<string, string> = {
  ROOM_NOT_FOUND: "We couldn't find that room. Check the code and try again.",
  ROOM_FULL: "That room is full (8 players max).",
  NAME_TAKEN: "That name is taken in this room, try another.",
  NAME_INVALID: "Nicknames need 2 to 18 characters.",
  GAME_FINISHED: "That game has already finished. Ask the host for a new room code.",
  NOT_HOST: "Only the host can do that.",
  NOT_ENOUGH_PLAYERS: "You need at least 2 players to start.",
  BAD_PHASE: "That isn't possible right now.",
  ALREADY_ANSWERED: "You've already answered this round.",
  NOT_IN_ROUND: "You'll join at the start of the next round.",
  BAD_LINE: "That line doesn't exist.",
  BAD_LANG: "Pick Python, JavaScript, Java, C, or Mixed.",
  NOT_PLAYER: "Your seat in this room has expired. Join again with your nickname.",
  BAD_REQUEST: "Something about that request didn't look right.",
};
const fail = (code: string): never => { throw new GameError(code, MESSAGES[code]); };

export const snippetById = (id: string): Snippet => {
  const s = SNIPPETS.find((x) => x.id === id);
  if (!s) throw new Error(`unknown snippet ${id}`);
  return s;
};

export type Rng = () => number;
const shuffle = <T>(arr: T[], rng: Rng): T[] => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const randomId = (rng: Rng, len: number, alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"): string => {
  let s = "";
  for (let i = 0; i < len; i++) s += alphabet[Math.floor(rng() * alphabet.length)];
  return s;
};
export const makeRoomCode = (rng: Rng): string => randomId(rng, 6, CODE_ALPHABET);
export const normalizeCode = (code: unknown): string =>
  String(code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);

// ---- plans ---------------------------------------------------------------------------------------
export function mixedLanguageOrder(rng: Rng): Language[] {
  const base = LANGUAGES.flatMap((l) => [l, l]);
  for (;;) {
    const order = shuffle(base, rng);
    if (!order.some((l, i) => i >= 2 && order[i - 1] === l && order[i - 2] === l)) return order;
  }
}

export function buildPlan(lang: GameLang, rng: Rng, avoid: string[] = []): PlanItem[] {
  const langs = lang === "mixed" ? mixedLanguageOrder(rng) : Array(ROUNDS).fill(lang);
  const used = new Set<string>();
  return DIFFICULTY_BY_ROUND.map((difficulty, i) => {
    const bucket = SNIPPETS.filter((s) => s.language === langs[i] && s.difficulty === difficulty && !used.has(s.id));
    if (!bucket.length) throw new Error("snippet bank exhausted");
    const fresh = bucket.filter((s) => !avoid.includes(s.id));
    const pool = fresh.length ? fresh : bucket;
    const pick = pool[Math.floor(rng() * pool.length)];
    used.add(pick.id);
    return { language: langs[i], difficulty, snippetId: pick.id };
  });
}

// ---- helpers ------------------------------------------------------------------------------------
export const isConnected = (p: Player, now: number) => now - p.lastSeen <= DISCONNECT_MS;
export const scoreFor = (ms: number) => {
  const t = Math.min(30, Math.max(0, ms / 1000));
  return Math.round(100 + 50 * (1 - t / 30));
};
export function validateName(raw: unknown): string {
  const name = String(raw ?? "").trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 18) fail("NAME_INVALID");
  return name;
}
export const ranked = (players: Player[]) =>
  players.slice().sort((a, b) => b.score - a.score || a.correctMs - b.correctMs || a.joinedAt - b.joinedAt);
const findPlayer = (room: Room, id: unknown, token: unknown): Player => {
  const p = room.players.find((x) => x.id === id);
  if (!p || p.token !== token) fail("NOT_PLAYER");
  return p as Player;
};
const notify = (room: Room, text: string) => { room.noticeSeq += 1; room.notice = { id: room.noticeSeq, text }; };
const newPlayer = (name: string, now: number, rng: Rng, pending: boolean): Player => ({
  id: "p_" + randomId(rng, 10), token: randomId(rng, 24), name, joinedAt: now, lastSeen: now,
  pending, score: 0, correctMs: 0, lastPoints: 0, history: [],
});

// ---- room lifecycle ------------------------------------------------------------------------------
export function createRoom(code: string, hostName: unknown, lang: unknown, now: number, rng: Rng) {
  const name = validateName(hostName);
  if (!GAME_LANGS.includes(lang as GameLang)) fail("BAD_LANG");
  const host = newPlayer(name, now, rng, false);
  const room: Room = {
    code, createdAt: now, lang: lang as GameLang, hostId: host.id, phase: "lobby", phaseStartedAt: now,
    round: 0, plan: [], answers: {}, players: [host], notice: null, noticeSeq: 0, gameNo: 0, prevSnippetIds: [],
  };
  return { room, player: host };
}

function beginGame(room: Room, now: number, rng: Rng) {
  room.gameNo += 1;
  room.plan = buildPlan(room.lang, rng, room.prevSnippetIds);
  room.prevSnippetIds = room.plan.map((p) => p.snippetId);
  room.round = 1;
  room.answers = {};
  for (const p of room.players) Object.assign(p, { pending: false, score: 0, correctMs: 0, lastPoints: 0, history: [] });
  room.phase = "countdown";
  room.phaseStartedAt = now;
}

function finalizeRound(room: Room) {
  const snip = snippetById(room.plan[room.round - 1].snippetId);
  for (const p of room.players) {
    if (p.pending) { p.lastPoints = 0; continue; }
    const a = room.answers[p.id];
    const correct = !!a && a.line === snip.bugLine;
    const points = correct ? a!.points : 0;
    p.score += points;
    if (correct) p.correctMs += a!.ms;
    p.lastPoints = points;
    p.history.push({ round: room.round, snippetId: snip.id, line: a ? a.line : null, correct, ms: a ? a.ms : null, points });
  }
}

const activeConnected = (room: Room, now: number) => room.players.filter((p) => !p.pending && isConnected(p, now));
export const allAnswered = (room: Room, now: number) => activeConnected(room, now).every((p) => !!room.answers[p.id]);

/** Applies every transition that is due at `now`. Returns true if the room changed. */
export function tick(room: Room, now: number): boolean {
  let changed = false;
  // Host migration.
  const host = room.players.find((p) => p.id === room.hostId);
  if (!host || !isConnected(host, now)) {
    const next = room.players.filter((p) => isConnected(p, now)).sort((a, b) => a.joinedAt - b.joinedAt)[0];
    if (next && next.id !== room.hostId) {
      room.hostId = next.id;
      notify(room, `${next.name} is now the host.`);
      changed = true;
    }
  }
  // Lobby: drop seats that have been gone a long time so ghosts don't fill the room.
  if (room.phase === "lobby") {
    const keep = room.players.filter((p) => now - p.lastSeen <= LOBBY_PRUNE_MS || p.id === room.hostId);
    if (keep.length !== room.players.length) { room.players = keep; changed = true; }
  }
  for (let guard = 0; guard < 50; guard++) {
    const start = room.phaseStartedAt;
    const at = (due: number) => (now - due > STALE_CHAIN_MS ? now : due);
    let moved = true;
    switch (room.phase) {
      case "countdown":
        if (now >= start + COUNTDOWN_MS) { room.phase = "playing"; room.phaseStartedAt = at(start + COUNTDOWN_MS); }
        else moved = false;
        break;
      case "playing":
        if (now >= start + ANSWER_MS) {
          finalizeRound(room); room.phase = "reveal"; room.phaseStartedAt = at(start + ANSWER_MS);
        } else if (allAnswered(room, now)) { room.phase = "allin"; room.phaseStartedAt = now; }
        else moved = false;
        break;
      case "allin":
        if (now >= start + ALLIN_MS) { finalizeRound(room); room.phase = "reveal"; room.phaseStartedAt = at(start + ALLIN_MS); }
        else moved = false;
        break;
      case "reveal":
        if (now >= start + REVEAL_MS) { room.phase = "leaderboard"; room.phaseStartedAt = at(start + REVEAL_MS); }
        else moved = false;
        break;
      case "leaderboard":
        if (now >= start + LEADERBOARD_MS) advanceFromLeaderboard(room, at(start + LEADERBOARD_MS));
        else moved = false;
        break;
      default:
        moved = false;
    }
    if (!moved) break;
    changed = true;
  }
  return changed;
}

function advanceFromLeaderboard(room: Room, at: number) {
  if (room.round >= ROUNDS) {
    room.phase = "finished";
  } else {
    room.round += 1;
    room.answers = {};
    for (const p of room.players) p.pending = false; // late joiners enter now with 0 points
    room.phase = "countdown";
  }
  room.phaseStartedAt = at;
}

// ---- actions ------------------------------------------------------------------------------------
export type EngineAction =
  | { type: "JOIN"; name: unknown }
  | { type: "REJOIN"; playerId: unknown; token: unknown }
  | { type: "STATE"; playerId: unknown; token: unknown }
  | { type: "START"; playerId: unknown; token: unknown }
  | { type: "ANSWER"; playerId: unknown; token: unknown; line: unknown }
  | { type: "NEXT"; playerId: unknown; token: unknown }
  | { type: "PLAY_AGAIN"; playerId: unknown; token: unknown }
  | { type: "LEAVE"; playerId: unknown; token: unknown };

/** Single place mapping the request's "action" field to the engine's action type. */
export const ACTION_TYPES: Record<string, EngineAction["type"] | "CREATE"> = {
  create: "CREATE", join: "JOIN", rejoin: "REJOIN", state: "STATE", start: "START",
  answer: "ANSWER", next: "NEXT", playAgain: "PLAY_AGAIN", leave: "LEAVE",
};
export function toEngineAction(body: Record<string, unknown>): EngineAction | { type: "CREATE"; name: unknown; lang: unknown } {
  const type = ACTION_TYPES[String(body.action ?? "")];
  if (!type) fail("BAD_REQUEST");
  const auth = { playerId: body.playerId, token: body.token };
  switch (type) {
    case "CREATE": return { type, name: body.name, lang: body.lang };
    case "JOIN": return { type, name: body.name };
    case "ANSWER": return { type, ...auth, line: body.line };
    default: return { type, ...auth } as EngineAction;
  }
}

export interface ActionResult { changed: boolean; playerId: string; token?: string }

/** Applies an action (after due transitions). Mutates room. Heartbeat is written at most every HEARTBEAT_MS. */
export function applyAction(room: Room, action: EngineAction, now: number, rng: Rng): ActionResult {
  let changed = false;
  if (action.type === "JOIN") {
    const name = validateName(action.name);
    tick(room, now);
    const existing = room.players.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      if (isConnected(existing, now)) fail("NAME_TAKEN");
      existing.token = randomId(rng, 24);
      existing.lastSeen = now;
      tick(room, now);
      return { changed: true, playerId: existing.id, token: existing.token };
    }
    if (room.phase === "finished") fail("GAME_FINISHED");
    if (room.players.length >= MAX_PLAYERS) fail("ROOM_FULL");
    const p = newPlayer(name, now, rng, room.phase !== "lobby");
    room.players.push(p);
    tick(room, now);
    return { changed: true, playerId: p.id, token: p.token };
  }

  const me = findPlayer(room, action.playerId, action.token);
  if (action.type === "LEAVE") {
    me.lastSeen = now - DISCONNECT_MS - 1;
    tick(room, now);
    return { changed: true, playerId: me.id };
  }
  if (action.type === "REJOIN" || now - me.lastSeen >= HEARTBEAT_MS || !isConnected(me, now)) {
    me.lastSeen = now;
    changed = true;
  }
  if (tick(room, now)) changed = true;
  const isHost = room.hostId === me.id;

  switch (action.type) {
    case "REJOIN":
    case "STATE":
      break;
    case "START": {
      if (!isHost) fail("NOT_HOST");
      if (room.phase !== "lobby") fail("BAD_PHASE");
      if (room.players.filter((p) => isConnected(p, now)).length < MIN_PLAYERS) fail("NOT_ENOUGH_PLAYERS");
      beginGame(room, now, rng);
      changed = true;
      break;
    }
    case "ANSWER": {
      if (room.phase !== "playing") fail("BAD_PHASE");
      if (me.pending) fail("NOT_IN_ROUND");
      if (room.answers[me.id]) fail("ALREADY_ANSWERED");
      const snip = snippetById(room.plan[room.round - 1].snippetId);
      const line = Number(action.line);
      if (!Number.isInteger(line) || line < 1 || line > snip.code.length) fail("BAD_LINE");
      const ms = Math.max(0, now - room.phaseStartedAt);
      const correct = line === snip.bugLine;
      room.answers[me.id] = { line, ms, correct, points: correct ? scoreFor(ms) : 0 };
      tick(room, now);
      changed = true;
      break;
    }
    case "NEXT": {
      if (!isHost) fail("NOT_HOST");
      if (room.phase !== "leaderboard") fail("BAD_PHASE");
      advanceFromLeaderboard(room, now);
      changed = true;
      break;
    }
    case "PLAY_AGAIN": {
      if (!isHost) fail("NOT_HOST");
      if (room.phase !== "finished") fail("BAD_PHASE");
      if (room.players.filter((p) => isConnected(p, now)).length >= MIN_PLAYERS) beginGame(room, now, rng);
      else {
        room.phase = "lobby"; room.phaseStartedAt = now; room.round = 0; room.plan = []; room.answers = {};
        for (const p of room.players) Object.assign(p, { pending: false, score: 0, correctMs: 0, lastPoints: 0, history: [] });
      }
      changed = true;
      break;
    }
  }
  return { changed, playerId: me.id };
}

// ---- client view (never leaks answers before the reveal) ------------------------------------------
export function viewFor(room: Room, playerId: string, now: number) {
  const me = room.players.find((p) => p.id === playerId);
  const item = room.round > 0 ? room.plan[room.round - 1] : null;
  const snip = item ? snippetById(item.snippetId) : null;
  const durations: Partial<Record<Phase, number>> = {
    countdown: COUNTDOWN_MS, playing: ANSWER_MS, allin: ALLIN_MS, reveal: REVEAL_MS, leaderboard: LEADERBOARD_MS,
  };
  const dur = durations[room.phase];
  const showRound = room.phase !== "lobby" && room.phase !== "finished";
  const revealed = room.phase === "reveal" || room.phase === "leaderboard";
  const players = ranked(room.players).map((p) => ({
    id: p.id, name: p.name, score: p.score, lastPoints: p.lastPoints, pending: p.pending,
    connected: isConnected(p, now), isHost: p.id === room.hostId,
    answered: room.phase === "playing" || room.phase === "allin" ? !!room.answers[p.id] : undefined,
  }));
  const view: Record<string, unknown> = {
    code: room.code, lang: room.lang, phase: room.phase, round: room.round, rounds: ROUNDS,
    serverNow: now, phaseEndsAt: dur ? room.phaseStartedAt + dur : null,
    hostId: room.hostId, you: playerId, isHost: room.hostId === playerId, pending: !!me?.pending,
    players, notice: room.notice, gameNo: room.gameNo,
  };
  if (showRound && item) {
    view.badge = { language: item.language, difficulty: item.difficulty };
    if (room.phase !== "countdown") view.snippet = { goal: snip!.goal, code: snip!.code };
    const mine = room.answers[playerId];
    view.myLine = mine ? mine.line : null;
  }
  if (revealed && snip) {
    view.reveal = {
      bugLine: snip.bugLine, explanation: snip.explanation, fixed: snip.fixed,
      picks: room.players.filter((p) => !p.pending || room.answers[p.id]).map((p) => {
        const h = p.history.find((x) => x.round === room.round);
        return { id: p.id, name: p.name, line: h ? h.line : null, correct: h ? h.correct : false, points: h ? h.points : 0 };
      }),
    };
  }
  if (room.phase === "finished") {
    view.final = ranked(room.players).map((p, i) => {
      const played = p.history.length;
      const correct = p.history.filter((h) => h.correct);
      return {
        id: p.id, name: p.name, rank: i + 1, score: p.score, played, correct: correct.length,
        accuracy: played ? Math.round((correct.length / played) * 100) : 0,
        avgMs: correct.length ? Math.round(p.correctMs / correct.length) : null,
      };
    });
    view.review = room.plan.map((pl, i) => {
      const s = snippetById(pl.snippetId);
      const h = me?.history.find((x) => x.round === i + 1);
      return {
        round: i + 1, language: pl.language, difficulty: pl.difficulty, goal: s.goal, code: s.code,
        bugLine: s.bugLine, explanation: s.explanation, fixed: s.fixed,
        played: !!h, myLine: h ? h.line : null, correct: h ? h.correct : false,
      };
    });
  }
  return view;
}
