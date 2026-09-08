// Deterministic brand lint. This is the enforcement half of the architecture:
// the model decides what to say, this file decides whether it can move
// forward. Every check reads its severity and policy_class from
// brand/rules.v1.yaml, so policy changes are YAML edits reviewed by
// marketers, not code changes.
//
// Scanning scope gotcha: the locked footer is chrome, not copy. Its address
// digits would trip CLAIM_NUMBER and its brand name would confuse
// NAMED_CUSTOMER, so copy-level rules scan everything EXCEPT footer blocks.
// Structural rules (unsub, address, links) do inspect the footer.
import {
  validateDraftShape,
  type EmailDraft,
  type LintReport,
  type ModelDraft,
  type Violation,
} from "./schema.js";
import type { BrandContext, BrandRule } from "./retrieveContext.js";

export type LintableDraft = ModelDraft | EmailDraft;

// Aggressive normalization before any copy-policy matching. NFKC folds
// fullwidth digits and compatibility forms, zero-width characters are
// stripped, dash variants and NBSP collapse to ASCII. This is deliberately
// NOT length-preserving — an earlier version was, and the review showed the
// price: a zero-width space inside "game-changing" walked straight past a
// block-severity rule. Spans are therefore reported from the NORMALIZED
// text; consumers (preview highlight) already tolerate a span that no
// longer appears verbatim in the original.
export function normalizePhraseText(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[​-‍﻿­]/g, "")
    .replace(/[‐-―−]/g, "-")
    .replace(/ /g, " ")
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"');
}

function phraseRegex(phrase: string): RegExp {
  // Escape, then let whitespace inside a phrase match any run of whitespace.
  // \b anchors keep "sale" from firing inside "wholesale".
  const escaped = phrase
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  return new RegExp(`\\b${escaped}\\b`, "g");
}

export function matchForbidden(
  text: string,
  phrases: string[],
): { phrase: string; span: string }[] {
  const normalized = normalizePhraseText(text);
  const hits: { phrase: string; span: string; start: number; end: number }[] = [];
  // Longest phrase first: "lowest price" must claim its range before a bare
  // "price" entry can, so a span is only ever reported once, as the most
  // specific phrase that covers it.
  const ordered = [...phrases].sort((a, b) => b.length - a.length);
  for (const phrase of ordered) {
    const re = phraseRegex(normalizePhraseText(phrase));
    for (const m of normalized.matchAll(re)) {
      const start = m.index;
      const end = start + m[0].length;
      if (hits.some((h) => start < h.end && end > h.start)) continue;
      // Span comes from the normalized text: normalization is lossy, so
      // original-byte offsets no longer line up (see normalizePhraseText).
      hits.push({ phrase, span: normalized.slice(start, end), start, end });
    }
  }
  hits.sort((a, b) => a.start - b.start);
  return hits.map(({ phrase, span }) => ({ phrase, span }));
}

// Strip tags to get the text a reader actually receives from a block's html.
// Copy rules must scan this too: the payload ships block.html, and a draft
// whose html diverges from its text was the review's favorite bypass.
function htmlToText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface RuleParams {
  min?: number;
  max?: number;
  phrases?: string[];
  patterns?: string[];
  terms?: string[];
  allowed_hosts?: string[];
  allowed_vars?: string[];
}

