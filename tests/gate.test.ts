// Every branch of the HITL gate, including the defensive else. The gate is
// copied from the locked spec logic; these tests pin it so a refactor cannot
// quietly change release behavior.
import { test } from "node:test";
import assert from "node:assert/strict";
import { hitlGate } from "../src/steps/hitlGate.js";
import type { LintReport, Violation } from "../src/steps/schema.js";

function v(severity: Violation["severity"]): Violation {
  return {
    rule_id: "TEST_RULE",
    severity,
    policy_class: "synthetic_poc_policy",
    message: "test",
  };
}

const cleanLint: LintReport = { status: "pass", violations: [] };
const goodReviewer = { score: 0.9 };
const goodTicket = { confidence: 0.9, needs_input: [] as string[] };

test("any block violation → blocked, regardless of everything else", () => {
  const lint: LintReport = { status: "fail", violations: [v("block"), v("warn")] };
  assert.equal(
    hitlGate({ lint, reviewer: { score: 1 }, ticket: goodTicket }),
    "blocked",
  );
});

test("escalate violation → review", () => {
  const lint: LintReport = { status: "escalate", violations: [v("escalate")] };
  assert.equal(hitlGate({ lint, reviewer: goodReviewer, ticket: goodTicket }), "review");
});

test("reviewer score below 0.7 → review", () => {
  assert.equal(
    hitlGate({ lint: cleanLint, reviewer: { score: 0.69 }, ticket: goodTicket }),
    "review",
  );
});

test("ticket confidence below 0.7 → review", () => {
  assert.equal(
    hitlGate({
      lint: cleanLint,
      reviewer: goodReviewer,
      ticket: { confidence: 0.69, needs_input: [] },
    }),
    "review",
  );
});

test("open needs_input → review", () => {
  assert.equal(
    hitlGate({
      lint: cleanLint,
      reviewer: goodReviewer,
      ticket: { confidence: 0.9, needs_input: ["deadline unclear"] },
    }),
    "review",
  );
});

test("pass lint + exactly-0.7 score and confidence → ready_for_cio (boundary)", () => {
  assert.equal(
    hitlGate({
      lint: cleanLint,
      reviewer: { score: 0.7 },
      ticket: { confidence: 0.7, needs_input: [] },
    }),
    "ready_for_cio",
  );
});

test("warn-only lint with good score → ready_for_cio", () => {
  const lint: LintReport = { status: "warn", violations: [v("warn")] };
  assert.equal(
    hitlGate({ lint, reviewer: goodReviewer, ticket: goodTicket }),
    "ready_for_cio",
  );
});

test("defensive else: inconsistent lint status falls through to review", () => {
  // No violations, but a status the ready branch does not accept. The gate
  // must fail safe to review, never to ready.
  const lint: LintReport = { status: "escalate", violations: [] };
  assert.equal(hitlGate({ lint, reviewer: goodReviewer, ticket: goodTicket }), "review");
});

test("the gate can never produce a send state", () => {
  const outcomes = new Set<string>();
  const lints: LintReport[] = [
    cleanLint,
    { status: "warn", violations: [v("warn")] },
    { status: "escalate", violations: [v("escalate")] },
    { status: "fail", violations: [v("block")] },
  ];
  for (const lint of lints) {
    for (const score of [0, 0.7, 1]) {
      for (const confidence of [0, 0.7, 1]) {
        outcomes.add(
          hitlGate({ lint, reviewer: { score }, ticket: { confidence, needs_input: [] } }),
        );
      }
    }
  }
  for (const o of outcomes) {
    assert.ok(["blocked", "review", "ready_for_cio"].includes(o));
  }
});
