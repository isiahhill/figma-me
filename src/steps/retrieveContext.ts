// The only door to brand context. The agent "requests approved context",
// which means this loader and nothing else: rules, claims, voice, chrome.
// There is deliberately no path here to arbitrary files or HTTP; if a draft
// needs a fact this loader can't supply, the answer is needs_input, not a
// wider door.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export interface BrandRule {
  id: string;
  severity: "block" | "escalate" | "warn";
  policy_class: "structural" | "synthetic_poc_policy";
  description: string;
  params?: Record<string, unknown>;
}

export interface BrandContext {
  rules: BrandRule[];
  claims: { id: string; text: string }[];
  cleared_references: string[];
  voice: string;
  footer_html: string;
  from: { from_name: string; from_email: string };
}

export function retrieveContext(brandDir = "brand"): BrandContext {
  const rulesDoc = parseYaml(
    readFileSync(join(brandDir, "rules.v1.yaml"), "utf8"),
  ) as { rules: BrandRule[] };
  const claimsDoc = parseYaml(
    readFileSync(join(brandDir, "claims.v1.yaml"), "utf8"),
  ) as { claims: { id: string; text: string }[]; cleared_references: string[] };
  return {
    rules: rulesDoc.rules,
    claims: claimsDoc.claims,
    cleared_references: claimsDoc.cleared_references,
    voice: readFileSync(join(brandDir, "voice.md"), "utf8"),
    footer_html: readFileSync(join(brandDir, "chrome", "footer.html"), "utf8"),
    from: JSON.parse(
      readFileSync(join(brandDir, "chrome", "from.json"), "utf8"),
    ) as { from_name: string; from_email: string },
  };
}
