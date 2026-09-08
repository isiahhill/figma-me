// Footer attachment is application code on purpose: the model never emits
// chrome. If a draft somehow arrives with its own footer block we drop it and
// attach the locked one — a model-authored footer is exactly the failure
// CAN_UNSUB/CAN_ADDRESS exist to catch.
import type { ModelDraft } from "./schema.js";
import type { BrandContext } from "./retrieveContext.js";

function htmlToText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function attachFooter(draft: ModelDraft, brand: BrandContext): ModelDraft {
  return {
    ...draft,
    blocks: [
      ...draft.blocks.filter((b) => b.kind !== "footer"),
      {
        kind: "footer",
        text: htmlToText(brand.footer_html),
        html: brand.footer_html,
      },
    ],
  };
}
