// Records the human decision on a run. This file is the entire "approval
// API": two verbs, written into decision.json next to the artifacts the
// reviewer looked at. There is deliberately no third verb, releasing the
// email happens in Customer.io by a human, never here.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emitEvent } from "./emitEvent.js";

export type HumanDecision = "approve" | "request_changes";

// decision.json does not carry the ticket id (it never needed to), so the
// approval event reads it from ticket.json next door. A run dir with no
// ticket.json, a hand-built fixture, an older run, still records the
// decision; the event just says so instead of throwing on a telemetry detail.
function ticketIdFor(runDir: string): string {
  const path = join(runDir, "ticket.json");
  if (!existsSync(path)) return "unknown";
  const ticket = JSON.parse(readFileSync(path, "utf8")) as { ticket_id?: unknown };
  return typeof ticket.ticket_id === "string" ? ticket.ticket_id : "unknown";
}

export function approveDraft(runDir: string, decision: HumanDecision, note: string): void {
  if (decision !== "approve" && decision !== "request_changes") {
    throw new Error(`decision must be approve|request_changes, got "${String(decision)}"`);
  }
  const path = join(runDir, "decision.json");
  const existing = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  writeFileSync(
    path,
    `${JSON.stringify({ ...existing, human_decision: decision, note }, null, 2)}\n`,
  );
  // The note is free text a reviewer typed and belongs in decision.json
  // only; the log line records that a decision happened and which way.
  emitEvent(runDir, {
    stage: "approval",
    ticket_id: ticketIdFor(runDir),
    human_decision: decision,
  });
}

// CLI: node --import tsx src/steps/approve.ts <runDir> approve|request_changes [note]
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split("/").pop()!);
if (invokedDirectly && process.argv[2]) {
  approveDraft(
    process.argv[2],
    process.argv[3] as HumanDecision,
    process.argv[4] ?? "",
  );
  console.log(`recorded ${process.argv[3]} for ${process.argv[2]}`);
}
