// Reviewer-facing preview: the email exactly as it would render (600px
// table, locked footer) beside a rail of lint violations. The rail shows
// policy_class on every row so a reviewer can tell a structural invariant
// from a synthetic POC threshold at a glance — that distinction is the
// difference between "never ship this" and "we chose this bound, argue with
// the YAML".
import type { EmailDraft, Violation } from "./schema.js";
import type { GateStatus } from "./hitlGate.js";
import { emailHtml } from "./cioPayload.js";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Wrap the first occurrence of each violation span in <mark>. Spans come
// from draft text; they normally appear verbatim in the html too. A span
// that does not (e.g. schema-level violations with no span) just gets no
// highlight — the rail still lists it.
function highlight(html: string, violations: Violation[]): string {
  // Mark spans in TEXT segments only. Splitting on tag boundaries keeps a
  // <mark> from landing inside an attribute value - a URL-span violation
  // used to corrupt the anchor it was pointing at. A span that only occurs
  // inside markup (e.g. an offending href) simply gets no highlight; the
  // rail still lists it.
  const segments = html.split(/(<[^>]+>)/);
  const marked = new Set<string>();
  for (const v of violations) {
    if (!v.span || marked.has(v.span)) continue;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      if (seg.startsWith("<")) continue;
      const idx = seg.indexOf(v.span);
      if (idx === -1) continue;
      segments[i] =
        seg.slice(0, idx) +
        `<mark style="background:#fef08a;">${v.span}</mark>` +
        seg.slice(idx + v.span.length);
      marked.add(v.span);
      break;
    }
  }
  return segments.join("");
}

const GATE_COLORS: Record<GateStatus, string> = {
  ready_for_cio: "#166534",
  review: "#92400e",
  blocked: "#991b1b",
};

export function renderPreview(draft: EmailDraft, gate: GateStatus): string {
  const violations = draft.lint.violations;
  const emailPane = highlight(emailHtml(draft), violations);
  const rows =
    violations.length === 0
      ? '<p style="color:#166534;">No violations.</p>'
      : violations
          .map(
            (v) => `
      <div style="border-left:3px solid ${v.severity === "block" ? "#991b1b" : v.severity === "escalate" ? "#92400e" : "#a16207"};padding:8px 12px;margin:0 0 10px;background:#fff;">
        <strong>${escapeHtml(v.rule_id)}</strong>
        <span style="font-size:11px;color:#6b7280;"> · ${v.severity} · ${v.policy_class}</span>
        <div style="font-size:13px;color:#374151;">${escapeHtml(v.message)}</div>
      </div>`,
          )
          .join("\n");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Preview · ${escapeHtml(draft.ticket_id)}</title>
</head>
<body style="margin:0;font-family:Helvetica,Arial,sans-serif;background:#f3f4f6;">
  <div style="padding:16px 24px;background:#111827;color:#fff;">
    <strong>${escapeHtml(draft.subject)}</strong>
    <span style="margin-left:16px;padding:2px 10px;border-radius:99px;background:${GATE_COLORS[gate]};font-size:12px;">${gate}</span>
    <div style="font-size:12px;color:#9ca3af;">${escapeHtml(draft.from_name)} &lt;${escapeHtml(draft.from_email)}&gt; · preheader: ${escapeHtml(draft.preheader)}</div>
  </div>
  <div style="display:flex;gap:24px;align-items:flex-start;padding:24px;">
    <div style="flex:0 0 auto;background:#fff;border:1px solid #e5e7eb;">
${emailPane}
    </div>
    <aside style="flex:1;min-width:260px;">
      <h2 style="font-size:14px;text-transform:uppercase;letter-spacing:0.05em;color:#6b7280;">Lint — ${draft.lint.status}</h2>
${rows}
    </aside>
  </div>
</body>
</html>
`;
}
