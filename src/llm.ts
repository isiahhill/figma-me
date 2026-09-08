// Provider adapter: mock | anthropic.
//
// mock is the default and the only thing tests and `npm run demo` ever use,
// it is a deterministic, rule-based stand-in for the model so the whole
// pipeline runs offline and byte-identically. The point of this POC is the
// production layer AROUND generation, so a boring generator is a feature:
// every eval failure is a policy-layer bug, never model variance.
//
// anthropic exists for a live recording. It activates only when
// ANTHROPIC_API_KEY is set, is never used in CI, and its output still goes
// through the same schema validation, lint, and gate as the mock, the
// pipeline trusts no provider.
import { readFileSync } from "node:fs";
import {
  validateDraftShape,
  type EmailTicket,
  type LintReport,
  type ModelDraft,
  type Violation,
} from "./steps/schema.js";
import type { Brief } from "./steps/parseTicket.js";

export type LlmTask = "intake" | "draft" | "rewrite" | "review";

export interface LLM {
  provider: "mock" | "anthropic";
  complete(task: LlmTask, input: unknown): Promise<unknown>;
}

export function getLLM(provider = process.env.PROVIDER ?? "mock"): LLM {
  if (provider === "anthropic") return anthropicLLM();
  return { provider: "mock", complete: async (task, input) => mockComplete(task, input) };
}

// ---------------------------------------------------------------------------
// Mock provider: deterministic "model behavior" in plain TypeScript.
// ---------------------------------------------------------------------------

interface DraftInput {
  ticket: EmailTicket;
  claims: { id: string; text: string }[];
  from: { from_name: string; from_email: string };
}

function mockComplete(task: LlmTask, input: unknown): unknown {
  switch (task) {
    case "intake":
      return mockIntake(input as Brief);
    case "draft":
      return mockDraft(input as DraftInput);
    case "review":
      return mockReview(input as { ticket: EmailTicket; draft: ModelDraft; lint: LintReport });
    case "rewrite":
      return mockRewrite(input as { violations: Violation[] });
  }
}

const CORE_FIELDS = ["goal", "audience", "offer", "cta", "link", "deadline"] as const;

function mockIntake(brief: Brief): EmailTicket {
  // Labeled "key: value" lines are explicit fields. Everything else is prose
  // we only mine with narrow heuristics, a gap becomes a needs_input
  // question, never a guess. Instruction-like text lands in fields as inert
  // data; there is nothing here that executes content.
  const fields = new Map<string, string[]>();
  for (const line of brief.raw.split("\n")) {
    const m = /^(type|goal|audience|offer|cta|link|deadline|include|avoid):\s*(.+)$/.exec(
      line.trim(),
    );
    if (m) {
      const list = fields.get(m[1]!) ?? [];
      list.push(m[2]!.trim());
      fields.set(m[1]!, list);
    }
  }
  const first = (k: string) => fields.get(k)?.[0] ?? "";

  const needs_input: string[] = [];

  // A brief written in another language is not something to extract copy
  // from. This brand sends English, and mining Spanish field values into the
  // English template would hand a reviewer half-translated copy they may not
  // be able to read. So the text fields stay empty, one question asks for the
  // target language, and the language-neutral fields (type, link, deadline)
  // still come through. Nothing else in this function runs the "missing X"
  // loop in that case: the fields are not missing, they are unconfirmed.
  const foreign = detectNonEnglish(brief.raw);
  const text = (k: string) => (foreign ? "" : first(k));
  if (foreign) {
    needs_input.push(
      `brief appears to be written in ${foreign}: ask the requester for the target language before drafting`,
    );
  }

  let audience = text("audience");
  if (!audience && !foreign) {
    // One narrow heuristic: "to designers/engineers/..." in prose.
    const m = /\bto\s+(designers|engineers|developers|customers|admins)\b/i.exec(brief.raw);
    if (m) audience = m[1]!.toLowerCase();
  }

  if (!foreign) {
    for (const key of CORE_FIELDS) {
      if (key === "audience") continue;
      if (!first(key)) needs_input.push(`missing ${key === "link" ? "cta link" : key}: ask the requester`);
    }
    if (!audience) needs_input.push("missing audience: ask the requester");
    if (!first("deadline") && /\b(next week|tomorrow|soon|asap)\b/i.test(brief.raw)) {
      // The relative date is already counted as a missing deadline above; this
      // sharpens the question with what the requester actually said.
      const idx = needs_input.findIndex((n) => n.startsWith("missing deadline"));
      if (idx >= 0) needs_input[idx] = "deadline is relative ('next week'), so ask for a date";
    }
  }

  // Two labeled deadlines that disagree are a conflict, not a choice for
  // intake to make on the requester's behalf. Both dates go into the question
  // so a one-word reply settles it, and the ticket's deadline stays "", the
  // schema's spelling of "unknown", so nothing downstream can date a run off
  // a guess. A repeated identical deadline is just emphasis and collapses.
  const deadlines = [...new Set(fields.get("deadline") ?? [])];
  if (deadlines.length > 1) {
    needs_input.push(
      `conflicting deadlines in the brief (${deadlines.join(" vs ")}): ask the requester which one stands`,
    );
  }
  const deadline = deadlines.length === 1 ? deadlines[0]! : "";

  // Uncleared quantitative claims in PROSE are quarantined into needs_input
  // and never mined into ticket fields. Labeled "include:" lines are
  // different: they flow into must_include verbatim (the requester explicitly
  // asked for them), and the LINT layer is what stops uncleared numbers
  // arriving that way - the break demo depends on exactly that backstop.
  const claimMatch = /\b\d+(?:\.\d+)?\s*(?:%|percent|x)\s*(?:faster|more|better|less|quicker)?/i.exec(
    brief.raw,
  );
  if (claimMatch) {
    needs_input.push(
      `uncleared claim "${claimMatch[0].trim()}" is not in the approved claims library. Get it approved or drop it.`,
    );
  }

  const confidence = Math.max(0.2, Math.round((0.9 - 0.15 * needs_input.length) * 100) / 100);

  return {
    ticket_id: brief.ticket_id,
    raw: brief.raw,
    type: first("type") === "launch" ? "launch" : "nurture",
    goal: text("goal"),
    audience,
    offer: text("offer"),
    cta_label: text("cta"),
    cta_href: first("link"),
    must_include: foreign ? [] : (fields.get("include") ?? []),
    must_avoid: foreign ? [] : (fields.get("avoid") ?? []),
    deadline,
    confidence,
    needs_input,
  };
}

