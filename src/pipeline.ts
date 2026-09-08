// Pipeline CLI: wires the pure steps into runs and writes artifacts.
// Commands:
//   demo:  three briefs → artifacts/runs/{clean,messy,hostile}/
//   break: clean brief + injected "47 percent ROI" → CLAIM_NUMBER block
//   run <brief.json> [outDir]
//
// Every run folder gets ticket.json, draft.json, lint.json, preview.html,
// decision.json, events.jsonl (+ rewrite-proposal.json when the model
// proposed one). cio-payload.json exists ONLY when the gate said
// ready_for_cio, a blocked or review run has no payload at all, which is
// the "no send path" property the evals assert. Outputs carry no timestamps
// so reruns are byte-identical.
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { getLLM } from "./llm.js";
import { parseTicket, type Brief } from "./steps/parseTicket.js";
import { validateTicket } from "./steps/validateTicket.js";
import { retrieveContext } from "./steps/retrieveContext.js";
import { generateDraft } from "./steps/generateDraft.js";
import { attachFooter } from "./steps/attachFooter.js";
import { lintEmail } from "./steps/lintEmail.js";
import { rewriteSpans } from "./steps/rewriteSpans.js";
import { reviewDraft } from "./steps/reviewDraft.js";
import { hitlGate, type GateStatus } from "./steps/hitlGate.js";
import { renderPreview } from "./steps/renderPreview.js";
import { cioPayload, type CioPattern } from "./steps/cioPayload.js";
import { assertAllowedSdk, assertNoSendSurface, loadAllowlist } from "./steps/allowlist.js";
import { emitEvent, eventSink, type EventSink } from "./steps/emitEvent.js";
import type { EmailDraft } from "./steps/schema.js";

// The marketer-editable play files are wired here, not decorative: the
// pipeline reads the play matching the ticket type and takes the Customer.io
// pattern from it. Gate thresholds stay hardcoded in hitlGate by design
// (locked logic); a test pins the play files to those constants so the YAML
// cannot silently drift from what actually runs.
export interface Play {
  cio_pattern: CioPattern;
  thresholds: { reviewer_min_score: number; ticket_min_confidence: number };
}

export function loadPlay(type: "nurture" | "launch"): Play {
  const doc = parseYaml(
    readFileSync(join("skills", `email-${type}`, "play.yaml"), "utf8"),
  ) as { cio_pattern: CioPattern; thresholds: Play["thresholds"] };
  return { cio_pattern: doc.cio_pattern, thresholds: doc.thresholds };
}

export interface ComposedDraft {
  ticket: ReturnType<typeof validateTicket>;
  draft: EmailDraft;
  lint: ReturnType<typeof lintEmail>;
  rewrite: Awaited<ReturnType<typeof rewriteSpans>>;
  reviewer: Awaited<ReturnType<typeof reviewDraft>>;
  gate: GateStatus;
}

// The one canonical brief → gated-draft composition. runPipeline and the
// eval runner both call this, so the two paths cannot drift. Note the gate
// input: a draft that raises its OWN needs_input routes to review even when
// the ticket was clean - the model admitting uncertainty is exactly the
// signal a human should see.
//
// `emit` is optional so the eval runner and unit tests can compose without a
// run directory; runPipeline passes a sink bound to its outDir. The three
// events here (intake, draft, gate) are the stages a human never touches,
// handoff and approval are emitted where those decisions actually happen.
// Only ids, counts and outcomes go in: the brief and the copy stay in
// ticket.json/draft.json, never in a log line.
export async function composeDraft(
  brief: Brief,
  brand: ReturnType<typeof retrieveContext>,
  llm: ReturnType<typeof getLLM>,
  emit?: EventSink,
): Promise<ComposedDraft> {
  const ticket = validateTicket(await parseTicket(brief, llm));
  emit?.({
    stage: "intake",
    ticket_id: ticket.ticket_id,
    requester: brief.source,
    type: ticket.type,
    confidence: ticket.confidence,
    needs_input_count: ticket.needs_input.length,
  });
  const withFooter = attachFooter(await generateDraft(ticket, brand, llm), brand);
  const lint = lintEmail(withFooter, brand);
  const draft: EmailDraft = { ...withFooter, lint };
  emit?.({
    stage: "draft",
    ticket_id: ticket.ticket_id,
    block_count: draft.blocks.length,
    citation_count: draft.citations.length,
    needs_input_count: draft.needs_input.length,
    lint_status: lint.status,
  });
  const rewrite = await rewriteSpans(withFooter, lint.violations, llm);
  const reviewer = await reviewDraft(ticket, withFooter, lint, llm);
  const gateTicket = {
    ...ticket,
    needs_input: [...new Set([...ticket.needs_input, ...draft.needs_input])],
  };
  const gate = hitlGate({ lint, reviewer, ticket: gateTicket });
  emit?.({
    stage: "gate",
    ticket_id: ticket.ticket_id,
    gate,
    lint_status: lint.status,
    violation_ids: lint.violations.map((v) => v.rule_id),
    reviewer_score: reviewer.score,
    needs_input_count: gateTicket.needs_input.length,
  });
  return { ticket, draft, lint, rewrite, reviewer, gate };
}

function writeJson(dir: string, name: string, value: unknown): void {
  writeFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
}

