import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const LANGS = ["python", "javascript", "java", "c"];

export function parseSnippetFile(text) {
  const out = [];
  const blocks = text.split(/^=== /m).slice(1);
  for (const block of blocks) {
    const lines = block.split("\n");
    const s = { id: lines[0].trim() };
    let i = 1;
    for (; i < lines.length && lines[i] !== "--- code"; i++) {
      const m = lines[i].match(/^(\w+): ?(.*)$/);
      if (!m) throw new Error(`Bad header line in ${s.id}: ${lines[i]}`);
      s[m[1]] = m[2];
    }
    const end = lines.indexOf("--- end", i);
    if (end < 0) throw new Error(`Missing --- end in ${s.id}`);
    s.code = lines.slice(i + 1, end);
    s.bugLine = Number(s.bugLine);
    out.push({ id: s.id, language: s.language, difficulty: s.difficulty, goal: s.goal,
      code: s.code, bugLine: s.bugLine, explanation: s.explanation, fixed: s.fixed });
  }
  return out;
}

export function loadAllSnippets() {
  return LANGS.flatMap((l) => parseSnippetFile(readFileSync(join(ROOT, "snippets", `${l}.txt`), "utf8")));
}

export function parseDrivers(text) {
  const map = {};
  for (const block of text.split(/^=== /m).slice(1)) {
    const nl = block.indexOf("\n");
    map[block.slice(0, nl).trim()] = block.slice(nl + 1);
  }
  return map;
}
