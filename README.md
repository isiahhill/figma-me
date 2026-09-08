# email-cortex

A governed email production pipeline. A messy brief goes in, an approved, brand-safe, Customer.io-ready draft comes out, and a person still says yes before anything ships.

It runs offline and deterministically. Every input is synthetic.

## Run it

```bash
npm ci
npm test        # 88 assertions, 12 of 12 golden scenarios
npm run demo    # the clean, messy, and hostile briefs, end to end
npm run break   # a fabricated statistic injected into a clean brief
```

`npm run demo` and `npm run break` write artifacts to `reports/runs/<scenario>/`. A captured run of all four is checked in under `sample-runs/`, so the inputs and outputs can be read without running anything.

## What to look at first

| If you want to see | Open |
|---|---|
| Where deterministic logic ends and model judgment begins | `src/pipeline.ts`, eleven steps, and the model touches four |
| The rule that cannot be talked around | `src/steps/lintEmail.ts` and `brand/rules.v1.yaml` |
| Why a fabricated number cannot ship | `brand/claims.v1.yaml`, then `sample-runs/break/` |
| How a person gets pulled in | `src/steps/hitlGate.ts`, three exits, each with a stated trigger |
| That no send path exists | `src/steps/allowlist.ts` and `cio/allowlist.yaml` |
| What good output means | `evals/briefs/` and `evals/golden/` |
| The reusable pieces | `prompts/`, `skills/`, `schemas/`, `brand/` |

## The shape of it

Eleven steps. The model reads the brief, drafts inside a schema, rewrites failing spans once, and scores the result. It never decides whether something ships.

```
intake (AI) -> validate (code) -> plan (code) -> retrieve (code)
   -> draft (AI) -> schema + brand lint (code, fails closed)
   -> one constrained rewrite (AI) -> advisory score (AI)
   -> re-lint and gate (code) -> human preview -> create-only handoff
```

Three things are deliberate.

**The gate calls no model.** Hard brand rules are code, so a persuasive draft cannot argue its way past them. `blocked` means a block rule fired. `review` means a soft rule warned or the advisory score was low. `needs_input` means a required field was missing or intake confidence fell under the threshold. The model can pull a draft down to review, never up.

**Every factual line cites its source.** A number that is not in `brand/claims.v1.yaml` becomes a question for a human, never an invention. `npm run break` injects "47 percent ROI" into an otherwise clean brief; the run stops with `CLAIM_NUMBER` and writes no payload.

**There is no send.** The handoff builds a create-only Customer.io payload with no audience attached. Sending, scheduling, and triggering are not implemented rather than merely disabled, and two independent guards fail the test suite if a payload ever grows one.

## Evaluation

Twelve golden scenarios, each a brief plus the lint verdict and gate status it must produce: clean, messy, hostile, wholesale-versus-sale, footer bypass, implied claim, contradictory dates, competitor and legal terms, oversized, wrong language, malformed URL, and prompt injection. Half the set is designed to fail. Runs carry no timestamps, so a rerun is byte-identical and a diff in a golden file means a real behavior change.

## Telemetry

`src/steps/emitEvent.ts` writes one JSON line per stage to `events.jsonl`, carrying ids and outcomes only. Never the pasted brief, the block copy, the subject line, or the approval note, because that file is the one artifact meant to leave the run folder for a log pipeline, and a log pipeline is searchable by everyone.

## Versioning

Prompts and skills are versioned files. A behavior change is a new version, a changelog entry in `prompts/CHANGELOG.md`, and a green eval run. Golden outputs live in the repo, so drift shows up as a diff a reviewer can read rather than a feeling that output got worse.

## Scope

One meaningful slice, built end to end, rather than a thin version of everything. Deliberately out: sending and scheduling, live Customer.io calls, audience selection, Slack intake, automated revision loops, other email types, localization, and account-based landing pages.

## A note on the data

The brand, the claims table, the briefs, and the payloads are invented for this build. No real company content, customer data, or internal material went into it. `tests/synthetic-inputs.test.ts` fails the suite if that stops being true: it holds the fixtures to one fictional sender and one example domain, refuses a live sending host anywhere in the tree, and refuses any tracked file shaped like a brief, an assignment or a transcript.

Working notes, drafts and reference material live in `local/`, which is git-ignored and ships empty. The same material is also refused by name wherever it lands, so a file dropped at the repo root instead of in that folder is still kept out.
