// Bug Hunt Arena API. Called by the frontend at /.netlify/functions/game (POST JSON).
import { getStore } from "@netlify/blobs";
import {
  GameError, MESSAGES, createRoom, makeRoomCode, normalizeCode, toEngineAction, applyAction, viewFor,
} from "../../src/engine.ts";
import type { Room } from "../../src/engine.ts";

export interface RoomStore {
  getWithMetadata(key: string, opts: { type: "json"; consistency?: "strong" | "eventual" }): Promise<{ data: unknown; etag?: string } | null>;
  setJSON(key: string, data: unknown, opts: { onlyIfMatch?: string; onlyIfNew?: boolean }): Promise<{ modified: boolean; etag?: string }>;
}

let storeFactory: () => RoomStore = () =>
  getStore({ name: "bug-hunt-rooms", consistency: "strong" }) as unknown as RoomStore;
let clock: () => number = () => Date.now();
let rng: () => number = Math.random;

/** Test hooks: swap the Blobs store, clock, or randomness. Not used in production. */
export function __setTestHooks(h: { store?: () => RoomStore; clock?: () => number; rng?: () => number }) {
  if (h.store) storeFactory = h.store;
  if (h.clock) clock = h.clock;
  if (h.rng) rng = h.rng;
}

const MAX_ATTEMPTS = 10;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const err = (status: number, code: string, message = MESSAGES[code] ?? MESSAGES.BAD_REQUEST) =>
  json(status, { ok: false, error: code, message });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const key = (code: string) => `room-${code}`;
const STATUS: Record<string, number> = { ROOM_NOT_FOUND: 404, NOT_PLAYER: 403, NOT_HOST: 403, ROOM_FULL: 409, NAME_TAKEN: 409, GAME_FINISHED: 409 };

export default async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  if (req.method !== "POST") return err(405, "BAD_REQUEST");
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
    if (!body || typeof body !== "object") throw new Error();
  } catch {
    return err(400, "BAD_REQUEST");
  }
  try {
    const store = storeFactory();
    const action = toEngineAction(body);

    if (action.type === "CREATE") {
      for (let i = 0; i < 8; i++) {
        const now = clock();
        const code = makeRoomCode(rng);
        const { room, player } = createRoom(code, action.name, action.lang, now, rng);
        const res = await store.setJSON(key(code), room, { onlyIfNew: true });
        if (res.modified) return json(200, { ok: true, playerId: player.id, token: player.token, state: viewFor(room, player.id, now) });
      }
      return err(503, "BUSY", "The server is busy. Please try again.");
    }

    const code = normalizeCode(body.code);
    if (code.length !== 6) return err(404, "ROOM_NOT_FOUND");
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const entry = await store.getWithMetadata(key(code), { type: "json", consistency: "strong" });
      if (!entry || !entry.data) return err(404, "ROOM_NOT_FOUND");
      const room = entry.data as Room;
      const now = clock();
      const result = applyAction(room, action, now, rng); // throws GameError for invalid moves
      if (result.changed) {
        const w = await store.setJSON(key(code), room, { onlyIfMatch: entry.etag });
        if (!w.modified) {
          await sleep(15 + Math.floor(rng() * 40) * (attempt + 1)); // lost a race: re-read and try again
          continue;
        }
      }
      const out: Record<string, unknown> = { ok: true, state: viewFor(room, result.playerId, now) };
      if (result.token) { out.playerId = result.playerId; out.token = result.token; }
      return json(200, out);
    }
    return err(503, "BUSY", "The room is busy. Retrying...");
  } catch (e) {
    if (e instanceof GameError) return err(STATUS[e.code] ?? 400, e.code, e.message);
    console.error("game function error", e);
    return err(500, "SERVER", "Something went wrong on our side. Retrying...");
  }
}
