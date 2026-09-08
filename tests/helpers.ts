// Shared test fixtures. One canonical on-brand draft; tests mutate copies to
// break exactly one rule at a time so every assertion isolates one behavior.
import { retrieveContext, type BrandContext } from "../src/steps/retrieveContext.js";
import type { EmailTicket, ModelDraft } from "../src/steps/schema.js";

export const brand: BrandContext = retrieveContext("brand");

export const CLAIM = {
  id: "claim.design_systems",
  text: "Northwind is built for organization-wide design systems",
};

export function cleanTicket(overrides: Partial<EmailTicket> = {}): EmailTicket {
  return {
    ticket_id: "t-clean-001",
    raw: "type: nurture ...",
    type: "nurture",
    goal: "Help design leads roll out a shared design system",
    audience: "design system leads at mid-size product teams",
    offer: "a guided walkthrough of the Northwind design system workspace",
    cta_label: "See the walkthrough",
    cta_href: "https://www.northwindstudio.example/walkthrough",
    must_include: [CLAIM.text],
    must_avoid: ["pricing talk"],
    deadline: "2026-09-16",
    confidence: 0.9,
    needs_input: [],
    ...overrides,
  };
}

// A model-shaped draft (no footer, no lint) that satisfies every brand rule
// once the footer is attached. The greeting exercises the Liquid allowlist's
// happy path on purpose.
export function cleanDraft(overrides: Partial<ModelDraft> = {}): ModelDraft {
  const bodyText =
    "{% if customer.first_name %}Hi {{ customer.first_name }},{% else %}Hi there,{% endif %} " +
    `rolling out a design system is coordination work. ${CLAIM.text}. ` +
    "We put together a guided walkthrough of the workspace for design system leads.";
  return {
    ticket_id: "t-clean-001",
    type: "nurture",
    subject: "A guided walkthrough for your design system rollout",
    preheader: "See how teams run a shared design system in Northwind.",
    from_name: brand.from.from_name,
    from_email: brand.from.from_email,
    blocks: [
      {
        kind: "hero",
        text: "Roll out a design system your whole org can use",
        html: "<h1>Roll out a design system your whole org can use</h1>",
      },
      { kind: "body", text: bodyText, html: `<p>${bodyText}</p>` },
      {
        kind: "cta",
        text: "See the walkthrough",
        html: '<a href="https://www.northwindstudio.example/walkthrough" style="background:#1F6FEB;color:#fff;">See the walkthrough</a>',
      },
    ],
    cta: {
      label: "See the walkthrough",
      href: "https://www.northwindstudio.example/walkthrough",
      role: "primary",
    },
    needs_input: [],
    citations: [{ claim_id: CLAIM.id, span: CLAIM.text }],
    ...overrides,
  };
}

// Append text to the body block of a copy of the draft — the standard way
// tests inject exactly one policy problem.
export function withBodyText(draft: ModelDraft, extra: string): ModelDraft {
  return {
    ...draft,
    blocks: draft.blocks.map((b) =>
      b.kind === "body"
        ? { ...b, text: `${b.text} ${extra}`, html: `<p>${b.text} ${extra}</p>` }
        : b,
    ),
  };
}
