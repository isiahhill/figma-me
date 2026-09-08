// Hardening suite, written after an adversarial review pass. Each test here
// pins a hole the review actually demonstrated: html-vs-text lint divergence,
// markup injection through brief fields, unicode evasion, loose customer
// clearing, provider-boundary leaks, and gate inputs a live model could
// sidestep. These are regression locks, not hypotheticals.
import { test } from "node:test";
import assert from "node:assert/strict";
import { lintEmail, matchForbidden } from "../src/steps/lintEmail.js";
import { attachFooter } from "../src/steps/attachFooter.js";
import { generateDraft } from "../src/steps/generateDraft.js";
import { reviewDraft } from "../src/steps/reviewDraft.js";
import { rewriteSpans } from "../src/steps/rewriteSpans.js";
import { renderPreview } from "../src/steps/renderPreview.js";
import { hitlGate } from "../src/steps/hitlGate.js";
import { getLLM, type LLM, type LlmTask } from "../src/llm.js";
import { composeDraft, loadPlay } from "../src/pipeline.js";
import { brand, cleanDraft, cleanTicket, withBodyText, CLAIM } from "./helpers.js";
import type { ModelDraft, Violation } from "../src/steps/schema.js";

const mock = getLLM("mock");

function ruleIds(draft: ModelDraft) {
  return lintEmail(attachFooter(draft, brand), brand).violations.map((v) => v.rule_id);
}

// Replace the body block's html ONLY, leaving text clean — the live-provider
// divergence case the cross-model review demonstrated.
function withBodyHtml(draft: ModelDraft, html: string): ModelDraft {
  return {
    ...draft,
    blocks: draft.blocks.map((b) => (b.kind === "body" ? { ...b, html } : b)),
  };
}

// --- html-vs-text lint parity ---

test("copy rules catch content present only in block html", () => {
  const base = cleanDraft();
  const bodyText = base.blocks.find((b) => b.kind === "body")!.text;
  const draft = withBodyHtml(
    cleanDraft(),
    `<p>${bodyText}</p><p>This is game-changing with guaranteed results.</p>`,
  );
  const ids = ruleIds(draft);
  assert.ok(ids.includes("FORBIDDEN_PHRASE"));
});

test("an anchor in body html to an unapproved host is flagged, not just cta.href", () => {
  const base = cleanDraft();
  const bodyText = base.blocks.find((b) => b.kind === "body")!.text;
  const draft = withBodyHtml(
    cleanDraft(),
    `<p>${bodyText} <a href="https://evil.example/promo">click</a></p>`,
  );
  assert.ok(ruleIds(draft).includes("CTA_DOMAIN"));
});

test("script tags, event handlers, and javascript: URIs in block html are blocked", () => {
  for (const payload of [
    "<script>alert(1)</script>",
    '<img src="x" onerror="alert(1)">',
    '<a href="javascript:alert(1)">go</a>',
  ]) {
    const base = cleanDraft();
    const bodyText = base.blocks.find((b) => b.kind === "body")!.text;
    const draft = withBodyHtml(cleanDraft(), `<p>${bodyText}</p>${payload}`);
    const report = lintEmail(attachFooter(draft, brand), brand);
    const hit = report.violations.find((v) => v.rule_id === "HTML_SAFETY");
    assert.ok(hit, `expected HTML_SAFETY for ${payload}`);
    assert.equal(hit.severity, "block");
  }
});

test("single-quoted and uppercase href attributes are scanned by LINK_HTTPS", () => {
  const base = cleanDraft();
  const bodyText = base.blocks.find((b) => b.kind === "body")!.text;
  const draft = withBodyHtml(
    cleanDraft(),
    `<p>${bodyText} <a HREF='http://www.northwindstudio.example/x'>go</a></p>`,
  );
  assert.ok(ruleIds(draft).includes("LINK_HTTPS"));
});

test("the cta block anchor must point where cta.href says it points", () => {
  const base = cleanDraft();
  const draft = cleanDraft({
    blocks: base.blocks.map((b) =>
      b.kind === "cta"
        ? { ...b, html: '<a href="https://help.northwindstudio.example/other">See the walkthrough</a>' }
        : b,
    ),
  });
  assert.ok(ruleIds(draft).includes("CTA_DOMAIN"));
});

// --- unicode evasion ---

