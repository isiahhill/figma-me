// Ticket → model draft. The provider only ever sees the validated ticket and
// approved context (claims, voice, sender) — never the raw brief, never the
// filesystem, never the network. Output is schema-checked before it exists
// as far as the rest of the pipeline is concerned.
import { validateDraftShape, type EmailTicket, type ModelDraft } from "./schema.js";
import type { BrandContext } from "./retrieveContext.js";
import type { LLM } from "../llm.js";

export async function generateDraft(
  ticket: EmailTicket,
  brand: BrandContext,
  llm: LLM,
): Promise<ModelDraft> {
  // The raw brief stays OUT of provider input. It lives on the ticket for
  // audit artifacts only; the draft model gets structured fields + approved
  // context, so instruction-like text in a brief has no second chance here.
  const { raw: _raw, ...safeTicket } = ticket;
  const output = await llm.complete("draft", {
    ticket: safeTicket,
    claims: brand.claims,
    voice: brand.voice,
    from: brand.from,
  });
  const result = validateDraftShape(output);
  if (!result.ok) {
    throw new Error(`draft output failed email_draft.v1: ${result.issues.join("; ")}`);
  }
  // Identity correlation: a schema-valid draft for some OTHER ticket must
  // never be linted, previewed, or packaged under this ticket's name.
  if (result.value.ticket_id !== ticket.ticket_id || result.value.type !== ticket.type) {
    throw new Error(
      `draft identity mismatch: draft is for ${result.value.ticket_id}/${result.value.type}, ticket is ${ticket.ticket_id}/${ticket.type}`,
    );
  }
  return result.value;
}
