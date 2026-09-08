// Pipeline telemetry (M1). Every run appends one JSON line per stage to
// events.jsonl so hours-saved and approval-rate numbers can be measured
// instead of modelled. These tests pin two properties the deck leans on:
// the stage sequence is exact (a blocked run never reaches handoff, and
// approval only appears once a human acts), and the log carries ids and
// outcomes only — the requester's brief, the copy, and the subject line
// never leak into a line that will end up in someone's observability stack.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runPipeline } from "../src/pipeline.js";
import { approveDraft } from "../src/steps/approve.js";
import { readEvents, EVENTS_FILE } from "../src/steps/emitEvent.js";
import type { Brief } from "../src/steps/parseTicket.js";
import type { EmailDraft, EmailTicket } from "../src/steps/schema.js";

// Run dirs must live under artifacts/runs (runPipeline enforces it), so we
// use names no demo command produces and remove them when the file finishes.
// The other test files never call runPipeline, so nothing else writes here.
const CLEAN_DIR = "artifacts/runs/test-telemetry-clean";
const BLOCKED_DIR = "artifacts/runs/test-telemetry-blocked";

function loadBrief(name: string): Brief {
  return JSON.parse(readFileSync(`evals/briefs/${name}.json`, "utf8")) as Brief;
}

after(() => {
  for (const dir of [CLEAN_DIR, BLOCKED_DIR]) rmSync(dir, { recursive: true, force: true });
});

test("clean run emits intake, draft, gate, handoff — then approval once a human approves", async () => {
  const result = await runPipeline(loadBrief("clean-nurture"), { outDir: CLEAN_DIR });
  assert.equal(result.gate, "ready_for_cio");
  assert.ok(result.payloadWritten, "clean brief should produce a payload");
  assert.ok(existsSync(join(CLEAN_DIR, EVENTS_FILE)), `${EVENTS_FILE} missing from run dir`);

  // runPipeline leaves human_decision "pending" and never approves, so the
  // pipeline alone yields exactly four stages — that is what `npm run demo`
  // and the selfcheck will see.
  const afterRun = readEvents(CLEAN_DIR);
  assert.deepEqual(
    afterRun.map((e) => e.stage),
    ["intake", "draft", "gate", "handoff"],
  );
  for (const event of afterRun) assert.equal(event.ticket_id, "t-clean-001");

  const gateEvent = afterRun.find((e) => e.stage === "gate");
  assert.equal(gateEvent?.gate, "ready_for_cio");
  assert.deepEqual(gateEvent?.violation_ids, []);
  assert.equal(typeof gateEvent?.reviewer_score, "number");

  // The fifth stage is appended, never rewritten: the four pipeline lines
  // survive the approval byte-for-byte.
  approveDraft(CLEAN_DIR, "approve", "looks good");
  const afterApproval = readEvents(CLEAN_DIR);
  assert.deepEqual(afterApproval.slice(0, 4), afterRun);
  assert.deepEqual(
    afterApproval.map((e) => e.stage),
    ["intake", "draft", "gate", "handoff", "approval"],
  );
  const approval = afterApproval[4];
  assert.ok(approval, "approval event missing");
  assert.equal(approval.ticket_id, "t-clean-001");
  assert.equal(approval.human_decision, "approve");
});

test("blocked run has no handoff event", async () => {
  const result = await runPipeline(loadBrief("hostile-offbrand"), { outDir: BLOCKED_DIR });
  assert.equal(result.gate, "blocked");
  assert.equal(result.payloadWritten, false);

  const events = readEvents(BLOCKED_DIR);
  assert.deepEqual(events.map((e) => e.stage), ["intake", "draft", "gate"]);
  const gateEvent = events[2];
  assert.ok(gateEvent, "gate event missing");
  assert.equal(gateEvent.gate, "blocked");
  assert.ok((gateEvent.violation_ids ?? []).length > 0, "blocked gate should name its violations");
});

test("no event carries ticket.raw, block text, or the subject line", async () => {
  // Both run dirs exist by now (node:test runs a file's tests in order), and
  // the clean one already holds the approval line — so this covers all five
  // stages against the exact artifacts written next to them.
  for (const dir of [CLEAN_DIR, BLOCKED_DIR]) {
    const lines = readFileSync(join(dir, EVENTS_FILE), "utf8");
    const ticket = JSON.parse(readFileSync(join(dir, "ticket.json"), "utf8")) as EmailTicket;
    const draft = JSON.parse(readFileSync(join(dir, "draft.json"), "utf8")) as EmailDraft;

    assert.ok(!lines.includes(ticket.raw), `${dir}: raw brief leaked into events`);
    // The raw brief is multi-line; guard each line too so a partial copy
    // (one field of the Slack message) is caught, not just the whole thing.
    for (const rawLine of ticket.raw.split("\n").map((l) => l.trim()).filter((l) => l.length > 12)) {
      assert.ok(!lines.includes(rawLine), `${dir}: brief line leaked: ${rawLine}`);
    }
    assert.ok(!lines.includes(draft.subject), `${dir}: subject leaked into events`);
    assert.ok(!lines.includes(draft.preheader), `${dir}: preheader leaked into events`);
    for (const block of draft.blocks) {
      assert.ok(!lines.includes(block.text), `${dir}: ${block.kind} block text leaked`);
      assert.ok(!lines.includes(block.html), `${dir}: ${block.kind} block html leaked`);
    }
    // The approval note is free text a human typed — it stays in
    // decision.json and out of the log.
    if (dir === CLEAN_DIR) assert.ok(!lines.includes("looks good"), "approval note leaked");
  }
});
