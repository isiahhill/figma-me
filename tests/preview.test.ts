// Preview rendering + the human decision file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderPreview } from "../src/steps/renderPreview.js";
import { approveDraft } from "../src/steps/approve.js";
import { lintEmail } from "../src/steps/lintEmail.js";
import { attachFooter } from "../src/steps/attachFooter.js";
import { brand, cleanDraft, withBodyText } from "./helpers.js";
import type { EmailDraft } from "../src/steps/schema.js";

function lintedDraft(extra?: string): EmailDraft {
  const base = extra ? withBodyText(cleanDraft(), extra) : cleanDraft();
  const withFooter = attachFooter(base, brand);
  return { ...withFooter, lint: lintEmail(withFooter, brand) };
}

test("preview renders a 600px email with the locked footer and gate status", () => {
  const draft = lintedDraft();
  const html = renderPreview(draft, "ready_for_cio");
  assert.ok(html.includes('width="600"'));
  assert.ok(html.includes("/unsubscribe"));
  assert.ok(html.includes("Oakland, CA 94607"));
  // The badge shows the outcome in words now. The raw status stays in
  // decision.json, so this asserts what a reader actually sees.
  assert.ok(html.includes("Ready to hand off"));
  assert.ok(!html.includes("ready_for_cio"), "raw gate token should not reach the preview");
});

test("preview shows each violation with its policy_class in the rail and highlights spans", () => {
  const draft = lintedDraft("This will cut your hours in half.");
  const html = renderPreview(draft, "review");
  assert.ok(html.includes("CLAIM_IMPLIED"));
  assert.ok(html.includes("synthetic_poc_policy"));
  // The offending span is wrapped in a <mark> in the rendered email.
  assert.ok(/<mark[^>]*>in half<\/mark>/.test(html));
});

test("approveDraft records the human decision without touching the gate", () => {
  const dir = mkdtempSync(join(tmpdir(), "cortex-test-"));
  writeFileSync(
    join(dir, "decision.json"),
    JSON.stringify({ gate: "review", reviewer: { score: 0.8, notes: "" }, human_decision: "pending", note: "" }, null, 2),
  );
  approveDraft(dir, "request_changes", "tone is off");
  const decision = JSON.parse(readFileSync(join(dir, "decision.json"), "utf8"));
  assert.equal(decision.gate, "review");
  assert.equal(decision.human_decision, "request_changes");
  assert.equal(decision.note, "tone is off");
});

test("approveDraft rejects decisions outside approve|request_changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "cortex-test-"));
  writeFileSync(
    join(dir, "decision.json"),
    JSON.stringify({ gate: "review", human_decision: "pending", note: "" }, null, 2),
  );
  assert.throws(() => approveDraft(dir, "send" as never, ""));
});
