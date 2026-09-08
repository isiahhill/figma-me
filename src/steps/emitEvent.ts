// Pipeline telemetry: one JSON line per stage, appended to events.jsonl in
// the run directory. This is the instrumentation the measurement plan
// depends on — approval rate, block rate, how many drafts reach handoff —
// and it replaces the modelled hours-saved range with something countable.
//
// The whole design is what an event does NOT carry. Ids and outcomes only:
// never ticket.raw (the requester's Slack message), never block copy, never
// the subject line, never the approval note a human typed. events.jsonl is
// the one artifact that is meant to leave the run folder for a log pipeline,
// and a log pipeline is exactly where a pasted brief would end up searchable
// by everyone. Counts stand in for lists wherever the list would be prose
// (needs_input entries are model-written sentences, so we log how many).
//
// No timestamps, on purpose: run artifacts are byte-identical across reruns
// and the goldens and selfcheck rely on that. When this feeds a real sink the
// sink stamps receipt time; the file stays deterministic.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GateStatus } from "./hitlGate.js";
import type { LintReport } from "./schema.js";

export const EVENTS_FILE = "events.jsonl";

// Stage order in a full run: intake → draft → gate → handoff → approval.
// handoff exists only when a payload was written (gate said ready_for_cio);
// approval only when a human acted through approveDraft.
export type EventStage = "intake" | "draft" | "gate" | "handoff" | "approval";

// Key names deliberately avoid send/schedule/trigger — the selfcheck and the
// payload guard scan artifact keys for those verbs, and a telemetry field
// tripping the no-send-surface check would be a confusing false alarm.
export interface PipelineEvent {
  stage: EventStage;
  ticket_id: string;
  // Channel the brief arrived on ("slack", "request_form"), never a person.
  requester?: string;
  type?: "nurture" | "launch";
  confidence?: number;
  needs_input_count?: number;
  block_count?: number;
  citation_count?: number;
  lint_status?: LintReport["status"];
  gate?: GateStatus;
  violation_ids?: string[];
  reviewer_score?: number;
  sdk?: string;
  human_decision?: "approve" | "request_changes";
}

export type EventSink = (event: PipelineEvent) => void;

// Append-only by construction: appendFileSync means a second process (the
// approval CLI, later) can add its line without re-reading or rewriting what
// the pipeline wrote. One JSON object per line, no pretty-printing, so the
// file is greppable and any JSONL consumer takes it as-is.
export function emitEvent(runDir: string, event: PipelineEvent): void {
  appendFileSync(join(runDir, EVENTS_FILE), `${JSON.stringify(event)}\n`);
}

// Bind a run directory once so the pure composition step can emit without
// knowing where artifacts live.
export function eventSink(runDir: string): EventSink {
  return (event) => emitEvent(runDir, event);
}

export function readEvents(runDir: string): PipelineEvent[] {
  const path = join(runDir, EVENTS_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as PipelineEvent);
}
