// Mechanical re-verification of the quality bar. Every claim the deck or
// README makes about this repo ("N of N evals pass", "the hostile run cannot
// emit a send URL", "the clean payload carries the footer") is printed here
// FROM observed evidence — deliverables quote this output rather than
// asserting from memory. Run after `npm run demo` and `npm run break`.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

interface Check {
  label: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];
function check(label: string, ok: boolean, detail = ""): void {
  checks.push({ label, ok, detail });
}
function json(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

// 0. Regenerate the demo and break artifacts FIRST. A selfcheck that reads
// stale committed artifacts certifies old code; every artifact check below
// runs against output this exact working tree just produced.
{
  const demo = spawnSync("node", ["--import", "tsx", "src/pipeline.ts", "demo"], { encoding: "utf8" });
  check("demo regenerated fresh", demo.status === 0, (demo.stdout.trim().split("\n").pop() ?? ""));
  const brk = spawnSync("node", ["--import", "tsx", "src/pipeline.ts", "break"], { encoding: "utf8" });
  check("break regenerated fresh", brk.status === 0, (brk.stdout.trim().split("\n").pop() ?? ""));
}

// 1. The full test suite, run for real. The reporter is pinned (spec output
// is version/TTY-dependent otherwise) and an empty or shrunken suite is a
// FAILURE: zero tests exiting 0 is exactly the false-green this script
// exists to catch. The floor is deliberately below the current count but
// far above zero. Raised from 50 when M1 (telemetry) and M2 (E7-E12) took
// the suite from 76 to 86: at 80 a lost evals.test.ts (seven cases) trips
// it, while a refactor that folds a couple of cases together does not. It
// is a floor, not a pin — the exact count lives in requirements.json R-39.
const MIN_TESTS = 80;
{
  const result = spawnSync(
    "node",
    ["--import", "tsx", "--test", "--test-reporter=spec", "tests/"],
    { encoding: "utf8" },
  );
  const out = result.stdout + result.stderr;
  const pass = Number(/ℹ pass (\d+)/.exec(out)?.[1] ?? "0");
  const fail = Number(/ℹ fail (\d+)/.exec(out)?.[1] ?? "-1");
  check(
    "npm test green with a real suite",
    result.status === 0 && fail === 0 && pass >= MIN_TESTS,
    `${pass} pass, ${fail} fail (floor ${MIN_TESTS})`,
  );
}

// 2. Scenario evals via the runner (golden comparison included). All twelve
// must exist AND pass; "0 of 0" or a partial suite is a failure even on
// exit 0. Each id is matched on its own report line — the runner prints
// `PASS  E1  <title>` with two spaces either side of the id — because a
// plain substring test for "E1" is also satisfied by E10, E11 and E12, and
// a missing E1 would then go unnoticed.
const EVAL_IDS = Array.from({ length: 12 }, (_, i) => `E${i + 1}`);
{
  const result = spawnSync("node", ["--import", "tsx", "evals/run.ts"], { encoding: "utf8" });
  const m = /(\d+) of (\d+) evals pass/.exec(result.stdout);
  const passed = Number(m?.[1] ?? "0");
  const total = Number(m?.[2] ?? "0");
  const ids = EVAL_IDS.filter((id) => new RegExp(`^PASS  ${id}  `, "m").test(result.stdout));
  check(
    "eval runner green incl. goldens",
    result.status === 0 && total >= EVAL_IDS.length && passed === total && ids.length === EVAL_IDS.length,
    `${passed} of ${total}, ids present: ${ids.join(",")}`,
  );
}

// 3. Demo artifacts: three runs plus break, each with the core files.
for (const run of ["clean", "messy", "hostile", "break"]) {
  const dir = join("artifacts/runs", run);
  const wanted = ["ticket.json", "draft.json", "lint.json", "preview.html", "decision.json"];
  const missing = wanted.filter((f) => !existsSync(join(dir, f)));
  check(`run folder ${run}`, existsSync(dir) && missing.length === 0,
    missing.length > 0 ? `missing ${missing.join(",")}` : "complete");
}

// 3b. Telemetry: every run wrote events.jsonl, the clean run logged exactly
// the four pipeline stages in order, handoff appears only where a payload
// was written, and no line quotes copy. Selfcheck drives the pipeline and
// never the approval CLI, so there is no fifth (approval) stage here — that
// path is covered by poc/tests/telemetry.test.ts on fixture dirs. This
// check repeats the leak test on the artifacts the deck actually copies
// into reports/runs/, because a telemetry line that quoted the requester's
// Slack message is the one thing a log pipeline would make searchable
// company-wide.
{
  const problems: string[] = [];
  let cleanStages = "";
  for (const run of ["clean", "messy", "hostile", "break"]) {
    const dir = join("artifacts/runs", run);
    const path = join(dir, "events.jsonl");
    if (!existsSync(path)) {
      problems.push(`${run}: no events.jsonl`);
      continue;
    }
    const lines = readFileSync(path, "utf8");
    const stages = lines
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => String(JSON.parse(l).stage));
    if (run === "clean") cleanStages = stages.join(",");
    if (run === "clean" && cleanStages !== "intake,draft,gate,handoff") {
      problems.push(`clean stages ${cleanStages}`);
    }
    // A handoff line means "a create-only payload is on disk"; decision.json
    // is the authority on whether that should have happened.
    const wantHandoff = json(join(dir, "decision.json")).gate === "ready_for_cio";
    if (stages.includes("handoff") !== wantHandoff) {
      problems.push(`${run}: handoff ${wantHandoff ? "missing" : "logged on a non-ready run"}`);
    }
    const ticket = json(join(dir, "ticket.json"));
    const draft = json(join(dir, "draft.json"));
    // The raw brief is multi-line, so its lines are guarded one by one as
    // well: a single copied Slack field is as much of a leak as the whole.
    const copy = [
      ticket.raw,
      ...String(ticket.raw).split("\n").map((l: string) => l.trim()).filter((l: string) => l.length > 12),
      draft.subject,
      draft.preheader,
      ...draft.blocks.flatMap((b: any) => [b.text, b.html]),
    ].filter((s) => typeof s === "string" && s.length > 0);
    if (copy.some((s) => lines.includes(s))) problems.push(`${run}: copy text in events`);
  }
  check(
    "events.jsonl present, four pipeline stages, no copy text",
    problems.length === 0,
    problems.length > 0 ? problems.join("; ") : `clean=${cleanStages}; 4 runs, ids and outcomes only`,
  );
}

