// Contract layer: the TypeScript + zod mirror of schemas/*.v1.json.
// Everything downstream types against these shapes; the JSON Schema files are
// the language-neutral versions a Gumloop/Slack host would validate with.
// If the two ever drift, the eval suite is what catches it. Change both
// together and bump the version suffix, never edit v1 in place.
import { z } from "zod";

export const TICKET_VERSION = "email_ticket.v1";
export const DRAFT_VERSION = "email_draft.v1";

export const EmailTicketSchema = z.object({
  ticket_id: z.string().min(1),
  raw: z.string(),
  type: z.enum(["nurture", "launch"]),
  goal: z.string(),
  audience: z.string(),
  offer: z.string(),
  cta_label: z.string(),
  cta_href: z.string(),
  must_include: z.array(z.string()),
  must_avoid: z.array(z.string()),
  // Empty string means "unknown"; the unknown itself must be in needs_input.
  deadline: z.string(),
  confidence: z.number().min(0).max(1),
  needs_input: z.array(z.string()),
});
export type EmailTicket = z.infer<typeof EmailTicketSchema>;

export const ViolationSchema = z.object({
  rule_id: z.string(),
  severity: z.enum(["block", "escalate", "warn"]),
  policy_class: z.enum(["structural", "synthetic_poc_policy"]),
  message: z.string(),
  span: z.string().optional(),
});
export type Violation = z.infer<typeof ViolationSchema>;

export const LintReportSchema = z.object({
  status: z.enum(["pass", "warn", "escalate", "fail"]),
  violations: z.array(ViolationSchema),
});
export type LintReport = z.infer<typeof LintReportSchema>;

export const DraftBlockSchema = z.object({
  kind: z.enum(["hero", "body", "proof", "cta", "footer"]),
  text: z.string(),
  html: z.string(),
});
export type DraftBlock = z.infer<typeof DraftBlockSchema>;

export const EmailDraftSchema = z.object({
  ticket_id: z.string().min(1),
  type: z.enum(["nurture", "launch"]),
  subject: z.string(),
  preheader: z.string(),
  from_name: z.string(),
  from_email: z.string(),
  blocks: z.array(DraftBlockSchema),
  cta: z.object({
    label: z.string(),
    href: z.string(),
    role: z.enum(["primary", "secondary"]),
  }),
  needs_input: z.array(z.string()),
  citations: z.array(z.object({ claim_id: z.string(), span: z.string() })),
  lint: LintReportSchema,
});
export type EmailDraft = z.infer<typeof EmailDraftSchema>;

// What the model hands back: a draft before the application attaches the
// footer and lint report. Keeping this as a distinct type is the boundary,
// the model's output type literally cannot carry a lint verdict or footer.
export const ModelDraftSchema = EmailDraftSchema.omit({ lint: true });
export type ModelDraft = z.infer<typeof ModelDraftSchema>;

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: string[] };

function toResult<T>(parsed: z.ZodSafeParseResult<T>): ValidationResult<T> {
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map(
      (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
    ),
  };
}

export function validateTicketShape(x: unknown): ValidationResult<EmailTicket> {
  return toResult(EmailTicketSchema.safeParse(x));
}

export function validateDraftShape(x: unknown): ValidationResult<ModelDraft> {
  return toResult(ModelDraftSchema.safeParse(x));
}
