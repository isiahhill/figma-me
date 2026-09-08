# Prompt changelog

Prompts are versioned files; a behavior change is a new version + an entry
here + an eval run. The eval suite is the regression gate for prompt edits.

The same discipline covers `brand/rules.v1.yaml` (see "Rules" below): the
policy file is versioned in its `version:` field, and a rule change is an
entry here plus a green eval run with goldens updated on purpose.

## Rules

### 2026-09-08: rules.v1 → rules.v1.1

- `LEGAL_TERM` added (severity `escalate`, policy_class `synthetic_poc_policy`).
  Regulatory and legal-exposure vocabulary (compliance certifications,
  indemnity, litigation, warranty) routes to a human instead of blocking:
  counsel may have approved the exact wording, the model may not assert it
  alone. Whole-word match on normalized copy via the FORBIDDEN_PHRASE engine.
  Additive, so the in-file `version:` bumps to `rules.v1.1` and the file name
  stays `rules.v1.yaml` (the loader and every doc cite it by name; a `v2`
  file is reserved for a rule removed or a severity loosened). No existing
  rule changed. Evals E1–E11 unchanged; E12 pins the new rule's severity in
  `evals/golden/e12-competitor-legal.json`.

## 2026-09-02

- `intake.v1`: initial. Brief-as-data rule, uncleared-claim quarantine into
  needs_input, confidence semantics.
- `draft.v1`: initial. Claims-or-ticket-fields-only sourcing, citation
  requirement, no footer, single primary CTA, Liquid allowlist.
- `rewrite-spans.v1`: initial. One constrained proposal per flagged span,
  warn/escalate only, no new facts.
- `reviewer.v1`: initial. Advisory score, cannot override lint.
