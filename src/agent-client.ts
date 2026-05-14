/**
 * AG-UI HttpAgent wrapper for the OpenGenerativeUI agent.
 *
 * Drives one stateless run per call:
 *   - fresh threadId / runId (§5.4)
 *   - shaped prompt nudging the agent toward `widgetRenderer` (§5.3)
 *   - shape-based extraction from TOOL_CALL_RESULT events (§5.2)
 *   - chart-path detection via TOOL_CALL_START (§9.3)
 *
 * Throws a typed error so the MCP tool handler can map each case to a
 * §4.1 error message and `isError: true`.
 */
import { HttpAgent } from "@ag-ui/client";
import { randomUUID } from "node:crypto";
import { startCallLog } from "./logger.js";

export type WidgetPayload = {
  title: string;
  description: string;
  html: string;
};

export class AgentError extends Error {
  readonly kind:
    | "unreachable"
    | "stream_error"
    | "no_widget"
    | "chart_unsupported"
    | "timeout";
  constructor(kind: AgentError["kind"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentError";
    this.kind = kind;
  }
}

export interface GenerateOptions {
  agentUrl: string;
  description: string;
  timeoutMs: number;
}

/**
 * Advertise `widgetRenderer` as a client-side tool over AG-UI.
 *
 * Without this, the agent (a CopilotKit deep-agents app) looks up its tool
 * list and doesn't find `widgetRenderer` — because in the CopilotKit Next.js
 * frontend, `widgetRenderer` is registered via `useComponent` and
 * CopilotKit's middleware injects it into the agent's tool list at runtime.
 * When we talk to the agent directly via AG-UI from this MCP server, that
 * injection doesn't happen, so the agent falls back to one of several
 * workarounds (inlined JSON, ```widgetRenderer code blocks, JSX tag syntax,
 * or just text saying "this tool isn't available").
 *
 * Mirroring the CopilotKit frontend's registered shape (see
 * `OpenGenerativeUI/apps/app/src/components/generative-ui/widget-renderer.tsx`):
 *   - title:       Short title for the visualization
 *   - description: One-sentence explanation
 *   - html:        Self-contained HTML fragment with inline <style> and <script>
 */
const WIDGET_RENDERER_TOOL = {
  name: "widgetRenderer",
  // Copied verbatim from OpenGenerativeUI's CopilotKit useComponent registration
  // in apps/app/src/hooks/use-generative-ui-examples.tsx — so the agent sees
  // exactly the same tool description as in the Next.js frontend.
  description:
    "Renders interactive HTML/SVG visualizations in a sandboxed iframe. " +
    "Use for algorithm visualizations, diagrams, interactive widgets, " +
    "simulations, math plots, and any visual explanation.",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description:
          "Short title for the visualization, e.g. 'Binary Search' or 'Load Balancer Architecture'",
      },
      description: {
        type: "string",
        description: "One-sentence explanation of what this visualization demonstrates",
      },
      html: {
        type: "string",
        description:
          "Self-contained HTML fragment with inline <style> and <script>. " +
          "Use CSS variables (var(--color-text-primary), etc.) for theming. " +
          "No external dependencies unless from allowed CDNs (cdnjs, esm.sh, jsdelivr, unpkg). " +
          "Include interactive controls where appropriate. " +
          "IMPORTANT: do not use viewport-relative units for layout height " +
          "(`100vh`, `100dvh`, `100svh`, `100vmin`, etc.) — the widget is rendered " +
          "inside a sized container, not full-screen. Use fixed pixel heights " +
          "(e.g. `min-height: 480px`, `height: 360px`) or let content size itself naturally.",
      },
    },
    required: ["title", "description", "html"],
  },
} as const;

function tryCapture(content: string): WidgetPayload | null {
  let payload: unknown;
  try {
    payload = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.html !== "string") return null;
  return {
    title: typeof p.title === "string" ? p.title : "",
    description: typeof p.description === "string" ? p.description : "",
    html: p.html,
  };
}

/**
 * Walk `text` looking for the widget payload in any of the three surfaces the
 * agent uses when it inlines the payload in assistant text:
 *
 *   1. Raw JSON object:                  `{ "title":"...", "html":"..." }`
 *   2. Fenced JSON in a markdown block:  ```` ```widgetRenderer\n{ ... } ``` ````
 *   3. JSX-style component invocation:   `<widgetRenderer title="..." html='...' />`
 *
 * (1) and (2) reduce to "find brace-balanced JSON and run tryCapture".
 * (3) needs attribute parsing — handled by tryCaptureFromWidgetTag.
 *
 * Last successful match wins, mirroring §4.1's rule for multiple
 * widgetRenderer calls. Empty-string `html` is treated as no match so
 * substitution-template placeholders (`html='$(function.task.html)'`) that
 * resolve to nothing don't masquerade as success.
 */