// Stopword vote for the handful of languages a brief here could plausibly
// arrive in. Deterministic and offline like the rest of the mock, a live
// model would simply say what language it read. The threshold is three hits
// AND more than the English count, so an English brief that name-drops
// "Los Angeles" or "de facto" scores one or two and stays English. Labels
// like "type:" and URLs are English tokens and count toward that side, which
// is fine: a brief has to be substantially foreign to flip.
const FOREIGN_STOPWORDS: Record<string, string[]> = {
  Spanish: ["el", "la", "los", "las", "de", "del", "un", "una", "para", "por", "con", "que", "es", "en", "y"],
  German: ["der", "die", "das", "und", "für", "mit", "ist", "ein", "eine", "nicht", "auf", "zu"],
  French: ["le", "les", "des", "et", "pour", "avec", "est", "une", "dans", "sur", "du"],
  Portuguese: ["o", "os", "as", "um", "uma", "para", "com", "que", "não", "em", "do", "da"],
};
const ENGLISH_STOPWORDS = ["the", "and", "for", "with", "our", "your", "to", "of", "is", "in", "on", "at", "a", "an"];

function detectNonEnglish(raw: string): string | null {
  const tokens = raw.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
  const count = (set: string[]) => tokens.filter((t) => set.includes(t)).length;
  const english = count(ENGLISH_STOPWORDS);
  let best: { lang: string; hits: number } | null = null;
  for (const [lang, set] of Object.entries(FOREIGN_STOPWORDS)) {
    const hits = count(set);
    if (hits >= 3 && hits > english && (!best || hits > best.hits)) best = { lang, hits };
  }
  return best?.lang ?? null;
}

function sentenceCase(s: string): string {
  return s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : s;
}

