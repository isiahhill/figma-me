// Every input this pipeline touches is invented, and that is enforced rather
// than intended. The fixtures use one fictional brand and one set of example
// hosts, so a careless future edit that pastes in something real fails the
// suite instead of shipping.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .trim()
    .split("\n");
}

// Anything the pipeline or a fixture consumer reads has to be fully fictional.
const FIXTURE_TREE = /^(src|brand|evals|cio|schemas|skills|prompts|tests)\//;

// The companies the fixtures are allowed to name, all invented. Northwind
// Studio is the sender. Acme Corp appears only inside the hostile brief, as
// the customer named without permission that the rules have to catch.
// Sketchwave and Pixelforge are the competitors in the legal-sensitive brief.
// "Design Studio" is a Customer.io object name rather than a company.
const ALLOWED_COMPANIES = new Set([
  "Northwind Studio",
  "Acme Corp",
  "Sketchwave Inc",
  "Pixelforge Labs",
  "Design Studio",
]);
const COMPANY_SHAPED = /\b[A-Z][A-Za-z]+ (?:Studio|Corp|Inc|Labs|Systems|Group)\b/g;

test("fixtures name only the fictional companies", () => {
  // This file necessarily contains the names it screens for.
  const files = trackedFiles().filter(
    (f) => FIXTURE_TREE.test(f) && f !== "tests/synthetic-inputs.test.ts",
  );
  for (const file of files) {
    const found = readFileSync(file, "utf8").match(COMPANY_SHAPED) ?? [];
    for (const name of found) {
      assert.ok(
        ALLOWED_COMPANIES.has(name),
        `${file} names ${name}, which is not one of the fictional companies`,
      );
    }
  }
});

test("fixtures link only to the example domain", () => {
  for (const file of trackedFiles().filter((f) => f.startsWith("evals/briefs/"))) {
    const content = readFileSync(file, "utf8");
    const hosts = [...content.matchAll(/https?:\/\/([^\/\s"]+)/g)].map((m) => m[1]!);
    for (const host of hosts) {
      assert.ok(
        // bit.ly is deliberate: the hostile brief uses a shortener so the
        // allowed-destination rule has something to catch.
        host.endsWith("northwindstudio.example") || host === "bit.ly",
        `${file} references unexpected host ${host}`,
      );
    }
  }
});

test("no live sending host appears anywhere in the tree", () => {
  const files = trackedFiles().filter(
    (f) => FIXTURE_TREE.test(f) && f !== "tests/synthetic-inputs.test.ts",
  );
  for (const file of files) {
    assert.ok(
      !/customer\.io\/(?:api|v1)|track\.customer\.io/i.test(readFileSync(file, "utf8")),
      `${file} carries a live API host`,
    );
  }
});

test("working notes stay out of the repository", () => {
  // Drafts, scratch files and reference material live under local/ on the
  // machine they were written on. Only the build ships.
  assert.ok(
    !trackedFiles().some((f) => f.startsWith("local/")),
    "working notes are tracked",
  );
  assert.ok(
    readFileSync(".gitignore", "utf8").includes("/local/"),
    ".gitignore no longer excludes local working notes",
  );
});

// The directory rule above protects files somebody put in the right folder.
// This protects the one that gets dropped at the repo root at the end of a
// long edit, which is the only one that was ever going to be a problem. Both
// halves are asserted because an earlier history rewrite silently replaced
// these name patterns with the directory rule alone, and nothing noticed for
// three days.
const NAME_GUARDS = [
  "*ASSIGNMENT*",
  "*assignment*",
  "*take-home-brief*",
  "*TAKE-HOME*",
  "*take-home*",
  "CLAUDE-CODE-EMAIL-CORTEX-PROMPT*",
  "*transcript*",
  "*TRANSCRIPT*",
];
// The shapes those patterns exist to refuse, as a matcher over tracked paths.
const FORBIDDEN_NAME = /assignment|take-?home|transcript|EMAIL-CORTEX-PROMPT/i;

test(".gitignore refuses the material by name, not only by folder", () => {
  const ignore = readFileSync(".gitignore", "utf8");
  for (const pattern of NAME_GUARDS) {
    assert.ok(
      ignore.split("\n").some((line) => line.trim() === pattern),
      `.gitignore no longer carries the name guard ${pattern}`,
    );
  }
});

test("nothing assignment-shaped, brief-shaped or transcript-shaped is tracked", () => {
  // This file necessarily contains the words it screens for, as does the
  // .gitignore that does the refusing.
  const offenders = trackedFiles().filter(
    (f) =>
      FORBIDDEN_NAME.test(f) &&
      f !== "tests/synthetic-inputs.test.ts" &&
      f !== ".gitignore",
  );
  assert.deepEqual(
    offenders,
    [],
    `tracked files look like private material: ${offenders.join(", ")}`,
  );
});