export interface RunResult {
  gate: GateStatus;
  outDir: string;
  violationIds: string[];
  payloadWritten: boolean;
}

export async function runPipeline(
  brief: Brief,
  opts: { outDir: string; pattern?: CioPattern },
): Promise<RunResult> {
  const llm = getLLM();
  const brand = retrieveContext();

  // The recursive clean below is destructive, so the target must live inside
  // the artifacts tree. Without this guard a stray `run <brief> ~/somewhere`
  // would rm -rf whatever it was pointed at.
  const runsRoot = resolve("artifacts", "runs");
  if (!resolve(opts.outDir).startsWith(runsRoot + "/")) {
    throw new Error(`outDir must be under artifacts/runs, got: ${opts.outDir}`);
  }
  // The run dir is prepared BEFORE composition so events.jsonl can be
  // appended as each stage completes. Side effect worth knowing: a run that
  // throws mid-composition leaves a fresh dir holding only the events up to
  // the failing stage, which is the more useful trace anyway.
  rmSync(opts.outDir, { recursive: true, force: true });
  mkdirSync(opts.outDir, { recursive: true });
  const { ticket, draft, lint, rewrite, reviewer, gate } = await composeDraft(
    brief,
    brand,
    llm,
    eventSink(opts.outDir),
  );

  writeJson(opts.outDir, "ticket.json", ticket);
  writeJson(opts.outDir, "draft.json", draft);
  writeJson(opts.outDir, "lint.json", lint);
  writeFileSync(join(opts.outDir, "preview.html"), renderPreview(draft, gate));
  writeJson(opts.outDir, "decision.json", {
    gate,
    lint_status: lint.status,
    reviewer,
    human_decision: "pending",
    note: "",
  });
  if (rewrite.spans.length > 0) {
    writeJson(opts.outDir, "rewrite-proposal.json", rewrite);
  }

  let payloadWritten = false;
  if (gate === "ready_for_cio") {
    const payload = cioPayload(ticket, draft, {
      // Explicit override wins; otherwise the play file for this ticket type
      // decides the pattern (design_studio unless a human flipped the flag).
      pattern: opts.pattern ?? loadPlay(ticket.type).cio_pattern,
      // Deterministic run label: the deadline is ticket data; "undated" runs
      // say so instead of leaking a wall clock into artifacts.
      date: ticket.deadline || "undated",
    });
    assertAllowedSdk(payload.sdk, loadAllowlist());
    assertNoSendSurface(payload);
    writeJson(opts.outDir, "cio-payload.json", payload);
    payloadWritten = true;
    // handoff means "a create-only payload exists on disk", nothing more,
    // emitted after the guards so a rejected payload never logs as handed off.
    emitEvent(opts.outDir, {
      stage: "handoff",
      ticket_id: ticket.ticket_id,
      gate,
      sdk: payload.sdk,
    });
  }

  return {
    gate,
    outDir: opts.outDir,
    violationIds: lint.violations.map((v) => v.rule_id),
    payloadWritten,
  };
}

function loadBrief(path: string): Brief {
  return JSON.parse(readFileSync(path, "utf8")) as Brief;
}

function report(name: string, result: RunResult): void {
  const payload = result.payloadWritten ? "payload written" : "NO payload";
  const violations = result.violationIds.length > 0 ? result.violationIds.join(",") : "none";
  console.log(`${name.padEnd(8)} gate=${result.gate.padEnd(13)} violations=[${violations}] ${payload}`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "demo": {
      const runs: [string, string][] = [
        ["clean", "evals/briefs/clean-nurture.json"],
        ["messy", "evals/briefs/messy-slack.json"],
        ["hostile", "evals/briefs/hostile-offbrand.json"],
      ];
      for (const [name, path] of runs) {
        report(name, await runPipeline(loadBrief(path), { outDir: join("artifacts/runs", name) }));
      }
      break;
    }
    case "break": {
      // The break demo: one uncleared number injected into an otherwise
      // clean brief. The requester "asked for it", the generator obliged,
      // and the policy layer blocks it with no payload emitted.
      const brief = loadBrief("evals/briefs/clean-nurture.json");
      const sabotaged: Brief = {
        ...brief,
        ticket_id: "t-break-004",
        raw: `${brief.raw}\ninclude: teams see a 47 percent ROI in year one`,
      };
      const result = await runPipeline(sabotaged, { outDir: "artifacts/runs/break" });
      report("break", result);
      if (!result.violationIds.includes("CLAIM_NUMBER")) {
        throw new Error("break demo expected a CLAIM_NUMBER violation");
      }
      if (result.payloadWritten || existsSync("artifacts/runs/break/cio-payload.json")) {
        throw new Error("break demo must not emit a payload");
      }
      console.log("injected number blocked; no payload emitted");
      break;
    }
    case "run": {
      const [briefPath, outDir = "artifacts/runs/adhoc"] = args;
      if (!briefPath) throw new Error("usage: pipeline run <brief.json> [outDir]");
      report("run", await runPipeline(loadBrief(briefPath), { outDir }));
      break;
    }
    default:
      throw new Error(`unknown command: ${command ?? "(none)"}, use demo | break | run`);
  }
}

// Run the CLI only when this file is the entry module, composeDraft and
// loadPlay are also imported by tests and the eval runner, and an import
// must never trigger a pipeline run.
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
