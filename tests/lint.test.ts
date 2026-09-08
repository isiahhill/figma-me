// Unit tests for the deterministic lint layer. The forbidden-phrase matcher
// gets its own detailed coverage because it is the piece most likely to be
// probed in review (word boundaries, quote/case normalization, precedence).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  lintEmail,
  matchForbidden,
  normalizePhraseText,
} from "../src/steps/lintEmail.js";
import { attachFooter } from "../src/steps/attachFooter.js";
import { brand, cleanDraft, withBodyText } from "./helpers.js";

function ruleIds(draft: Parameters<typeof lintEmail>[0]) {
  return lintEmail(draft, brand).violations.map((v) => v.rule_id);
}

// --- forbidden-phrase matcher ---

test("matcher: 'sale' does not fire on 'wholesale' (word boundaries)", () => {
  assert.deepEqual(matchForbidden("Ask about our wholesale program", ["sale"]), []);
});

test("matcher: fires on the exact word regardless of case", () => {
  const hits = matchForbidden("This is GAME-CHANGING for teams", ["game-changing"]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.phrase, "game-changing");
});

test("matcher: normalizes curly quotes before matching", () => {
  const hits = matchForbidden("We promise “guaranteed results” today", [
    "guaranteed results",
  ]);
  assert.equal(hits.length, 1);
});

test("matcher: longer phrases take precedence over contained words", () => {
  const hits = matchForbidden("the lowest price around", ["price", "lowest price"]);
  assert.equal(hits[0]!.phrase, "lowest price");
});

test("matcher: multi-word phrase matches across flexible whitespace", () => {
  const hits = matchForbidden("guaranteed   results, they said", [
    "guaranteed results",
  ]);
  assert.equal(hits.length, 1);
});

test("matcher reports spans in normalized form so downstream display stays stable", () => {
  // Normalization is NOT length-preserving (NFKC + zero-width stripping), so
  // spans are reported from the normalized text; a span may therefore differ
  // from the original bytes, and consumers (preview highlight) tolerate a
  // span that no longer appears verbatim.
  const hits = matchForbidden("It’s “GAME-CHANGING”", ["game-changing"]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.span, "game-changing");
  assert.equal(normalizePhraseText("game‐changing"), "game-changing");
});

// --- whole-draft lint ---

test("clean draft with footer passes with zero violations", () => {
  const report = lintEmail(attachFooter(cleanDraft(), brand), brand);
  assert.equal(report.status, "pass");
  assert.deepEqual(report.violations, []);
});

test("footer digits do not trigger CLAIM_NUMBER (chrome is excluded)", () => {
  const report = lintEmail(attachFooter(cleanDraft(), brand), brand);
  assert.ok(!report.violations.some((v) => v.rule_id === "CLAIM_NUMBER"));
});

test("missing footer fires CAN_UNSUB and CAN_ADDRESS", () => {
  const ids = ruleIds(cleanDraft());
  assert.ok(ids.includes("CAN_UNSUB"));
  assert.ok(ids.includes("CAN_ADDRESS"));
});

test("wrong sender fires CAN_SENDER", () => {
  const draft = attachFooter(
    cleanDraft({ from_email: "sales@northwindstudio.example" }),
    brand,
  );
  assert.ok(ruleIds(draft).includes("CAN_SENDER"));
});

test("http link fires LINK_HTTPS", () => {
  const base = cleanDraft();
  const draft = attachFooter(
    cleanDraft({
      cta: { ...base.cta, href: "http://www.northwindstudio.example/x" },
      blocks: base.blocks.map((b) =>
        b.kind === "cta"
          ? { ...b, html: '<a href="http://www.northwindstudio.example/x">Go</a>' }
          : b,
      ),
    }),
    brand,
  );
  assert.ok(ruleIds(draft).includes("LINK_HTTPS"));
});

test("off-brand CTA host fires CTA_DOMAIN", () => {
  const base = cleanDraft();
  const draft = attachFooter(
    cleanDraft({
      cta: { ...base.cta, href: "https://bit.ly/xyz" },
      blocks: base.blocks.map((b) =>
        b.kind === "cta" ? { ...b, html: '<a href="https://bit.ly/xyz">Go</a>' } : b,
      ),
    }),
    brand,
  );
  assert.ok(ruleIds(draft).includes("CTA_DOMAIN"));
});

test("zero CTA blocks fires CTA_COUNT; two primary CTAs fires CTA_COUNT", () => {
  const base = cleanDraft();
  const none = attachFooter(
    cleanDraft({ blocks: base.blocks.filter((b) => b.kind !== "cta") }),
    brand,
  );
  assert.ok(ruleIds(none).includes("CTA_COUNT"));

  const ctaBlock = base.blocks.find((b) => b.kind === "cta")!;
  const two = attachFooter(
    cleanDraft({ blocks: [...base.blocks, { ...ctaBlock }] }),
    brand,
  );
  assert.ok(ruleIds(two).includes("CTA_COUNT"));
});

test("numeric performance claim fires CLAIM_NUMBER (block)", () => {
  for (const phrase of ["a 47 percent ROI lift", "ship 50% faster", "get 10x output"]) {
    const draft = attachFooter(withBodyText(cleanDraft(), phrase), brand);
    const report = lintEmail(draft, brand);
    const hit = report.violations.find((v) => v.rule_id === "CLAIM_NUMBER");
    assert.ok(hit, `expected CLAIM_NUMBER for "${phrase}"`);
    assert.equal(hit.severity, "block");
    assert.equal(report.status, "fail");
  }
});