// 4. Clean payload shape: create-only, footer, one primary CTA, brand host.
{
  const payloadPath = "artifacts/runs/clean/cio-payload.json";
  if (!existsSync(payloadPath)) {
    check("clean payload exists", false, "no cio-payload.json");
  } else {
    const p = json(payloadPath);
    const draft = json("artifacts/runs/clean/draft.json");
    check("clean payload is createDesignStudioEmail", p.sdk === "createDesignStudioEmail" && p.method === "POST" && p.body?.is_template === false, p.sdk);
    check("clean payload carries footer", String(p.body?.content?.html).includes("/unsubscribe") && /, [A-Z]{2} \d{5}/.test(String(p.body?.content?.html)), "unsub + address in html");
    check("clean draft has one primary CTA on brand host",
      draft.blocks.filter((b: any) => b.kind === "cta").length === 1 &&
      draft.cta.role === "primary" &&
      new URL(draft.cta.href).host.endsWith("northwindstudio.example"),
      draft.cta.href);
  }
}

// 5. Hostile and break runs: blocked, and no payload file at all.
for (const run of ["hostile", "break"]) {
  const decision = json(`artifacts/runs/${run}/decision.json`);
  check(`${run} run blocked with no payload`,
    decision.gate === "blocked" && !existsSync(`artifacts/runs/${run}/cio-payload.json`),
    `gate=${decision.gate}`);
}
{
  const lint = json("artifacts/runs/break/lint.json");
  check("break run fired CLAIM_NUMBER",
    lint.violations.some((v: any) => v.rule_id === "CLAIM_NUMBER" && v.severity === "block"),
    lint.violations.map((v: any) => v.rule_id).join(","));
}

// 6. Messy run: intake surfaced questions; the uncleared claim stayed out of copy.
{
  const ticket = json("artifacts/runs/messy/ticket.json");
  const draft = json("artifacts/runs/messy/draft.json");
  const copy = JSON.stringify({ s: draft.subject, p: draft.preheader, b: draft.blocks, c: draft.cta });
  check("messy run quarantined the uncleared claim",
    ticket.needs_input.length > 0 && !copy.includes("50%"),
    `${ticket.needs_input.length} needs_input, copy clean`);
}

// 7. No send surface anywhere in any emitted artifact JSON keys.
{
  const offenders: string[] = [];
  for (const run of readdirSync("artifacts/runs")) {
    const dir = join("artifacts/runs", run);
    if (!existsSync(dir) || run === ".gitkeep") continue;
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      JSON.stringify(json(join(dir, file)), (key, value) => {
        if (key && /send|schedule|trigger/i.test(key)) offenders.push(`${run}/${file}:${key}`);
        return value;
      });
    }
  }
  check("no send/schedule/trigger keys in any artifact", offenders.length === 0, offenders.join(",") || "clean");
}

// 8. Allowlist is exactly the two create methods.
{
  const allow = readFileSync("cio/allowlist.yaml", "utf8");
  const methods = [...allow.matchAll(/^\s*-\s*(\w+)\s*$/gm)].map((m) => m[1]);
  check("allowlist = two create methods",
    methods.length === 2 && methods.includes("createDesignStudioEmail") && methods.includes("createNewsletter"),
    methods.join(","));
}

// 9. Skills are import-shaped: frontmatter with name + description.
for (const skill of ["email-nurture", "email-launch"]) {
  const path = `skills/${skill}/SKILL.md`;
  const ok = existsSync(path) &&
    /^---\nname: /.test(readFileSync(path, "utf8")) &&
    readFileSync(path, "utf8").includes("description:") &&
    existsSync(`skills/${skill}/play.yaml`);
  check(`skill ${skill} import-shaped`, ok, path);
}

// 10. Confidentiality: no assignment-shaped file tracked, guard patterns present.
{
  const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" });
  const bad = tracked.split("\n").filter((f) => /assignment|EMAIL-CORTEX-PROMPT/i.test(f));
  const gitignore = readFileSync(".gitignore", "utf8");
  check("no assignment material tracked", bad.length === 0, bad.join(",") || "clean");
  check(".gitignore guards assignment patterns", gitignore.includes("*ASSIGNMENT*"), "");
}

let failed = 0;
for (const c of checks) {
  if (!c.ok) failed += 1;
  console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.label}${c.detail ? ` — ${c.detail}` : ""}`);
}
console.log(`\n${checks.length - failed} of ${checks.length} selfchecks pass`);
if (failed > 0) process.exitCode = 1;
