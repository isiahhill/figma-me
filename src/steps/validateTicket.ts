// Ticket validation gate between intake and everything else. Distinct from
// the shape check inside parseTicket so the pipeline (and the eval runner)
// can validate tickets that arrive from anywhere — a file, a fixture, a
// future queue — not just ones this process parsed.
import { validateTicketShape, type EmailTicket } from "./schema.js";

export function validateTicket(x: unknown): EmailTicket {
  const result = validateTicketShape(x);
  if (!result.ok) {
    throw new Error(`ticket failed email_ticket.v1: ${result.issues.join("; ")}`);
  }
  const ticket = result.value;
  // Belt and suspenders on the invariant the gate depends on: a ticket that
  // admits it is missing facts cannot also claim high confidence.
  if (ticket.needs_input.length > 0 && ticket.confidence > 0.7) {
    return { ...ticket, confidence: 0.7 };
  }
  return ticket;
}
