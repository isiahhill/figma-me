// Customer.io payload: create-only, allowlisted, no send surface anywhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cioPayload } from "../src/steps/cioPayload.js";
import {
  loadAllowlist,
  assertAllowedSdk,
  assertNoSendSurface,
} from "../src/steps/allowlist.js";
import { attachFooter } from "../src/steps/attachFooter.js";
import { brand, cleanDraft, cleanTicket } from "./helpers.js";
import type { EmailDraft } from "../src/steps/schema.js";

function readyDraft(): EmailDraft {
  return {
    ...attachFooter(cleanDraft(), brand),
    lint: { status: "pass", violations: [] },
  };
}

test("design studio payload has the locked create-only shape", () => {
  const payload = cioPayload(cleanTicket(), readyDraft(), { date: "2026-09-16" });
  assert.equal(payload.pattern, "design_studio");
  assert.equal(payload.method, "POST");
  assert.equal(payload.sdk, "createDesignStudioEmail");
  assert.equal(payload.body.name, "Nurture · t-clean-001 · 2026-09-16");
  assert.equal(payload.body.is_template, false);
  assert.equal(payload.body.envelope?.recipient, "{{customer.email}}");
  assert.ok(payload.body.content.subject.length > 0);
  assert.ok(payload.body.content.preheader_text.length > 0);
  assert.ok(payload.body.content.text.length > 0);
});

test("payload html carries the locked footer and the CTA", () => {
  const payload = cioPayload(cleanTicket(), readyDraft(), { date: "2026-09-16" });
  assert.ok(payload.body.content.html.includes("/unsubscribe"));
  assert.ok(payload.body.content.html.includes("Oakland, CA 94607"));
  assert.ok(
    payload.body.content.html.includes("https://www.northwindstudio.example/walkthrough"),
  );
});

test("newsletter pattern flags the sdk and never attaches an audience", () => {
  const payload = cioPayload(cleanTicket({ type: "launch" }), readyDraft(), {
    pattern: "newsletter",
    date: "2026-09-16",
  });
  assert.equal(payload.sdk, "createNewsletter");
  assert.equal(payload.pattern, "newsletter");
  // Recipients are REQUIRED at create by the real API. This pipeline has no
  // audience-mutation permission, so it emits null and a human attaches the
  // segment in the Customer.io UI.
  assert.equal(payload.body.recipients, null);
  assert.equal(payload.body.envelope, undefined);
  assert.ok(payload.body.name.startsWith("Launch"));
});

test("allowlist contains exactly the two create methods", () => {
  assert.deepEqual(loadAllowlist("cio/allowlist.yaml"), [
    "createDesignStudioEmail",
    "createNewsletter",
  ]);
});

test("non-allowlisted sdk methods are rejected", () => {
  const allowed = loadAllowlist("cio/allowlist.yaml");
  assertAllowedSdk("createDesignStudioEmail", allowed);
  assertAllowedSdk("createNewsletter", allowed);
  assert.throws(() => assertAllowedSdk("queue_draft", allowed));
  assert.throws(() => assertAllowedSdk("triggerBroadcast", allowed));
});

test("send surface guard rejects send/schedule/trigger keys at any depth", () => {
  assert.throws(() => assertNoSendSurface({ body: { send_at: 123 } }));
  assert.throws(() => assertNoSendSurface({ schedule: {} }));
  assert.throws(() => assertNoSendSurface({ a: { b: { trigger_broadcast: true } } }));
  assert.throws(() => assertNoSendSurface({ sdk: "sendEmail" }));
});

test("emitted payloads pass the send surface guard", () => {
  const ds = cioPayload(cleanTicket(), readyDraft(), { date: "2026-09-16" });
  assertNoSendSurface(ds);
  const nl = cioPayload(cleanTicket({ type: "launch" }), readyDraft(), {
    pattern: "newsletter",
    date: "2026-09-16",
  });
  assertNoSendSurface(nl);
  // Belt and suspenders: no key in the serialized payload matches the
  // forbidden verbs either.
  const keys: string[] = [];
  JSON.stringify(ds, (k, v) => {
    if (k) keys.push(k);
    return v;
  });
  for (const k of keys) {
    assert.ok(!/send|schedule|trigger/i.test(k), `forbidden key: ${k}`);
  }
});