function tryCaptureFromText(text: string): WidgetPayload | null {
  const jsx = tryCaptureFromWidgetTag(text);
  const json = tryCaptureFromJson(text);
  return json ?? jsx;
}

function tryCaptureFromJson(text: string): WidgetPayload | null {
  let last: WidgetPayload | null = null;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0;
    let inStr = false;
    let escape = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (escape) {
        escape = false;
        continue;
      }
      if (c === "\\") {
        escape = true;
        continue;
      }
      if (c === '"') {
        inStr = !inStr;
        continue;
      }
      if (inStr) continue;
      if (c === "{") {
        depth++;
      } else if (c === "}") {
        depth--;
        if (depth === 0) {
          const w = tryCapture(text.slice(i, j + 1));
          if (w) last = w;
          // Skip past this candidate to avoid re-scanning inner braces.
          i = j;
          break;
        }
      }
    }
  }
  return last;
}

/**
 * Parse a `<widgetRenderer title="..." description="..." html='...' />`
 * invocation out of assistant text. Returns the last match in the text (last
 * wins, per §4.1).
 *
 * Rejects:
 *   - tags whose `html` attribute is missing or empty
 *   - tags whose `html` attribute is a substitution placeholder like
 *     `$(function.task.html)` — those are templates, not actual HTML
 */
function tryCaptureFromWidgetTag(text: string): WidgetPayload | null {
  const TAG_OPEN = "<widgetRenderer";
  let last: WidgetPayload | null = null;
  let searchFrom = 0;
  while (true) {
    const start = text.indexOf(TAG_OPEN, searchFrom);
    if (start < 0) break;
    // Find the end of the opening tag (`>` outside any string literal).
    let i = start + TAG_OPEN.length;
    let inSingle = false;
    let inDouble = false;
    let escape = false;
    let end = -1;
    for (; i < text.length; i++) {
      const c = text[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (c === "\\") {
        escape = true;
        continue;
      }
      if (inSingle) {
        if (c === "'") inSingle = false;
        continue;
      }
      if (inDouble) {
        if (c === '"') inDouble = false;
        continue;
      }
      if (c === "'") {
        inSingle = true;
        continue;
      }
      if (c === '"') {
        inDouble = true;
        continue;
      }
      if (c === ">") {
        end = i;
        break;
      }
    }
    if (end < 0) break;
    const attrsBlob = text
      .slice(start + TAG_OPEN.length, end)
      .replace(/\/$/, "")
      .trim();
    const attrs = parseAttributes(attrsBlob);
    const html = attrs.html;
    const looksLikePlaceholder =
      typeof html === "string" && /^\$\([^)]+\)$/.test(html.trim());
    if (typeof html === "string" && html.length > 0 && !looksLikePlaceholder) {
      last = {
        title: typeof attrs.title === "string" ? attrs.title : "",
        description:
          typeof attrs.description === "string" ? attrs.description : "",
        html,
      };
    }
    searchFrom = end + 1;
  }
  return last;
}

/**
 * Minimal JSX-attribute parser: reads `name="value"` / `name='value'` pairs,
 * supporting backslash escapes inside the quoted value. Doesn't handle
 * `name={expression}` (curly-brace JSX expressions) — those are not used by
 * the agent for the widgetRenderer payload, and trying to interpret them
 * would risk surfacing substitution templates as success.
 */
function parseAttributes(blob: string): Record<string, string> {
  const out: Record<string, string> = {};
  let j = 0;
  while (j < blob.length) {
    while (j < blob.length && /\s/.test(blob[j]!)) j++;
    if (j >= blob.length) break;
    const nameStart = j;
    while (j < blob.length && /[\w-]/.test(blob[j]!)) j++;
    const name = blob.slice(nameStart, j);
    if (!name) break;
    while (j < blob.length && /\s/.test(blob[j]!)) j++;
    if (blob[j] !== "=") {
      out[name] = "";
      continue;
    }
    j++;
    while (j < blob.length && /\s/.test(blob[j]!)) j++;
    const quote = blob[j];
    if (quote !== "'" && quote !== '"') break;
    j++;
    let v = "";
    while (j < blob.length) {
      const c = blob[j]!;
      if (c === "\\" && j + 1 < blob.length) {
        const next = blob[j + 1]!;
        // Translate the common JS-style escapes the agent might emit.
        switch (next) {
          case "n": v += "\n"; break;
          case "t": v += "\t"; break;
          case "r": v += "\r"; break;
          case "\\": v += "\\"; break;
          case "'": v += "'"; break;
          case '"': v += '"'; break;
          default: v += next; break;
        }
        j += 2;
        continue;
      }
      if (c === quote) {
        j++;
        break;
      }
      v += c;
      j++;
    }
    out[name] = v;
  }
  return out;
}

