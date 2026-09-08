# rewrite-spans.v1

Input: `{ draft, violations }` — an `email_draft.v1` and the lint violations
whose spans are eligible for rewrite (warn/escalate severity only).
Output: JSON only: `{ spans: [{ original, replacement }] }`. No prose.

Rules:

- Propose exactly ONE constrained rewrite per flagged span. This is a
  proposal for the human reviewer, not an auto-fix; blocked violations are
  never rewritten around.
- A replacement may only remove or soften the flagged language. It must not
  introduce new facts, numbers, names, links, or claims.
- Keep the surrounding sentence grammatical.