export function lintEmail(draft: LintableDraft, brand: BrandContext): LintReport {
  const violations: Violation[] = [];
  const ruleById = new Map(brand.rules.map((r) => [r.id, r]));

  // A rule absent from rules.v1.yaml simply does not run — removing a rule
  // from the YAML is the sanctioned way to disable a check.
  function add(ruleId: string, message: string, span?: string): void {
    const rule = ruleById.get(ruleId) as BrandRule | undefined;
    if (!rule) return;
    violations.push({
      rule_id: rule.id,
      severity: rule.severity,
      policy_class: rule.policy_class,
      message,
      ...(span !== undefined ? { span } : {}),
    });
  }
  function params(ruleId: string): RuleParams {
    return ((ruleById.get(ruleId)?.params ?? {}) as RuleParams);
  }

  const blocks = draft.blocks;
  const footerBlocks = blocks.filter((b) => b.kind === "footer");
  const copyBlocks = blocks.filter((b) => b.kind !== "footer");
  // Copy = everything the model wrote, from BOTH representations: block.text
  // AND the text a reader gets out of block.html. The payload ships html, so
  // linting text alone would police a different artifact than the one that
  // goes out the door.
  const copyText = [
    draft.subject,
    draft.preheader,
    ...copyBlocks.map((b) => b.text),
    ...copyBlocks.map((b) => htmlToText(b.html)),
  ].join("\n");
  const allHtml = blocks.map((b) => b.html).join("\n");

  // OUTPUT_SCHEMA — validate the model-shaped part of the draft.
  const { lint: _ignored, ...modelShaped } = draft as EmailDraft;
  const shape = validateDraftShape(modelShaped);
  if (!shape.ok) {
    add("OUTPUT_SCHEMA", `draft does not validate: ${shape.issues.join("; ")}`);
  }

  // CAN_UNSUB / CAN_ADDRESS — the locked footer must be present and intact.
  const footerHtml = footerBlocks.map((b) => b.html).join("\n");
  if (!/href="https:\/\/[^"]*unsubscribe[^"]*"/i.test(footerHtml)) {
    add("CAN_UNSUB", "no https unsubscribe link found in a footer block");
  }
  // Postal-address heuristic: "..., ST 12345" — deterministic and
  // brand-agnostic, so swapping the footer chrome does not require code edits.
  if (!/,\s*[A-Z]{2}\s+\d{5}/.test(footerBlocks.map((b) => b.text + b.html).join("\n"))) {
    add("CAN_ADDRESS", "no postal address found in a footer block");
  }

  // CAN_SENDER
  if (
    draft.from_name !== brand.from.from_name ||
    draft.from_email !== brand.from.from_email
  ) {
    add(
      "CAN_SENDER",
      `sender must be ${brand.from.from_name} <${brand.from.from_email}>, got ${draft.from_name} <${draft.from_email}>`,
    );
  }

  // LINK_HTTPS — every href in every block (double- or single-quoted, any
  // attribute casing), plus the CTA target itself. An EMPTY href is a missing
  // CTA, which is CTA_COUNT/CTA_DOMAIN territory; flagging "" as a non-https
  // link would just be noise.
  const hrefs = [...allHtml.matchAll(/href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map(
    (m) => (m[1] ?? m[2])!,
  );
  for (const href of [...hrefs, draft.cta.href]) {
    if (href.length > 0 && !href.startsWith("https://")) {
      add("LINK_HTTPS", `non-https link: ${href}`, href);
    }
  }

  // HTML_SAFETY — the html a block carries must be inert markup. Script
  // elements, inline event handlers, and executable URI schemes have no
  // legitimate place in an email body, and the preview renders this html on
  // the reviewer's machine.
  for (const pattern of [/<script\b/i, /\bon\w+\s*=/i, /javascript:/i, /data:text\/html/i]) {
    const m = pattern.exec(allHtml);
    if (m) {
      add("HTML_SAFETY", `executable content in block html: "${m[0]}"`, m[0]);
    }
  }

  // LIQUID_UNRESOLVED — allowlisted tokens only; first_name needs its
  // if/else wrap so an empty attribute never renders "Hi ,".
  const allowedVars = params("LIQUID_UNRESOLVED").allowed_vars ?? [];
  const liquidSource = [draft.subject, draft.preheader, ...blocks.map((b) => b.text + "\n" + b.html)].join("\n");
  for (const m of liquidSource.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)) {
    if (!allowedVars.includes(m[1]!)) {
      add("LIQUID_UNRESOLVED", `liquid variable not allowlisted: ${m[0]}`, m[0]);
    }
  }
  for (const m of liquidSource.matchAll(/\{%\s*([^%]*?)\s*%\}/g)) {
    if (!/^(if customer\.first_name|else|endif)$/.test(m[1]!)) {
      add("LIQUID_UNRESOLVED", `liquid tag not allowlisted: ${m[0]}`, m[0]);
    }
  }
  if (
    /\{\{\s*customer\.first_name\s*\}\}/.test(liquidSource) &&
    !/\{%\s*if customer\.first_name\s*%\}/.test(liquidSource)
  ) {
    add(
      "LIQUID_UNRESOLVED",
      "customer.first_name used without an if/else wrap",
      "{{ customer.first_name }}",
    );
  }

  // NO_FABRICATED_FALLBACK — citations must point at real claims whose cited
  // span actually appears; and any verbatim approved claim in copy must be
  // cited. Facts without provenance do not pass, in either direction.
  const claimById = new Map(brand.claims.map((c) => [c.id, c]));
  for (const citation of draft.citations) {
    const claim = claimById.get(citation.claim_id);
    if (!claim) {
      add("NO_FABRICATED_FALLBACK", `citation references unknown claim: ${citation.claim_id}`);
      continue;
    }
    if (!copyText.includes(citation.span)) {
      add(
        "NO_FABRICATED_FALLBACK",
        `cited span for ${citation.claim_id} does not appear in the draft`,
        citation.span,
      );
    }
  }
  for (const claim of brand.claims) {
    if (
      copyText.includes(claim.text) &&
      !draft.citations.some((c) => c.claim_id === claim.id)
    ) {
      add("NO_FABRICATED_FALLBACK", `approved claim used without citation: ${claim.id}`, claim.text);
    }
  }

  // SUBJECT_LEN — synthetic POC bound, not vendor policy (see rules.v1.yaml).
  const { min = 8, max = 78 } = params("SUBJECT_LEN");
  if (draft.subject.length < min || draft.subject.length > max) {
    add(
      "SUBJECT_LEN",
      `subject is ${draft.subject.length} chars, outside the synthetic ${min}-${max} window`,
      draft.subject,
    );
  }

  // CTA_COUNT — exactly one primary CTA.
  const ctaBlocks = blocks.filter((b) => b.kind === "cta");
  if (ctaBlocks.length !== 1) {
    add("CTA_COUNT", `expected exactly one cta block, found ${ctaBlocks.length}`);
  }
  if (draft.cta.role !== "primary") {
    add("CTA_COUNT", `the email's cta must be primary, got ${draft.cta.role}`);
  }

  // CTA_DOMAIN — every link target in the email must sit on an approved
  // brand host, not just the declared cta.href: the payload ships whatever
  // anchors the html carries, so checking only the metadata field would
  // police a decoy. The cta block's own anchor must also agree with
  // cta.href — a mismatch means the button does not go where the reviewer
  // was told it goes.
  const allowedHosts = params("CTA_DOMAIN").allowed_hosts ?? [];
  function checkHost(href: string, label: string): void {
    try {
      const host = new URL(href).host;
      if (!allowedHosts.includes(host)) {
        add("CTA_DOMAIN", `${label} host ${host} is not an approved brand host`, href);
      }
    } catch {
      add("CTA_DOMAIN", `${label} is not a valid URL: ${href}`, href);
    }
  }
  checkHost(draft.cta.href, "cta");
  for (const href of hrefs) {
    if (href.length > 0) checkHost(href, "link");
  }
  const ctaAnchor = /href\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(
    blocks.filter((b) => b.kind === "cta").map((b) => b.html).join("\n"),
  );
  const ctaAnchorHref = ctaAnchor ? (ctaAnchor[1] ?? ctaAnchor[2])! : null;
  if (ctaAnchorHref !== null && ctaAnchorHref !== draft.cta.href) {
    add(
      "CTA_DOMAIN",
      `cta block anchor (${ctaAnchorHref}) does not match cta.href (${draft.cta.href})`,
      ctaAnchorHref,
    );
  }

  // FORBIDDEN_PHRASE
  for (const hit of matchForbidden(copyText, params("FORBIDDEN_PHRASE").phrases ?? [])) {
    add("FORBIDDEN_PHRASE", `forbidden phrase: "${hit.phrase}"`, hit.span);
  }

  // LEGAL_TERM — regulatory / legal-exposure vocabulary. Same whole-word
  // matcher as FORBIDDEN_PHRASE (so the unicode-evasion hardening carries
  // over for free), but the YAML says escalate, not block: counsel may have
  // approved this exact wording, and a human with that context decides.
  for (const hit of matchForbidden(copyText, params("LEGAL_TERM").terms ?? [])) {
    add("LEGAL_TERM", `legal-sensitive term needs counsel sign-off: "${hit.phrase}"`, hit.span);
  }

  // CLAIM_NUMBER — digits attached to %, percent, x-multipliers, or currency,
  // matched on NORMALIZED copy so fullwidth digits and unicode variants fold
  // to ASCII first. Approved claims contain no digits (a guard test pins
  // that), so any hit is uncited by definition.
  const normalizedCopy = normalizePhraseText(copyText);
  const numberedSpans: string[] = [];
  for (const m of normalizedCopy.matchAll(
    /(?:\$\s?\d[\d,.]*|\b\d+(?:\.\d+)?\s*(?:%|percent(?:age)?\b|x\b|×))/gi,
  )) {
    numberedSpans.push(m[0]);
    add("CLAIM_NUMBER", `numeric claim without an approved source: "${m[0]}"`, m[0]);
  }

  // CLAIM_BARE_NUMBER — any remaining digit-run in copy ("served 1,000
  // teams", "since 2018"). Bare counts read as facts but cite nothing, so
  // they escalate to a human instead of blocking outright: a reviewer may
  // have evidence, the model may not assert numbers alone. Footer chrome is
  // excluded with the rest of the copy scan.
  for (const m of normalizedCopy.matchAll(/\b\d[\d,]*(?:\.\d+)?\b/g)) {
    if (numberedSpans.some((s) => s.includes(m[0]))) continue;
    add("CLAIM_BARE_NUMBER", `uncited number in copy: "${m[0]}"`, m[0]);
  }

  // CLAIM_IMPLIED — quantitative implication without a number. Escalates so a
  // human with evidence can approve what the model may not assert alone.
  for (const pattern of params("CLAIM_IMPLIED").patterns ?? []) {
    if (normalizedCopy.includes(normalizePhraseText(pattern))) {
      add("CLAIM_IMPLIED", `implied quantitative claim: "${pattern}"`, pattern);
    }
  }

  // NAMED_CUSTOMER — org-name heuristic (capitalized words + corporate
  // suffix). Clearing is EXACT match only: "Fake Harbor Bank" containing a
  // cleared reference is not itself cleared, and no prefix exemption exists
  // for the brand's own name ("Northwind Acme Corp" is not ours to clear).
  for (const m of copyText.matchAll(
    /\b([A-Z][A-Za-z]*(?:\s+[A-Z][A-Za-z]*)?\s+(?:Corp|Corporation|Inc|Bank|Health|Freight|Labs|Systems|Group))\b/g,
  )) {
    const name = m[1]!.trim();
    const cleared =
      brand.cleared_references.some((ref) => name === ref) ||
      name === brand.from.from_name;
    if (!cleared) {
      add("NAMED_CUSTOMER", `customer reference not cleared by legal: "${name}"`, name);
    }
  }

  // One finding per (rule, span): the same bad URL scanned from block html
  // and from cta.href is one problem, not two.
  const seen = new Set<string>();
  const deduped = violations.filter((v) => {
    const key = `${v.rule_id} ${v.span ?? v.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  violations.length = 0;
  violations.push(...deduped);

  const status: LintReport["status"] = violations.some((v) => v.severity === "block")
    ? "fail"
    : violations.some((v) => v.severity === "escalate")
      ? "escalate"
      : violations.some((v) => v.severity === "warn")
        ? "warn"
        : "pass";

  return { status, violations };
}