function shapePrompt(description: string): string {
  return (
    `Render the following as an interactive HTML/SVG/JS component using the ` +
    `widgetRenderer tool. Do not respond with plain text only. Description:\n\n` +
    description
  );
}

/**
 * Detect "connection refused / DNS / not running" classes of fetch failure so
 * the tool can surface the §4.1 "agent unreachable" message. The AG-UI SDK
 * wraps the underlying fetch error in its own Error, so we match on the chain.
 */
function isUnreachable(err: unknown): boolean {
  const visit = (e: unknown): boolean => {
    if (!e || typeof e !== "object") return false;
    const eo = e as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof eo.code === "string") {
      const c = eo.code;
      if (
        c === "ECONNREFUSED" ||
        c === "ENOTFOUND" ||
        c === "EAI_AGAIN" ||
        c === "ECONNRESET" ||
        c === "UND_ERR_SOCKET" ||
        c === "UND_ERR_CONNECT_TIMEOUT"
      ) {
        return true;
      }
    }
    if (typeof eo.message === "string") {
      const m = eo.message.toLowerCase();
      if (
        m.includes("fetch failed") ||
        m.includes("connection refused") ||
        m.includes("econnrefused") ||
        m.includes("enotfound") ||
        m.includes("getaddrinfo")
      ) {
        return true;
      }
    }
    return visit(eo.cause);
  };
  return visit(err);
}

