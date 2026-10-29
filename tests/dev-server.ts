// Local test server: serves public/ and routes /.netlify/functions/game to the real handler with an in-memory store.
// Usage: node --experimental-strip-types tests/dev-server.ts [port] [fastFactor]
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import handler, { __setTestHooks } from "../netlify/functions/game.ts";
import { MockStore } from "./mock-store.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const port = Number(process.argv[2] || 8888);
const store = new MockStore(2);
__setTestHooks({ store: () => store });
const TYPES: Record<string, string> = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };

createServer(async (req, res) => {
  const url = new URL(req.url!, `http://localhost:${port}`);
  if (url.pathname === "/.netlify/functions/game") {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const r = await handler(new Request(url, { method: req.method, headers: { "content-type": "application/json" }, body: req.method === "POST" ? Buffer.concat(chunks) : undefined }));
    res.writeHead(r.status, { "content-type": "application/json" });
    res.end(await r.text());
    return;
  }
  const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  try {
    const data = await readFile(join(ROOT, file));
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch { res.writeHead(404); res.end("not found"); }
}).listen(port, () => console.log(`dev server on http://localhost:${port}`));
