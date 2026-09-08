// Advisory reviewer. The score feeds the HITL gate as ONE input; it can pull
// a draft into review but can never clear a block or push a send. That
// asymmetry is the point of calling it advisory.
import type { EmailTicket, LintReport, ModelDraft } from "./schema.js";
import type { LLM } from "../llm.js";

export interface ReviewerVerdict {
  score: number;
  notes: string;
}

export async function reviewDraft(
  ticket: EmailTicket,
  draft: ModelDraft,
  lint: LintReport,
  llm: LLM,
): Promise<ReviewerVerdict> {
  // Same boundary as generateDraft: the raw brief never reaches a provider.
  const { raw: _raw, ...safeTicket } = ticket;
  const raw = (await llm.complete("review", { ticket: safeTicket, draft, lint })) as Partial<ReviewerVerdict>;
  const score = typeof raw.score === "number" ? Math.max(0, Math.min(1, raw.score)) : 0;
  // A malformed reviewer response scores 0 → the gate routes to human
  // review. Failing safe beats failing loudly here: the draft is fine, the
  // reviewer is not, and a human can still ship it.
  return { score, notes: typeof raw.notes === "string" ? raw.notes : "" };
}
