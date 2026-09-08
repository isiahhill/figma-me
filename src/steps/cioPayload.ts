// Builds the create-only Customer.io handoff. Both patterns are content
// management endpoints: they cannot publish or send. Design Studio is the
// default because create attaches no audience at all; the newsletter pattern
// exists as a launch-play flag and still never attaches recipients (the
// agent has no audience-mutation permission, a human picks the segment in
// the Customer.io UI, which is the QA surface).
import type { EmailDraft, EmailTicket } from "./schema.js";

export type CioPattern = "design_studio" | "newsletter";

export interface CioPayload {
  pattern: CioPattern;
  method: "POST";
  sdk: "createDesignStudioEmail" | "createNewsletter";
  body: {
    name: string;
    is_template: false;
    content: { subject: string; preheader_text: string; html: string; text: string };
    envelope?: { recipient: "{{customer.email}}" };
    recipients?: null;
  };
}

// 600px table wrapper, the same skeleton the preview renders, so what the
// reviewer approved is byte-for-byte what lands in Customer.io.
export function emailHtml(draft: EmailDraft): string {
  const rows = draft.blocks
    .map((b) => `      <tr><td style="padding:8px 24px;">${b.html}</td></tr>`)
    .join("\n");
  return [
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">',
    '  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;font-family:Helvetica,Arial,sans-serif;color:#111;">',
    rows,
    "  </table>",
    "</td></tr></table>",
  ].join("\n");
}

export function emailText(draft: EmailDraft): string {
  return draft.blocks.map((b) => b.text).join("\n\n");
}

export function cioPayload(
  ticket: EmailTicket,
  draft: EmailDraft,
  opts: { pattern?: CioPattern; date: string },
): CioPayload {
  const pattern = opts.pattern ?? "design_studio";
  const label = ticket.type === "nurture" ? "Nurture" : "Launch";
  const body: CioPayload["body"] = {
    name: `${label} · ${ticket.ticket_id} · ${opts.date}`,
    is_template: false,
    content: {
      subject: draft.subject,
      preheader_text: draft.preheader,
      html: emailHtml(draft),
      text: emailText(draft),
    },
  };
  if (pattern === "design_studio") {
    body.envelope = { recipient: "{{customer.email}}" };
    return { pattern, method: "POST", sdk: "createDesignStudioEmail", body };
  }
  body.recipients = null;
  return { pattern, method: "POST", sdk: "createNewsletter", body };
}
