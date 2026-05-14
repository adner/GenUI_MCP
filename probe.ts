/**
 * §9.1 probe: connect to the OpenGenerativeUI agent via @ag-ui/client and
 * capture a full event stream as a fixture. Logs every event to stdout,
 * writes raw events to fixture.jsonl, and writes a captured widgetRenderer
 * payload to widget.json if one comes through.
 *
 * Run: npm run probe
 * Prereq: agent at http://localhost:8123 (make dev-agent in OpenGenerativeUI/)
 */
import { HttpAgent, EventType } from "@ag-ui/client";
import { writeFileSync, appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const AGENT_URL = process.env.AGENT_URL ?? "http://localhost:8123/";
const DESCRIPTION =
  process.argv.slice(2).join(" ") ||
  "an interactive SVG visualization of binary search on a sorted array";

const FIXTURE = "fixture.jsonl";
const WIDGET = "widget.json";
writeFileSync(FIXTURE, "");

const shapedPrompt =
  `Render the following as an interactive HTML/SVG/JS component using the ` +
  `widgetRenderer tool. Do not respond with plain text only. Description:\n\n${DESCRIPTION}`;

const agent = new HttpAgent({
  url: AGENT_URL,
  threadId: randomUUID(),
  initialMessages: [
    { id: randomUUID(), role: "user", content: shapedPrompt },
  ],
});

type WidgetPayload = { title: string; description: string; html: string };
let widget: WidgetPayload | null = null;

console.log(`→ POST ${AGENT_URL}`);
console.log(`→ prompt: ${DESCRIPTION}\n`);

await agent.runAgent(
  { runId: randomUUID() },
  {
    onEvent: ({ event }) => {
      appendFileSync(FIXTURE, JSON.stringify(event) + "\n");
      // Compact one-line summary per event for stdout
      const e = event as Record<string, unknown>;
      const summary = Object.entries(e)
        .filter(([k]) => k !== "rawEvent" && k !== "timestamp")
        .map(([k, v]) => `${k}=${typeof v === "string" ? JSON.stringify(v).slice(0, 60) : v}`)
        .join(" ");
      console.log(summary);
    },
    onToolCallEndEvent: ({ event, toolCallName, toolCallArgs }) => {
      console.log(`\n>> TOOL_CALL_END  name=${toolCallName}  argsKeys=${Object.keys(toolCallArgs).join(",")}`);
      if (toolCallName === "widgetRenderer") {
        const w = toolCallArgs as WidgetPayload;
        widget = w;
        writeFileSync(WIDGET, JSON.stringify(w, null, 2));
        console.log(`>> captured widgetRenderer → ${WIDGET} (html ${w.html.length} chars)\n`);
      }
    },
    onRunFailed: ({ error }) => {
      console.error(`\n!! onRunFailed: ${error.message}`);
    },
  },
);

console.log(`\n--- run finished ---`);
console.log(`fixture: ${FIXTURE}`);
const finalWidget = widget as WidgetPayload | null;
if (finalWidget !== null) {
  console.log(`widget:  ${WIDGET}  (title="${finalWidget.title}")`);
} else {
  console.log(`widget:  NOT captured (no widgetRenderer call in this run)`);
}
