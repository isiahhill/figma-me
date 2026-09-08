// One constrained rewrite pass, as a PROPOSAL for the human reviewer.
// Blocked violations are excluded before the provider ever sees them: the
// agent may suggest softening flagged language, it may not write its way
// around a block. The pipeline attaches the proposal to the run artifacts;
// nothing applies it automatically.
import type { ModelDraft, Violation } from "./schema.js";
import type { LLM } from "../llm.js";

export interface RewriteProposal {
  spans: { original: string; replacement: string }[];
}

export async function rewriteSpans(
  draft: ModelDraft,
  violations: Violation[],
  llm: LLM,
): Promise<RewriteProposal> {
  const eligible = violations.filter((v) => v.severity !== "block");
  if (eligible.length === 0) return { spans: [] };
  const raw = (await llm.complete("rewrite", { draft, violations: eligible })) as
    | Partial<RewriteProposal>
    | undefined;
  const spans = Array.isArray(raw?.spans)
    ? raw.spans.filter(
        (s): s is { original: string; replacement: string } =>
          typeof s?.original === "string" && typeof s?.replacement === "string",
      )
    : [];
  return { spans };
}
