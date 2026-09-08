// Confidentiality as enforcement, not intention. The brief's rules — no real
// vendor data in fixtures, no official assignment text in the repo — are
// red/green here, so a careless future edit fails the suite instead of
// shipping.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .trim()
    .split("\n");
}

// Everything the pipeline or a fixture consumer touches must be fully
// fictional. Deliverables (PLAN/DECK/README) may name the real role they are
// submitted for — that is the submission, not fixture data.
const FICTIONAL_ONLY = /^(src|brand|evals|cio|schemas|skills|prompts|tests)\//;

test("no real-vendor names, hosts, or addresses in code, fixtures, or skills", () => {
  // This guard file necessarily contains the pattern it scans for.
  const files = trackedFiles().filter(
    (f) => FICTIONAL_ONLY.test(f) && f !== "tests/confidentiality.test.ts",
  );
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    assert.ok(!/figma/i.test(content), `${file} mentions the vendor`);
    assert.ok(!/customer\.io\/(?:api|v1)|track\.customer\.io/i.test(content), `${file} carries a live API host`);
  }
});

test("no official assignment or derived prompt file is tracked", () => {
  for (const file of trackedFiles()) {
    assert.ok(
      !/assignment|take-home-brief|EMAIL-CORTEX-PROMPT/i.test(file),
      `${file} looks like assignment material`,
    );
  }
});

test(".gitignore keeps the assignment patterns as a standing guard", () => {
  const gitignore = readFileSync(".gitignore", "utf8");
  for (const pattern of ["*ASSIGNMENT*", "CLAUDE-CODE-EMAIL-CORTEX-PROMPT*"]) {
    assert.ok(gitignore.includes(pattern), `missing ${pattern}`);
  }
});

test("fixtures use only the fictional brand hosts", () => {
  for (const file of trackedFiles().filter((f) => f.startsWith("evals/briefs/"))) {
    const content = readFileSync(file, "utf8");
    const hosts = [...content.matchAll(/https?:\/\/([^\/\s"]+)/g)].map((m) => m[1]!);
    for (const host of hosts) {
      assert.ok(
        host.endsWith("northwindstudio.example") || host === "bit.ly",
        `${file} references unexpected host ${host}`,
      );
    }
  }
});