export async function generateWidget(
  opts: GenerateOptions,
): Promise<WidgetPayload> {
  const threadId = randomUUID();
  const runId = randomUUID();
  const shaped = shapePrompt(opts.description);
  const logger = startCallLog(threadId, runId);
  logger.log("INFO", "prompt.shaped", {
    description: opts.description,
    shapedPrompt: shaped,
    agentUrl: opts.agentUrl,
    timeoutMs: opts.timeoutMs,
  });

  const agent = new HttpAgent({
    url: opts.agentUrl,
    threadId,
    initialMessages: [{ id: randomUUID(), role: "user", content: shaped }],
  });

  const captured: { widget: WidgetPayload; source: string }[] = [];
  let pieOrBarSeen = false;
  const toolCallNamesById = new Map<string, string>();
  const messageRoles = new Map<string, string>();
  const assistantTexts: string[] = [];

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), opts.timeoutMs);
  let timedOut = false;
  abort.signal.addEventListener("abort", () => {
    timedOut = true;
  });

  try {
    await agent.runAgent(
      {
        runId,
        abortController: abort,
        // Advertise widgetRenderer as a client-side tool so the agent sees it
        // in its tool list (mirrors what CopilotKit's middleware does for the
        // Next.js frontend). Without this, the agent often emits inline
        // workarounds or refuses outright.
        tools: [WIDGET_RENDERER_TOOL],
      },
      {
        // Catch-all for visibility — emits one log entry per AG-UI event with
        // a compact summary. We deliberately skip TEXT_MESSAGE_CONTENT (high
        // volume; full text logged on TEXT_MESSAGE_END) and RAW (duplicates).
        onEvent: ({ event }) => {
          if (
            event.type === "TEXT_MESSAGE_CONTENT" ||
            event.type === "RAW"
          ) {
            return;
          }
          const e = event as Record<string, unknown>;
          const summary: Record<string, unknown> = { type: event.type };
          for (const k of [
            "toolCallId",
            "toolCallName",
            "parentMessageId",
            "messageId",
            "role",
            "stepName",
            "threadId",
            "runId",
          ]) {
            if (typeof e[k] === "string") summary[k] = e[k];
          }
          if (typeof e.delta === "string") summary.deltaLen = e.delta.length;
          if (typeof e.content === "string") {
            summary.contentLen = e.content.length;
            summary.contentPreview = e.content.slice(0, 300);
          }
          logger.log("EVENT", event.type, summary);
        },
        onToolCallStartEvent: ({ event }) => {
          toolCallNamesById.set(event.toolCallId, event.toolCallName);
          if (
            event.toolCallName === "pieChart" ||
            event.toolCallName === "barChart"
          ) {
            pieOrBarSeen = true;
          }
        },
        onToolCallEndEvent: ({ event, toolCallName, toolCallArgs }) => {
          logger.log("TOOL_END", toolCallName, {
            toolCallId: event.toolCallId,
            args: toolCallArgs,
          });
          // Primary capture path: agent called widgetRenderer as a real tool
          // (this is the one we want — we advertised it via `tools` above).
          if (toolCallName === "widgetRenderer") {
            const args = toolCallArgs as Record<string, unknown>;
            if (typeof args?.html === "string" && args.html.length > 0) {
              captured.push({
                widget: {
                  title: typeof args.title === "string" ? args.title : "",
                  description:
                    typeof args.description === "string" ? args.description : "",
                  html: args.html,
                },
                source: "tool_call:widgetRenderer",
              });
            }
          }
        },
        onToolCallResultEvent: ({ event }) => {
          const toolName = toolCallNamesById.get(event.toolCallId) ?? "?";
          const w = tryCapture(event.content);
          logger.log("TOOL_RESULT", toolName, {
            toolCallId: event.toolCallId,
            contentLen: event.content?.length ?? 0,
            captured: !!w,
            content: event.content,
          });
          if (w) captured.push({ widget: w, source: `tool_call_result:${toolName}` });
        },
        onTextMessageStartEvent: ({ event }) => {
          messageRoles.set(event.messageId, event.role);
        },
        onTextMessageEndEvent: ({ event, textMessageBuffer }) => {
          const role = messageRoles.get(event.messageId);
          logger.log("TEXT_MESSAGE", `${role ?? "?"} ${event.messageId}`, {
            role,
            length: textMessageBuffer.length,
            content: textMessageBuffer,
          });
          if (role === "assistant") {
            assistantTexts.push(textMessageBuffer);
          }
        },
        onRunFailed: ({ error }) => {
          logger.log("ERROR", "onRunFailed", { message: error.message });
          throw new AgentError(
            "stream_error",
            `Agent run failed: ${error.message}`,
            { cause: error },
          );
        },
      },
    );
  } catch (err) {
    if (timedOut) {
      const e = new AgentError(
        "timeout",
        `Agent timed out after ${Math.round(opts.timeoutMs / 1000)} s.`,
      );
      logger.close({ ok: false, error: e.message });
      throw e;
    }
    if (err instanceof AgentError) {
      logger.close({ ok: false, error: err.message });
      throw err;
    }
    if (isUnreachable(err)) {
      const e = new AgentError(
        "unreachable",
        `OpenGenerativeUI agent at ${opts.agentUrl} is not reachable. ` +
          "Start it with `make dev-agent` in the OpenGenerativeUI/ repo.",
        { cause: err as Error },
      );
      logger.close({ ok: false, error: e.message });
      throw e;
    }
    const e = new AgentError(
      "stream_error",
      err instanceof Error ? err.message : String(err),
      { cause: err as Error },
    );
    logger.close({ ok: false, error: e.message });
    throw e;
  } finally {
    clearTimeout(timer);
  }

  // Fallback: agent sometimes skips the `task` tool and inlines the widget
  // payload in assistant text (raw JSON or fenced widgetRenderer block).
  if (captured.length === 0) {
    for (let i = 0; i < assistantTexts.length; i++) {
      const text = assistantTexts[i]!;
      const w = tryCaptureFromText(text);
      logger.log("EXTRACT", `text_message[${i}]`, {
        length: text.length,
        captured: !!w,
      });
      if (w) captured.push({ widget: w, source: `assistant_text[${i}]` });
    }
  }

  logger.log("INFO", "extraction.summary", {
    capturedCount: captured.length,
    sources: captured.map((c) => c.source),
    pieOrBarSeen,
    assistantTextCount: assistantTexts.length,
    toolCallCount: toolCallNamesById.size,
    toolCalls: Array.from(toolCallNamesById.entries()).map(
      ([id, name]) => ({ id, name }),
    ),
  });

  if (captured.length === 0) {
    const snippet = formatAssistantSnippet(assistantTexts);
    if (pieOrBarSeen) {
      const e = new AgentError(
        "chart_unsupported",
        "Agent generated a chart instead of an HTML component. " +
          "This tool only renders `widgetRenderer` output. " +
          "Rephrase to request a custom interactive visualization " +
          "(e.g., 'as an interactive SVG' rather than 'as a chart')." +
          snippet,
      );
      logger.close({ ok: false, error: e.message });
      throw e;
    }
    const e = new AgentError(
      "no_widget",
      "Agent responded with text only; no UI component was produced. " +
        "Try a more visual description." +
        snippet,
    );
    logger.close({ ok: false, error: e.message });
    throw e;
  }

  const last = captured[captured.length - 1]!;
  logger.close({
    ok: true,
    widget: {
      title: last.widget.title,
      htmlLen: last.widget.html.length,
      source: last.source,
    },
  });
  return last.widget;
}

/**
 * Format the agent's assistant text for inclusion in an error message.
 * Returns "" if there was no assistant text. Caps the joined output so the
 * error stays readable in the host's UI (VS Code / Claude Desktop).
 */
function formatAssistantSnippet(assistantTexts: string[]): string {
  const joined = assistantTexts.join("\n---\n").trim();
  if (!joined) return "";
  const MAX = 600;
  const body = joined.length <= MAX ? joined : `${joined.slice(0, MAX)}…`;
  return `\n\nAgent said:\n${body}`;
}
