// Executes every snippet: fixed version must pass all 3-5 tests, buggy version must fail at least one.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAllSnippets, parseDrivers, LANGS } from "../scripts/parse-snippets.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const snippets = loadAllSnippets();
const drivers = Object.assign({}, ...LANGS.map((l) => parseDrivers(readFileSync(join(ROOT, "tests", "drivers", `${l}.txt`), "utf8"))));

const PY = `
def check(name, got, want):
    ok = got == want
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f" got={got!r} want={want!r}"))
`;
const JS = `
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : " got=" + JSON.stringify(got) + " want=" + JSON.stringify(want)));
}
`;
const indent = (s, pad) => s.split("\n").map((l) => (l ? pad + l : l)).join("\n");

function build(lang, code, driver) {
  if (lang === "python") return { file: "main.py", src: code + "\n" + PY + "\n" + driver };
  if (lang === "javascript") return { file: "main.mjs", src: code + "\n" + JS + "\n" + driver };
  if (lang === "java") return { file: "Main.java", src: `import java.util.*;
public class Main {
${indent(code, "    ")}
    static void check(String name, boolean ok) { System.out.println((ok ? "PASS " : "FAIL ") + name); }
    public static void main(String[] args) {
${indent(driver, "        ")}
    }
}
` };
  return { file: "main.c", src: `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static void check(const char *name, int ok) { printf("%s %s\\n", ok ? "PASS" : "FAIL", name); fflush(stdout); }
${code}
int main(void) {
${indent(driver, "    ")}
    return 0;
}
` };
}

function run(lang, dir, file) {
  const opts = { cwd: dir, encoding: "utf8", timeout: 20000 };
  if (lang === "python") return spawnSync("python3", [file], opts);
  if (lang === "javascript") return spawnSync("node", [file], opts);
  if (lang === "java") return spawnSync("java", [file], opts);
  const c = spawnSync("gcc", ["-std=c11", "-O0", "-fsanitize=address,undefined", "-fno-sanitize-recover=all", file, "-o", "prog"], opts);
  if (c.status !== 0) return { status: 99, stdout: "", stderr: "COMPILE ERROR\n" + c.stderr };
  return spawnSync("./prog", [], { ...opts, env: { ...process.env, ASAN_OPTIONS: "detect_leaks=1" } });
}

function structural(s) {
  const errs = [];
  if (s.code.length < 5 || s.code.length > 15) errs.push(`code has ${s.code.length} lines`);
  s.code.forEach((l, i) => {
    if (!l.trim()) errs.push(`blank line ${i + 1}`);
    if (/^\s*(#(?!define|include)|\/\/|\/\*|\*)/.test(l)) errs.push(`comment line ${i + 1}`);
    if (l.trim() === "undefined") errs.push(`literal undefined line ${i + 1}`);
  });
  if (!(s.bugLine >= 1 && s.bugLine <= s.code.length)) errs.push("bugLine out of range");
  const bug = s.code[s.bugLine - 1] ?? "";
  if (bug === s.fixed) errs.push("fixed equals bug line");
  if (bug.match(/^\s*/)[0] !== s.fixed.match(/^\s*/)[0]) errs.push("fixed line indentation differs");
  for (const k of ["id", "language", "difficulty", "goal", "explanation", "fixed"]) if (!s[k]) errs.push(`missing ${k}`);
  return errs;
}

const results = [];
let failures = 0;
for (const s of snippets) {
  const errs = structural(s);
  const driver = drivers[s.id];
  if (!driver) errs.push("no driver");
  const r = { id: s.id, errs };
  if (driver) {
    const fixedCode = s.code.map((l, i) => (i === s.bugLine - 1 ? s.fixed : l)).join("\n");
    for (const [kind, code] of [["fixed", fixedCode], ["buggy", s.code.join("\n")]]) {
      const dir = mkdtempSync(join(tmpdir(), "snip-"));
      const { file, src } = build(s.language, code, driver);
      writeFileSync(join(dir, file), src);
      const p = run(s.language, dir, file);
      rmSync(dir, { recursive: true, force: true });
      const out = p.stdout || "";
      const pass = (out.match(/^PASS /gm) || []).length;
      const fail = (out.match(/^FAIL /gm) || []).length;
      r[kind] = { pass, fail, exit: p.status, timedOut: p.error?.code === "ETIMEDOUT", out: out.trim(), err: (p.stderr || "").split("\n").slice(0, 4).join(" | ") };
    }
    const f = r.fixed, b = r.buggy;
    if (!(f.exit === 0 && f.fail === 0 && f.pass >= 3 && f.pass <= 5)) errs.push(`fixed version failed: pass=${f.pass} fail=${f.fail} exit=${f.exit} ${f.out} ${f.err}`);
    if (!(b.fail > 0 || b.exit !== 0 || b.timedOut)) errs.push(`buggy version passed every test (${b.out})`);
  }
  if (errs.length) failures++;
  results.push(r);
  const b = r.buggy || {};
  const how = b.timedOut ? "timeout" : b.exit !== 0 ? `crash/exit ${b.exit}${b.fail ? `, ${b.fail} FAIL` : ""}` : `${b.fail} FAIL`;
  console.log(`${errs.length ? "✗" : "✓"} ${s.id.padEnd(9)} fixed ${r.fixed?.pass}/${(r.fixed?.pass ?? 0) + (r.fixed?.fail ?? 0)} pass | buggy: ${how}${errs.length ? "\n    " + errs.join("\n    ") : ""}`);
}
const ids = new Set(snippets.map((s) => s.id));
const codes = new Set(snippets.map((s) => s.code.join("\n")));
const buckets = {};
for (const s of snippets) buckets[`${s.language}/${s.difficulty}`] = (buckets[`${s.language}/${s.difficulty}`] || 0) + 1;
const bucketOk = Object.keys(buckets).length === 16 && Object.values(buckets).every((n) => n === 3);
console.log(`\n${snippets.length} snippets, ${ids.size} unique ids, ${codes.size} unique code bodies, buckets ok: ${bucketOk}`);
if (snippets.length !== 48 || ids.size !== 48 || codes.size !== 48 || !bucketOk) failures++;
writeFileSync(join(ROOT, "tests", "snippet-results.json"), JSON.stringify(results, null, 2));
console.log(failures ? `FAILED: ${failures} problem(s)` : "ALL 48 SNIPPETS VERIFIED");
process.exit(failures ? 1 : 0);
