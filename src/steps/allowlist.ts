// The only Customer.io surface this pipeline can express. Two guards:
// the allowlist (which SDK methods may be named at all) and the send-surface
// scan (no key anywhere in a payload may smell like send/schedule/trigger).
// The second one exists so that even a future refactor that widens the
// payload type cannot quietly grow a send path — the test suite runs both
// guards over every emitted payload.
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

export function loadAllowlist(path = "cio/allowlist.yaml"): string[] {
  const doc = parseYaml(readFileSync(path, "utf8")) as {
    allowed_sdk_methods: string[];
  };
  return doc.allowed_sdk_methods;
}

export function assertAllowedSdk(sdk: string, allowed: string[]): void {
  if (!allowed.includes(sdk)) {
    throw new Error(
      `sdk method "${sdk}" is not in cio/allowlist.yaml — this pipeline only creates drafts`,
    );
  }
}

const SEND_KEY = /send|schedule|trigger/i;

export function assertNoSendSurface(payload: unknown): void {
  const offenders: string[] = [];
  (function walk(value: unknown, path: string): void {
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, v] of Object.entries(value)) {
        if (SEND_KEY.test(key)) offenders.push(`${path}.${key}`);
        walk(v, `${path}.${key}`);
      }
      return;
    }
    // String VALUES are checked only for the well-known routing fields —
    // body copy may legitimately contain the word "send"; an sdk/method/
    // pattern value never may.
    if (
      typeof value === "string" &&
      /(^|\.)(sdk|method|pattern)$/.test(path) &&
      SEND_KEY.test(value)
    ) {
      offenders.push(`${path}="${value}"`);
    }
  })(payload, "payload");
  if (offenders.length > 0) {
    throw new Error(`send surface detected in payload: ${offenders.join(", ")}`);
  }
}
