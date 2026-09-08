// Brief → EmailTicket. Thin on purpose: the provider does the parsing, this
// step owns the contract. Whatever comes back, mock or live model, must
// validate as email_ticket.v1 before anything downstream sees it.
import { validateTicketShape, type EmailTicket } from "./schema.js";
import type { LLM } from "../llm.js";

export interface Brief {
  ticket_id: string;
  source: string;
  raw: string;
}

export async function parseTicket(brief: Brief, llm: LLM): Promise<EmailTicket> {
  const raw = await llm.complete("intake", brief);
  const result = validateTicketShape(raw);
  if (!result.ok) {
    throw new Error(`intake output failed email_ticket.v1: ${result.issues.join("; ")}`);
  }
  return result.value;
}
