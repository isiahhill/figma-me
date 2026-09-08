// The HITL gate (the release decision) in code, exactly as locked in the
// plan. The model's reviewer score is one advisory input; it can pull a draft
// DOWN into review but nothing here lets any model output override a block.
// There is no "sent" state on purpose: ready_for_cio means "payload is valid
// to CREATE a Design Studio email", and a human does everything after that.
import type { LintReport } from "./schema.js";

export type GateStatus = "blocked" | "review" | "ready_for_cio";

export interface GateInputs {
  lint: LintReport;
  reviewer: { score: number };
  ticket: { confidence: number; needs_input: string[] };
}

export function hitlGate({ lint, reviewer, ticket }: GateInputs): GateStatus {
  if (lint.violations.some((v) => v.severity === "block")) {
    return "blocked";
  }
  if (
    lint.violations.some((v) => v.severity === "escalate") ||
    reviewer.score < 0.7 ||
    ticket.confidence < 0.7 ||
    ticket.needs_input.length > 0
  ) {
    return "review";
  }
  if ((lint.status === "pass" || lint.status === "warn") && reviewer.score >= 0.7) {
    return "ready_for_cio";
  }
  // Defensive fallthrough: any state the ready branch does not positively
  // recognize goes to a human. Fail safe, never fail open.
  return "review";
}
