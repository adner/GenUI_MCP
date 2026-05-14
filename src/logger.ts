/**
 * Per-call structured logger.
 *
 * One file per `generate_ui_component` invocation under `logs/`, JSON-lines,
 * named `<ISO-timestamp>_<runId-prefix>.jsonl`. Every event the agent emits,
 * every assistant text, every tool call result, plus the final extraction
 * decision lands in one place — readable cold by `tail` or `jq`.
 *
 * Also mirrors a short summary to stderr so you can watch live in the server
 * terminal without opening the log file.
 *
 * Two notable suppressions:
 *   - TEXT_MESSAGE_CONTENT (thousands per call) — the full assistant text is
 *     logged once on TEXT_MESSAGE_END via the `textMessageBuffer`.
 *   - RAW (duplicate underlying events) — adds no signal vs. the typed events.
 */
import { mkdirSync, createWriteStream, type WriteStream } from "node:fs";
import { resolve } from "node:path";

export interface CallLogger {
  /** Structured log entry. Goes to file + a compact stderr line. */
  log(level: string, msg: string, data?: Record<string, unknown>): void;
  /** Finalize with outcome and close the underlying stream. */
  close(outcome: {
    ok: boolean;
    error?: string;
    widget?: { title: string; htmlLen: number; source: string };
  }): void;
  /** Absolute path to the log file for this call. */
  readonly path: string;
}

export function startCallLog(threadId: string, runId: string): CallLogger {
  mkdirSync("logs", { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = resolve("logs", `${timestamp}_${runId.slice(0, 8)}.jsonl`);
  const stream: WriteStream = createWriteStream(path, { flags: "a" });

  const writeLine = (entry: Record<string, unknown>) => {
    stream.write(JSON.stringify(entry) + "\n");
  };

  const log = (level: string, msg: string, data?: Record<string, unknown>) => {
    writeLine({ t: new Date().toISOString(), level, msg, ...(data ?? {}) });
    const compact = data ? " " + JSON.stringify(data).slice(0, 240) : "";
    console.error(`[opengen-ui-mcp] [${level}] ${msg}${compact}`);
  };

  log("INFO", "call.start", { threadId, runId, logFile: path });

  return {
    log,
    path,
    close(outcome) {
      log("INFO", "call.end", outcome as unknown as Record<string, unknown>);
      stream.end();
    },
  };
}