test("unicode dash and zero-width variants do not evade the phrase matcher", () => {
  assert.equal(matchForbidden("this is game‐changing", ["game-changing"]).length, 1);
  assert.equal(matchForbidden("game​-changing results", ["game-changing"]).length, 1);
  assert.equal(matchForbidden("guaranteed results ahead", ["guaranteed results"]).length, 1);
});

test("fullwidth digits do not evade CLAIM_NUMBER", () => {
  const draft = withBodyText(cleanDraft(), "ship ５０％ faster");
  const report = lintEmail(attachFooter(draft, brand), brand);
  assert.ok(report.violations.some((v) => v.rule_id === "CLAIM_NUMBER"));
});

// --- uncited bare counts ---

test("uncited plain-count facts escalate instead of sailing to ready", () => {
  const draft = attachFooter(
    withBodyText(cleanDraft(), "Northwind has served 1,000 teams since 2018."),
    brand,
  );
  const lint = lintEmail(draft, brand);
  const hit = lint.violations.find((v) => v.rule_id === "CLAIM_BARE_NUMBER");
  assert.ok(hit);
  assert.equal(hit.severity, "escalate");
  const gate = hitlGate({
    lint,
    reviewer: { score: 0.95 },
    ticket: { confidence: 0.95, needs_input: [] },
  });
  assert.equal(gate, "review");
});

// --- customer clearing is exact-match ---

test("names containing a cleared reference are not thereby cleared", () => {
  for (const name of ["Fake Harbor Bank helped us.", "We love Northwind Acme Corp."]) {
    const draft = withBodyText(cleanDraft(), name);
    assert.ok(ruleIds(draft).includes("NAMED_CUSTOMER"), `expected flag for "${name}"`);
  }
  // Exact cleared references still pass.
  const cleared = withBodyText(cleanDraft(), "Harbor Bank runs on Northwind.");
  assert.ok(!ruleIds(cleared).includes("NAMED_CUSTOMER"));
});

// --- mock generator escapes what it interpolates ---

