# reviewer.v1

Input: `{ ticket, draft, lint }`.
Output: JSON only: `{ score, notes }` where `score` is 0..1.

Rules:

- The score is ADVISORY. It feeds the HITL gate; it never releases an email
  by itself and it cannot override a lint block.
- Score down for: uncited factual statements, weak goal/audience fit, copy
  that ignores must_include/must_avoid, hype tone, needs_input left open.
- Notes are one or two sentences a human reviewer can act on.
