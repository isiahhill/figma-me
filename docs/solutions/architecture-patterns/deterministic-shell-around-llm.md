---
title: "Deterministic shell around an LLM: schema -> lint -> gate -> create-only handoff"
module: "email-cortex pipeline"
date: "2026-09-02"
problem_type: architecture_pattern
component: email_processing
severity: high
applies_when: "Building any workflow where model output becomes an outward-facing artifact (email, page, payload) and a human team must stay the release authority"
tags: ["llm-guardrails", "hitl", "policy-as-code", "customer-io", "lint"]
---

# Deterministic shell around an LLM

## Context

Third build of this shape on this machine (after the Dope Dads sendMail
choke-point and the Cloudflare email policy gate): a model produces content,
and the question is never "can the model write it" but "what stops a bad one
from shipping". This repo made the shell the whole product: intake schema ->
brand lint -> HITL gate -> create-only payload, with the model boxed into
parse/draft/propose/score.

## Guidance

- Put every guarantee in a layer the model cannot touch: schemas the output
  must validate against, a lint engine driven by a reviewed YAML policy file
  (severity + policy_class per rule), a gate whose if/else is code, and a
  payload type that cannot express "send". Absent capability beats prompt
  instructions every time.
- Make the mock provider deliberately obedient to hostile input. If the
  generator "behaves", your evals prove nothing about enforcement; when it
  faithfully includes what a hostile brief asked for, every green eval is
  evidence the policy layer works.
- Lint the artifact that ships, not a sibling representation. Our review's
  biggest finding class: rules scanned block.text while the payload shipped
  block.html. Scan the canonical output (or enforce parity) or the whole
  layer polices a decoy.
- Escape at every interpolation into markup, and normalize (NFKC,
  zero-width strip, dash folding) before any phrase/number matching -
  unicode variants walked straight past block-severity rules until they were
  folded away.
- Verification scripts are attack surface too: a selfcheck that reads stale
  artifacts or accepts "0 tests, 0 failures" certifies a regression as
  green. Regenerate evidence inside the check and set count floors.
- Keep one composition function (brief -> gated draft) shared by the
  pipeline and the eval runner, or the two paths drift.

## Why This Matters

The failure mode of "AI writes X" products is unreviewable output shipping
on model goodwill. This shape converts the trust question into ordinary
code review: policy lives in YAML a marketer can PR, evals are the
regression gate, and the human release authority survives automation.

## When to Apply

Any brief -> model -> outward artifact flow: emails, landing pages, CRM
payloads, social posts. Especially when the destination API can mutate
audience-facing state - default to the create-only endpoint and let a human
connect the final wire.

## Examples

See this repo end to end: `src/steps/lintEmail.ts` (policy engine),
`src/steps/hitlGate.ts` (locked gate), `src/steps/cioPayload.ts` +
`cio/allowlist.yaml` (create-only surface), `tests/hardening.test.ts`
(adversarial regression locks), `scripts/selfcheck.ts` (self-regenerating
quality bar).