test("hostile markup in brief fields is escaped in generated block html", async () => {
  const ticket = cleanTicket({
    goal: 'Announce <script>alert(1)</script> to everyone',
    cta_href: 'https://www.northwindstudio.example/x"onmouseover="alert(1)',
  });
  const draft = await generateDraft(ticket, brand, mock);
  const allHtml = draft.blocks.map((b) => b.html).join("");
  assert.ok(!allHtml.includes("<script>"));
  // A quote inside the href must be entity-escaped so it cannot close the
  // attribute and plant an event handler.
  const ctaHtml = draft.blocks.find((b) => b.kind === "cta")!.html;
  assert.ok(!/"\s*onmouseover\s*=/.test(ctaHtml), "quote must not break out of the href attribute");
  assert.ok(ctaHtml.includes("&quot;"));
});

// --- provider boundary: raw never leaves, identity must match ---

function spyLLM(draftOverride?: Partial<ModelDraft>): { llm: LLM; seen: Record<string, unknown> } {
  const seen: Record<string, unknown> = {};
  const llm: LLM = {
    provider: "mock",
    async complete(task: LlmTask, input: unknown) {
      seen[task] = input;
      const out = await mock.complete(task, input);
      if (task === "draft" && draftOverride) return { ...(out as ModelDraft), ...draftOverride };
      return out;
    },
  };
  return { llm, seen };
}

test("the raw brief never reaches the draft or review provider calls", async () => {
  const { llm, seen } = spyLLM();
  const ticket = cleanTicket();
  const draft = await generateDraft(ticket, brand, llm);
  await reviewDraft(ticket, draft, { status: "pass", violations: [] }, llm);
  for (const task of ["draft", "review"]) {
    const payload = JSON.stringify(seen[task]);
    assert.ok(!payload.includes(ticket.raw), `${task} input must not carry ticket.raw`);
  }
});

test("a schema-valid draft carrying the wrong ticket identity is rejected", async () => {
  const { llm } = spyLLM({ ticket_id: "t-other-999" });
  await assert.rejects(
    () => generateDraft(cleanTicket(), brand, llm),
    /ticket/i,
  );
});

test("generateDraft throws when the provider returns junk", async () => {
  const junk: LLM = { provider: "mock", complete: async () => ({ nope: true }) };
  await assert.rejects(() => generateDraft(cleanTicket(), brand, junk), /email_draft.v1/);
});

test("a malformed reviewer response fails safe to score 0", async () => {
  const junk: LLM = { provider: "mock", complete: async () => "not json shaped" };
  const verdict = await reviewDraft(cleanTicket(), cleanDraft(), { status: "pass", violations: [] }, junk);
  assert.equal(verdict.score, 0);
});

// --- rewriteSpans behavior ---

test("rewriteSpans excludes blocked violations and survives malformed output", async () => {
  const violations: Violation[] = [
    { rule_id: "FORBIDDEN_PHRASE", severity: "block", policy_class: "synthetic_poc_policy", message: "m", span: "game-changing" },
    { rule_id: "CLAIM_IMPLIED", severity: "escalate", policy_class: "synthetic_poc_policy", message: "m", span: "in half" },
  ];
  const { llm, seen } = spyLLM();
  const proposal = await rewriteSpans(cleanDraft(), violations, llm);
  const sent = JSON.stringify(seen["rewrite"]);
  assert.ok(!sent.includes("game-changing"), "blocked spans never reach the rewrite provider");
  assert.deepEqual(proposal.spans, [{ original: "in half", replacement: "" }]);

  const junk: LLM = { provider: "mock", complete: async () => ({ spans: "wat" }) };
  const empty = await rewriteSpans(cleanDraft(), violations, junk);
  assert.deepEqual(empty.spans, []);

  const none = await rewriteSpans(cleanDraft(), [violations[0]!], junk);
  assert.deepEqual(none.spans, []);
});

// --- gate sees draft-level needs_input ---

test("composeDraft routes a draft that raises its own needs_input to review", async () => {
  const { llm } = spyLLM({ needs_input: ["confirm the offer wording"] });
  // The real clean brief reaches ready_for_cio on the plain mock (E1), so the
  // ONLY thing standing between this run and ready is the draft's own
  // needs_input - which must pull it back to review.
  const brief = JSON.parse(
    (await import("node:fs")).readFileSync("evals/briefs/clean-nurture.json", "utf8"),
  );
  const result = await composeDraft(brief, brand, llm);
  assert.equal(result.gate, "review");
});

// --- preview highlighting stays out of attributes ---

test("highlight marks never land inside an href attribute", () => {
  const base = cleanDraft();
  const bad = cleanDraft({
    cta: { ...base.cta, href: "https://bit.ly/xyz" },
    blocks: base.blocks.map((b) =>
      b.kind === "cta" ? { ...b, html: '<a href="https://bit.ly/xyz">Go</a>' } : b,
    ),
  });
  const withFooter = attachFooter(bad, brand);
  const linted = { ...withFooter, lint: lintEmail(withFooter, brand) };
  const html = renderPreview(linted, "blocked");
  assert.ok(!/href="[^"]*<mark/.test(html), "no mark inside href attributes");
});

// --- footer chrome cannot be model-authored ---

test("attachFooter drops a model-authored footer block and installs the locked one", () => {
  const base = cleanDraft();
  const sneaky = cleanDraft({
    blocks: [...base.blocks, { kind: "footer", text: "fake", html: "<p>fake footer, no unsub</p>" }],
  });
  const out = attachFooter(sneaky, brand);
  const footers = out.blocks.filter((b) => b.kind === "footer");
  assert.equal(footers.length, 1);
  assert.ok(footers[0]!.html.includes("/unsubscribe"));
});

// --- play.yaml is wired, not decorative ---

test("play.yaml is read at runtime and its thresholds match the locked gate constants", () => {
  const nurture = loadPlay("nurture");
  const launch = loadPlay("launch");
  assert.equal(nurture.cio_pattern, "design_studio");
  assert.equal(launch.cio_pattern, "design_studio");
  // The gate's 0.7 thresholds are locked by design; the play files must not
  // drift from them silently.
  for (const play of [nurture, launch]) {
    assert.equal(play.thresholds.reviewer_min_score, 0.7);
    assert.equal(play.thresholds.ticket_min_confidence, 0.7);
  }
});

// --- approved claims stay number-free (CLAIM_NUMBER's stated assumption) ---

test("no approved claim contains digits, keeping the numeric-claim rules sound", () => {
  for (const claim of brand.claims) {
    assert.ok(!/\d/.test(claim.text), `claim ${claim.id} contains digits`);
  }
  assert.ok(brand.claims.some((c) => c.id === CLAIM.id));
});