// Interpolating brief-derived strings into html unescaped was the review's
// P0: markup in a goal or cta_label rode straight into the preview and the
// payload. Text fields stay raw (the lint layer scans them); anything that
// lands inside html gets entity-escaped, and attribute values additionally
// cannot break out of their quotes.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function mockDraft({ ticket, claims, from }: DraftInput): ModelDraft {
  // The mock generator is deliberately obedient: it writes from ticket fields
  // and must_include verbatim. When a requester asks for something off-brand,
  // the draft CONTAINS it and the lint layer catches it, proving enforcement
  // lives in code, not in generator goodwill.
  const parts: string[] = [
    "{% if customer.first_name %}Hi {{ customer.first_name }},{% else %}Hi there,{% endif %}",
  ];
  if (ticket.offer) parts.push(`We put together ${ticket.offer}.`);
  for (const item of ticket.must_include) parts.push(`${sentenceCase(item)}.`);
  const bodyText = parts.join(" ");

  // Cite every approved claim that ended up in the copy, verbatim spans only.
  const citations = claims
    .filter((c) => bodyText.includes(c.text))
    .map((c) => ({ claim_id: c.id, span: c.text }));

  const heroText = sentenceCase(ticket.goal) || "An update from Northwind Studio";
  const subject = heroText.slice(0, 78);

  const blocks: ModelDraft["blocks"] = [
    { kind: "hero", text: heroText, html: `<h1 style="font-size:24px;line-height:32px;margin:0;">${escapeHtml(heroText)}</h1>` },
    { kind: "body", text: bodyText, html: `<p style="font-size:15px;line-height:24px;">${escapeHtml(bodyText)}</p>` },
  ];
  if (ticket.cta_label && ticket.cta_href) {
    blocks.push({
      kind: "cta",
      text: ticket.cta_label,
      html: `<a href="${escapeAttr(ticket.cta_href)}" style="display:inline-block;background:#1F6FEB;color:#ffffff;padding:12px 20px;border-radius:6px;text-decoration:none;">${escapeHtml(ticket.cta_label)}</a>`,
    });
  }

  return {
    ticket_id: ticket.ticket_id,
    type: ticket.type,
    subject,
    preheader: ticket.offer ? `${sentenceCase(ticket.offer)}.` : "Details inside.",
    from_name: from.from_name,
    from_email: from.from_email,
    blocks,
    cta: {
      label: ticket.cta_label,
      href: ticket.cta_href,
      role: "primary",
    },
    needs_input: [...ticket.needs_input],
    citations,
  };
}

function mockReview({
  ticket,
  draft,
  lint,
}: {
  ticket: EmailTicket;
  draft: ModelDraft;
  lint: LintReport;
}): { score: number; notes: string } {
  const count = (sev: Violation["severity"]) =>
    lint.violations.filter((v) => v.severity === sev).length;
  let score = 0.95;
  score -= 0.05 * count("warn");
  score -= 0.2 * count("escalate");
  score -= 0.4 * count("block");
  if (ticket.needs_input.length > 0) score -= 0.15;
  const hasBody = draft.blocks.some((b) => b.kind === "body" && b.text.length > 0);
  if (hasBody && draft.citations.length === 0) score -= 0.1;
  score = Math.max(0, Math.min(1, Math.round(score * 100) / 100));
  const notes =
    lint.violations.length === 0
      ? "On-ticket, cited, and inside brand policy."
      : `Flagged: ${lint.violations.map((v) => v.rule_id).join(", ")}.`;
  return { score, notes };
}

function mockRewrite({ violations }: { violations: Violation[] }): {
  spans: { original: string; replacement: string }[];
} {
  // One constrained proposal per flagged span: remove the offending language.
  // Removal can never introduce a new fact, which keeps the rewrite inside
  // the agent's permissions by construction.
  return {
    spans: violations
      .filter((v) => v.severity !== "block" && v.span)
      .map((v) => ({ original: v.span!, replacement: "" })),
  };
}

// ---------------------------------------------------------------------------
// Anthropic provider: a live model for a demo recording, never for CI.
// ---------------------------------------------------------------------------

const PROMPT_FILES: Record<LlmTask, string> = {
  intake: "prompts/intake.v1.md",
  draft: "prompts/draft.v1.md",
  rewrite: "prompts/rewrite-spans.v1.md",
  review: "prompts/reviewer.v1.md",
};

function anthropicLLM(): LLM {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "PROVIDER=anthropic requires ANTHROPIC_API_KEY. Use the default PROVIDER=mock for offline runs.",
    );
  }
  return {
    provider: "anthropic",
    async complete(task, input) {
      // Lazy import so the SDK never loads in mock runs.
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const client = new Anthropic();
      const system = readFileSync(PROMPT_FILES[task], "utf8");
      const message = await client.messages.create({
        model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5",
        max_tokens: 2048,
        system,
        messages: [{ role: "user", content: JSON.stringify(input) }],
      });
      const text = message.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("");
      // The prompts demand bare JSON; strip a fence if the model added one.
      const parsed: unknown = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
      // A live model's draft gets the same schema check the mock's does,
      // malformed output fails here instead of flowing downstream.
      if (task === "draft") {
        const check = validateDraftShape(parsed);
        if (!check.ok) {
          throw new Error(`anthropic draft failed email_draft.v1: ${check.issues.join("; ")}`);
        }
      }
      return parsed;
    },
  };
}