test("implied quantitative claim escalates, not blocks (E6 shape)", () => {
  const draft = attachFooter(
    withBodyText(cleanDraft(), "It will cut your hours in half."),
    brand,
  );
  const report = lintEmail(draft, brand);
  const hit = report.violations.find((v) => v.rule_id === "CLAIM_IMPLIED");
  assert.ok(hit);
  assert.equal(hit.severity, "escalate");
  assert.equal(report.status, "escalate");
});

test("uncleared customer name fires NAMED_CUSTOMER; cleared reference does not", () => {
  const bad = attachFooter(
    withBodyText(cleanDraft(), "We made Acme Corp our hero."),
    brand,
  );
  assert.ok(ruleIds(bad).includes("NAMED_CUSTOMER"));

  const cleared = attachFooter(
    withBodyText(cleanDraft(), "Harbor Bank runs its design system on Northwind."),
    brand,
  );
  assert.ok(!ruleIds(cleared).includes("NAMED_CUSTOMER"));
});

test("subject outside 8-78 chars warns (synthetic policy, not law)", () => {
  for (const subject of ["Hi all", "x".repeat(79)]) {
    const draft = attachFooter(cleanDraft({ subject }), brand);
    const report = lintEmail(draft, brand);
    const hit = report.violations.find((v) => v.rule_id === "SUBJECT_LEN");
    assert.ok(hit, `expected SUBJECT_LEN for length ${subject.length}`);
    assert.equal(hit.severity, "warn");
    assert.equal(hit.policy_class, "synthetic_poc_policy");
    assert.equal(report.status, "warn");
  }
});

test("unknown Liquid token fires LIQUID_UNRESOLVED", () => {
  const draft = attachFooter(
    withBodyText(cleanDraft(), "Your plan: {{customer.plan_name}}"),
    brand,
  );
  assert.ok(ruleIds(draft).includes("LIQUID_UNRESOLVED"));
});

test("first_name without if/else wrap fires LIQUID_UNRESOLVED", () => {
  const base = cleanDraft();
  const bare = "Hi {{ customer.first_name }}, welcome back.";
  const draft = attachFooter(
    cleanDraft({
      blocks: base.blocks.map((b) =>
        b.kind === "body" ? { ...b, text: bare, html: `<p>${bare}</p>` } : b,
      ),
      // The clean citation span lives in the body we just replaced.
      citations: [],
    }),
    brand,
  );
  assert.ok(ruleIds(draft).includes("LIQUID_UNRESOLVED"));
});

test("citation with unknown claim_id fires NO_FABRICATED_FALLBACK", () => {
  const draft = attachFooter(
    cleanDraft({ citations: [{ claim_id: "claim.made_up", span: "whatever" }] }),
    brand,
  );
  assert.ok(ruleIds(draft).includes("NO_FABRICATED_FALLBACK"));
});

test("citation span missing from draft fires NO_FABRICATED_FALLBACK", () => {
  const draft = attachFooter(
    cleanDraft({
      citations: [
        { claim_id: "claim.handoff", span: "Handoff gives developers a faster path from design to code" },
      ],
    }),
    brand,
  );
  assert.ok(ruleIds(draft).includes("NO_FABRICATED_FALLBACK"));
});

test("identical rule+span findings are reported once, not per scan surface", () => {
  // The CTA URL appears in both the block html and cta.href; one bad URL is
  // one finding, not two.
  const base = cleanDraft();
  const draft = attachFooter(
    cleanDraft({
      cta: { ...base.cta, href: "http://bit.ly/xyz" },
      blocks: base.blocks.map((b) =>
        b.kind === "cta" ? { ...b, html: '<a href="http://bit.ly/xyz">Go</a>' } : b,
      ),
    }),
    brand,
  );
  const hits = lintEmail(draft, brand).violations.filter(
    (v) => v.rule_id === "LINK_HTTPS",
  );
  assert.equal(hits.length, 1);
});

test("an empty CTA href is a CTA problem, not a LINK_HTTPS finding", () => {
  const base = cleanDraft();
  const draft = attachFooter(
    cleanDraft({
      cta: { ...base.cta, href: "" },
      blocks: base.blocks.filter((b) => b.kind !== "cta"),
    }),
    brand,
  );
  const ids = ruleIds(draft);
  assert.ok(ids.includes("CTA_COUNT"));
  assert.ok(ids.includes("CTA_DOMAIN"));
  assert.ok(!ids.includes("LINK_HTTPS"));
});

test("every violation carries a policy_class label", () => {
  const base = cleanDraft();
  const messy = attachFooter(
    withBodyText(
      cleanDraft({
        subject: "Hi",
        cta: { ...base.cta, href: "https://bit.ly/x" },
      }),
      "a game-changing 10x overnight win for Acme Corp",
    ),
    brand,
  );
  const report = lintEmail(messy, brand);
  assert.ok(report.violations.length >= 3);
  for (const v of report.violations) {
    assert.ok(
      v.policy_class === "structural" || v.policy_class === "synthetic_poc_policy",
      `${v.rule_id} missing policy_class`,
    );
  }
});
