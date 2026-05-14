# OpenGenUI MCP — Spec

## 1. Goal

Build a standalone **MCP Apps**-capable MCP server that exposes a single tool. The tool accepts a natural-language description of a UI component, drives the existing [OpenGenerativeUI](../OpenGenerativeUI/README.md) agent at `http://localhost:8123` to produce an HTML/JS visualization, and returns that HTML as an interactive MCP Apps **View** that any compliant host (Claude Desktop, Claude Code, basic-host) can render.

Reference docs:

- [MCP Apps overview](https://modelcontextprotocol.io/extensions/apps/overview)
- [MCP Apps SDK source](https://github.com/modelcontextprotocol/ext-apps) — `@modelcontextprotocol/ext-apps`
- OpenGenerativeUI agent: `C:\Sandboxes\OpenGenUI\OpenGenerativeUI\apps\agent\main.py`
- Existing reference MCP server (skill resources, `assemble_document` tool — but NO MCP Apps UI): `C:\Sandboxes\OpenGenUI\OpenGenerativeUI\apps\mcp\`

## 2. Non-goals

- We are **not** re-implementing the visualization logic. The agent does the heavy lifting.
- We are **not** modifying the OpenGenerativeUI repo. This is a separate project at `C:\Sandboxes\OpenGenUI\OpenGenUIMCP\`.
- We are **not** building a chat UI. The MCP App is a one-shot renderer: prompt in → component out.
- No auth. No persistence. No multi-tenancy.

## 3. Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│ MCP Host (Claude Desktop / Claude Code / basic-host)                 │
│                                                                      │
│  1. tools/call("generate_ui_component", {description})               │
│  2. resources/read("ui://opengen/viewer.html")  → static HTML        │
│  3. Renders View inside sandboxed iframe                             │
│  4. Delivers tool result (structuredContent.html) to View            │
└──────────────────────────────────────────────────────────────────────┘
        │                                                  ▲
        │ MCP / Streamable HTTP                            │ View HTML
        ▼                                                  │
┌──────────────────────────────────────────────────────────────────────┐
│ OpenGenUI MCP Server (this project)                                  │
│                                                                      │
│  • registerAppTool("generate_ui_component", ...)                     │
│      └─ runs OpenGenerativeUI agent with `widgetRenderer` advertised │
│         as a client-side tool over AG-UI                             │
│      └─ captures widgetRenderer({title, description, html})          │
│         via onToolCallEndEvent; falls back to assistant-text         │
│         scanning if the agent inlines the payload as text            │
│      └─ wraps html with design-system shell (assembleDocument)       │
│      └─ writes per-call structured log to logs/<ts>_<runId>.jsonl    │
│      └─ returns structuredContent: { title, description, html }      │
│                                                                      │
│  • registerAppResource("ui://opengen/viewer.html", ...)              │
│      └─ Static bundled viewer (Vite + vite-plugin-singlefile)        │
│      └─ On ontoolresult: inject html into nested sandboxed iframe    │
│      └─ Propagates host theme to the nested iframe via postMessage   │
└──────────────────────────────────────────────────────────────────────┘
        │
        │ AG-UI HTTP (streamed events via @ag-ui/client)
        │ — request advertises widgetRenderer in `tools` —
        ▼
┌──────────────────────────────────────────────────────────────────────┐
│ OpenGenerativeUI Agent  (http://localhost:8123)                      │
│                                                                      │
│  Deep Agent (LangGraph) does:                                        │
│    plan_visualization → widgetRenderer(title, description, html)     │
│                              ↑ a real tool call, surfaced as         │
│                                TOOL_CALL_START/ARGS/END events       │
│                                                                      │
│  Without `tools` advertisement the agent doesn't see widgetRenderer  │
│  and falls back to inlining the payload in assistant text — see §5.2 │
└──────────────────────────────────────────────────────────────────────┘
```

### 3.1 MCP Apps pattern: static View + dynamic data

MCP Apps separates the **UI template** (static, served as a resource via `ui://`) from the **tool result** (dynamic data delivered to the View through the host). We follow this pattern:

- The View is a tiny static page bundled to a single HTML file with Vite + `vite-plugin-singlefile`.
- The View registers an `ontoolresult` handler. When the host delivers the tool result, the View reads `structuredContent.html` (the agent's HTML pre-wrapped with the design system) and injects it into a **nested sandboxed `<iframe srcdoc="…">`**.
- The nested iframe isolates the agent's scripts (CSP, ES module import map, three.js, gsap, etc.) from the View's own bundle and the host page.

Rationale for the nested iframe: the agent's output uses `<script type="module">` with bare-specifier imports resolved via an import map (`three`, `gsap`, `d3`, `chart.js/auto`), inline scripts, and a specific CSP. Trying to inject that into the View's main document fights with the View's own CSP and module graph. Using `srcdoc` gives the agent output a clean, self-contained execution context — and exactly mirrors the proven `widgetRenderer` design in `apps/app/src/components/generative-ui/widget-renderer.tsx`.

### 3.2 Tool/Resource linkage

```ts
registerAppTool(server, "generate_ui_component", {
  title: "Generate UI Component",
  description: "Generate an interactive HTML/JS UI component from a natural-language description.",
  inputSchema: { description: z.string().min(1).describe("Natural-language description of the UI component to generate.") },
  _meta: { ui: { resourceUri: "ui://opengen/viewer.html" } },
}, handler);
```

The host reads `_meta.ui.resourceUri` and fetches the viewer resource. One static resource serves every tool call.

## 4. Component contracts

### 4.1 The MCP tool: `generate_ui_component`

**Input schema**

| Field         | Type   | Required | Notes                                                              |
| ------------- | ------ | -------- | ------------------------------------------------------------------ |
| `description` | string | yes      | Natural-language description. Non-empty. No explicit length limit. |

**Output**

The tool returns *both* a text fallback (for non-UI hosts) and structured content (for the View):

```ts
{
  content: [
    { type: "text", text: `Generated UI component: ${title}\n${description}` }
  ],
  structuredContent: {
    title: string,        // from the agent's widgetRenderer call
    description: string,  // from the agent's widgetRenderer call
    html: string,         // full design-system-wrapped HTML document, ready for srcdoc
  },
}
```

`structuredContent.html` is the **fully-assembled HTML document** (DOCTYPE, theme CSS, SVG color classes, form styles, bridge JS, agent's HTML fragment in `#content`) produced by reusing the `assembleDocument()` logic from `OpenGenerativeUI/apps/mcp/src/renderer.ts`. We **fork** that file into this project rather than depend on it — see §6.4.

**Error modes** (all return `isError: true` and a text-only `content` so the model can recover):

| Condition                                            | Behavior                                                                                                       |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Agent unreachable (connection refused, DNS, etc.)    | `isError: true`, content text: "OpenGenerativeUI agent at $URL is not reachable. Start it with `make dev-agent`." |
| Agent reachable but stream errors out                | `isError: true`, propagate the agent's error text                                                              |
| Agent finishes without emitting `widgetRenderer`     | `isError: true`, content text: "Agent responded with text only; no UI component was produced. Try a more visual description." followed by `\n\nAgent said:\n<first ~600 chars of the assistant's reply>` so the failure mode is self-diagnosing |
| Agent emits `pieChart` or `barChart` and no widget payload is captured (detected via `onToolCallStartEvent`) | `isError: true`, content text: "Agent generated a chart instead of an HTML component. This tool only renders `widgetRenderer` output. Rephrase to request a custom interactive visualization (e.g., 'as an interactive SVG' rather than 'as a chart')." (also enriched with assistant-text snippet as above) |
| Agent times out (`AGENT_TIMEOUT_MS`, default 120 s — see §6.3) | `isError: true`, content text: "Agent timed out after 120 s."                                                  |
| Agent emits multiple `widgetRenderer` calls          | Use the **last** one (mirrors the agent's "plan → render → narrate" workflow where the final render is canonical). |
| Agent emits malformed AG-UI events (e.g. `STEP_FINISHED` for a step that wasn't started) | `isError: true`, propagate the AG-UI middleware's error text. Observed transient failure with LangGraph deep-agents — see §10. |

### 4.2 The MCP UI resource: `ui://opengen/viewer.html`

- MIME type: `RESOURCE_MIME_TYPE` from `@modelcontextprotocol/ext-apps/server` (i.e., `text/html+mcp-app`).
- Body: the single-file Vite build output of `mcp-app.html` + `src/mcp-app.ts`.
- Declares the broadest allowable `_meta.ui.csp` on the resource read result (NOT on the registration config — common mistake per the create-mcp-app skill). The server-declared CSP shape (`McpUiResourceCsp`, verified against the installed `@modelcontextprotocol/ext-apps@1.7.1`) only supports *domain allowlists* — `connectDomains`, `resourceDomains`, `frameDomains`, `baseUriDomains`. The CSP directive set itself (`'unsafe-inline'`, `'unsafe-eval'`, etc.) is the host's responsibility. We declare every CDN host the agent reaches for in both `resourceDomains` (script/style/img/font/media-src) and `connectDomains` (chart.js et al. fetch sub-resources after their ESM bootstrap):

  ```ts
  contents: [{
    uri,
    mimeType: RESOURCE_MIME_TYPE,
    text: html,
    _meta: {
      ui: {
        csp: {
          resourceDomains: [
            "https://cdnjs.cloudflare.com",
            "https://esm.sh",
            "https://cdn.jsdelivr.net",
            "https://unpkg.com",
          ],
          connectDomains: [
            "https://cdnjs.cloudflare.com",
            "https://esm.sh",
            "https://cdn.jsdelivr.net",
            "https://unpkg.com",
          ],
        }
      }
    }
  }]
  ```

  The nested `<iframe srcdoc>` carries its own `<meta http-equiv="Content-Security-Policy">` (set inside `assembleDocument()`) that is fully permissive — `script-src 'unsafe-inline' 'unsafe-eval' <those four CDNs>` etc. The inner CSP governs the agent's HTML; the outer (host-applied) CSP governs the View bundle itself, which is fully self-contained after `vite-plugin-singlefile` inlining so its own loose ends are limited to the host's defaults for `'self'` + inline.

  **Production tightening** (not in scope): a hardened deployment would scope `scriptSrc` to specific CDN hosts only, drop `'unsafe-eval'`, and audit which libraries the agent actually relies on. See §9.2.

### 4.3 The View's runtime behavior

```ts
import { App, applyDocumentTheme, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";

const root = document.getElementById("root")!;
const app  = new App({ name: "OpenGenUI Viewer", version: "0.1.0" }, {});
let widgetFrame: HTMLIFrameElement | null = null;
let currentTheme: "light" | "dark" = "light";

function pushThemeToWidget() {
  widgetFrame?.contentWindow?.postMessage({ type: "set-theme", theme: currentTheme }, "*");
}

app.onhostcontextchanged = (ctx) => {
  if (ctx.theme) { applyDocumentTheme(ctx.theme); currentTheme = ctx.theme; pushThemeToWidget(); }
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
};

app.ontoolresult = (result) => {
  if (result.isError) { renderError("Component generation failed", result.content?.[0]?.text); return; }
  const html = (result.structuredContent as { html?: string } | undefined)?.html;
  if (!html) { renderError("No html in tool result"); return; }
  renderInIframe(html);  // creates iframe with srcdoc=html; pushes theme on load
};

// Plus: ontoolinputpartial → show "Generating…" skeleton while agent streams.
// Plus: window message listener for 'widget-resize' events from the nested iframe.

await app.connect();
```

The View renders three states: **loading** (spinner with cycling loading phrases) before `ontoolresult`, **error** if the tool errors, **content** (a single `<iframe srcdoc=…>`) after a successful result. The View:

1. Listens for `widget-resize` postMessages from the nested iframe (the bridge JS in `assembleDocument` posts these) and adjusts the iframe height accordingly. Initial iframe height is **500px** so that `100vh` content inside has a reasonable starting viewport before the bridge reports back.
2. **Propagates the host theme** to the nested iframe via a `{type: "set-theme", theme: "light"|"dark"}` postMessage on iframe `load` and on every `onhostcontextchanged`. The inner BRIDGE_JS sets `documentElement.dataset.theme` and `style.colorScheme` accordingly. Without this the inner iframe falls back to `prefers-color-scheme` (the OS preference), which often mismatches the host theme (e.g. VS Code in dark mode but OS in light mode). The inner CSS pairs `@media (prefers-color-scheme: dark)` with a `:root[data-theme="dark"]` block carrying the same variables, so either signal works.

## 5. Agent integration

### 5.1 Protocol — AG-UI

The agent (`OpenGenerativeUI/apps/agent/main.py`) is mounted via `ag_ui_langgraph.add_langgraph_fastapi_endpoint(..., path="/")` with a `LangGraphAGUIAgent` wrapper. That mounts a **standard AG-UI HTTP endpoint** at `http://localhost:8123/`. The right client is therefore the official AG-UI JS SDK:

- **`@ag-ui/client`** — provides `HttpAgent`, a ready-to-use HTTP+SSE client that consumes the AG-UI wire format and emits typed events (`TextMessageStart`/`Content`/`End`, `ToolCallStart`/`Args`/`End`, lifecycle events, state events).
- **`@ag-ui/core`** — type definitions (`RunAgentInput`, `Message`, event types).

```ts
import { HttpAgent } from "@ag-ui/client";

const agent = new HttpAgent({
  url: process.env.AGENT_URL ?? "http://localhost:8123/",
  // No headers — the agent has no auth.
});
```

Considered and rejected:

| Alternative | Why not |
| --- | --- |
| `@langchain/langgraph-sdk` Client | Speaks the LangGraph platform API (threads/runs/checkpoints); we'd have to re-derive AG-UI semantics from raw LangGraph events. Wrong abstraction layer for this server. |
| `@copilotkit/runtime` `LangGraphHttpAgent` | Heavy: drags all of CopilotKit's runtime into our MCP server for a client we can do in `@ag-ui/client`. |
| Raw `fetch` + SSE parsing | Reimplements protocol details that change between AG-UI versions. |

### 5.2 Event stream → widget payload extraction

AG-UI streams tool calls in four events per call (per the [event spec](https://docs.ag-ui.com/concepts/events) and the installed `@ag-ui/core` type definitions):

| Event             | Payload                                                                |
| ----------------- | ---------------------------------------------------------------------- |
| `TOOL_CALL_START` | `{ toolCallId, toolCallName, parentMessageId? }`                       |
| `TOOL_CALL_ARGS`  | `{ toolCallId, delta }` — JSON fragments concatenated client-side      |
| `TOOL_CALL_END`   | `{ toolCallId }`                                                       |
| `TOOL_CALL_RESULT`| `{ toolCallId, messageId, content, role? }` — backend tool result text |

The `@ag-ui/client` `AgentSubscriber` exposes typed per-event hooks that buffer args and parse JSON for us — we don't accumulate `delta` strings manually. In particular `onToolCallEndEvent` receives a `toolCallArgs: Record<string, any>` already parsed.

#### 5.2.1 The widgetRenderer-is-a-frontend-tool insight

In OpenGenerativeUI's Next.js frontend, `widgetRenderer` is registered via CopilotKit's `useComponent({ name: "widgetRenderer", ... })`. CopilotKit's middleware **injects components-registered-as-tools into the agent's tool list at runtime**, so the agent sees `widgetRenderer` as a callable tool and emits real `TOOL_CALL_*` events for it.

When our MCP server connects directly via AG-UI we bypass CopilotKit's middleware, so by default the agent doesn't see `widgetRenderer` in its tool list. The observed failure modes when the tool is absent:

- Agent says "I can't use `widgetRenderer` here because it isn't available in this session's toolset" and falls back to plain HTML in text.
- Agent emits a `task(subagent_type="general-purpose", ...)` sub-agent dispatch whose `TOOL_CALL_RESULT.content` is the JSON-serialised `{title, description, html}`.
- Agent inlines the payload as a markdown fenced \`\`\`widgetRenderer block.
- Agent emits a JSX-style `<widgetRenderer title="..." html='...' />` invocation in text.

The fix is to **advertise `widgetRenderer` ourselves** via AG-UI's `tools` parameter on `runAgent` — replicating what CopilotKit's middleware does. Then the agent calls it as a real tool.

#### 5.2.2 Primary capture path: TOOL_CALL_END for advertised widgetRenderer

**This is the canonical, correct approach.** It mirrors exactly what CopilotKit's own middleware does for the OpenGenerativeUI Next.js frontend — surface `widgetRenderer` as a tool the agent can call, then capture its arguments when it does. With this in place the agent emits a clean, single `widgetRenderer` tool call with parsed `{title, description, html}` args, no text-parsing tricks required.

```ts
// Tool name, description, and parameter descriptions are copied verbatim from
// OpenGenerativeUI/apps/app/src/hooks/use-generative-ui-examples.tsx
// and apps/app/src/components/generative-ui/widget-renderer.tsx so the agent
// gets the same framing as in the production frontend.
const WIDGET_RENDERER_TOOL = {
  name: "widgetRenderer",
  description:
    "Renders interactive HTML/SVG visualizations in a sandboxed iframe. " +
    "Use for algorithm visualizations, diagrams, interactive widgets, " +
    "simulations, math plots, and any visual explanation.",
  parameters: {
    type: "object",
    properties: {
      title:       { type: "string", description: "Short title for the visualization..." },
      description: { type: "string", description: "One-sentence explanation..." },
      html:        { type: "string", description: "Self-contained HTML fragment... " +
                       "IMPORTANT: do not use viewport-relative units (`100vh`/`100dvh` etc.) ..." },
    },
    required: ["title", "description", "html"],
  },
};

await agent.runAgent(
  { runId: randomUUID(), abortController: abort, tools: [WIDGET_RENDERER_TOOL] },
  {
    onToolCallStartEvent: ({ event }) => {
      if (event.toolCallName === "pieChart" || event.toolCallName === "barChart") pieOrBarSeen = true;
    },
    onToolCallEndEvent: ({ toolCallName, toolCallArgs }) => {
      if (toolCallName === "widgetRenderer" && typeof toolCallArgs.html === "string") {
        captured.push({ widget: { ...toolCallArgs }, source: "tool_call:widgetRenderer" });
      }
    },
    // ... onTextMessageStart/End, onToolCallResult also wired up — see §5.2.3.
  },
);
```

The html parameter description includes an explicit `IMPORTANT: do not use viewport-relative units (100vh, 100dvh, 100svh, 100vmin)` clause because the rendered iframe is sized to content, not full-screen, and `100vh` content collapses in a sized container.

#### 5.2.3 Legacy fallback: assistant-text scanning (probably no longer needed, kept as a safety net)

Before we discovered the frontend-tool-advertisement path (§5.2.1), we observed the agent inlining the widget payload in assistant text in several variants. We implemented text scanners to recover the payload from those variants. **With `widgetRenderer` properly advertised those variants effectively don't occur** — the agent uses the tool call cleanly. The scanners are **retained as defense-in-depth** but are expected to be dead code in normal operation; removing them entirely is a reasonable cleanup once we've accumulated enough live-traffic logs to confirm they never fire.

If the primary path produces nothing, we scan accumulated assistant texts for any of three surfaces:

| # | Surface                              | Example                                                     |
| - | ------------------------------------ | ----------------------------------------------------------- |
| 1 | Raw JSON                             | `{ "title":"...", "description":"...", "html":"..." }`      |
| 2 | Fenced markdown block                | \`\`\`widgetRenderer\n{ ... }\n\`\`\`                       |
| 3 | JSX-style tag                        | `<widgetRenderer title="..." html='<div>...</div>' />`      |

Surfaces (1) and (2) reduce to a brace-balanced JSON walker followed by the shape check. Surface (3) needs an attribute parser with string-literal-aware tag-end detection, and explicitly **rejects** templates like `html='$(function.task.html)'` so an unresolved placeholder doesn't masquerade as success.

The shape check (`tryCapture`) and walkers (`tryCaptureFromJson`, `tryCaptureFromWidgetTag`) live in `src/agent-client.ts`. Last-match wins, matching §4.1's "use the last widgetRenderer call".

When this fallback path fires, the structured log records `source: "assistant_text[N]"` instead of `tool_call:widgetRenderer` — a signal that something pushed the agent off the canonical path and worth investigating. Assistant text is also captured for inclusion in the no-widget error message (see §4.1) so end-user-visible failures remain self-diagnosing.

#### 5.2.4 Chart-path detection

`pieChart` / `barChart` are still surfaced as `TOOL_CALL_START` events even though we don't advertise them as tools — the agent's underlying convention emits them when chart-shaped output is the chosen path. We watch `onToolCallStartEvent` and, if no widget is captured by the end of the run, return the chart-not-supported error from §4.1.

#### 5.2.5 SDK shape (verified)

Verified against installed `@ag-ui/client@0.0.53`:

- `threadId`, `initialMessages`, `initialState` are passed to `new HttpAgent({...})` at construction — NOT to `runAgent`. `RunHttpAgentConfig` accepts `{ runId?, tools?, context?, forwardedProps?, abortController? }`.
- `Message` requires `{ id, role, content }`. The `id` is a `z.ZodString`, not optional.
- `ToolSchema` is `{ name: string; description: string; parameters: any; metadata?: Record<string, any> }`. `parameters` is a JSON-Schema-compatible object.
- Typed subscriber hooks provide already-buffered/parsed values — `onToolCallEndEvent`'s `toolCallArgs` is pre-parsed; `onTextMessageEndEvent` provides the full `textMessageBuffer`.

### 5.3 Prompt shaping

The agent's system prompt allows it to answer with plain text *or* call `widgetRenderer` / `pieChart` / `barChart`. For the MCP tool we **must** get back HTML. Two mechanisms cooperate:

1. **Tool advertisement** (primary, §5.2.1) — pass `tools: [WIDGET_RENDERER_TOOL]` so the agent sees `widgetRenderer` in its tool list and treats it as the canonical render path.
2. **User-role prompt wrapper** — we still wrap the user's `description` to nudge the agent toward the visual path:

   ```
   Render the following as an interactive HTML/SVG/JS component using the
   widgetRenderer tool. Do not respond with plain text only. Description:

   <user description here>
   ```

The agent's MANDATORY workflow already requires `plan_visualization` → `widgetRenderer`; tool advertisement + prompt shaping together get a real `widgetRenderer` tool call in the vast majority of runs. If the agent emits `pieChart` or `barChart` instead, the MCP tool errors out with a hint to rephrase (see §9.3 and the §4.1 error table).

### 5.4 Stateless threads

Generate a fresh `threadId` and `runId` per tool call (`crypto.randomUUID()`). Reasons:

- Each `generate_ui_component(description)` call is independent.
- Agent uses `BoundedMemorySaver(max_threads=200)` so threads are FIFO-evicted anyway.
- Stateless avoids cross-call contamination ("but you said earlier…").

### 5.5 Tool call handling

With `widgetRenderer` advertised (§5.2.1), the agent's typical tool-call sequence per request is `plan_visualization` → `widgetRenderer`. We consume the latter; the others below are observed but unused.

| Tool                            | What the agent emits                                       | Handling                                                                                                                                                            |
| ------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `widgetRenderer`                | `{title, description, html}`                               | **Primary path.** Captured via `onToolCallEndEvent` with `toolCallName === "widgetRenderer"`. Source: `tool_call:widgetRenderer`.                                   |
| `plan_visualization`            | `{approach, technology, key_elements[]}`                   | Silently ignored. A "while-you-wait" UX card in the Next.js frontend; redundant in our after-the-fact MCP App view.                                                 |
| `query_data`                    | Returns CSV from the agent's `db.csv`                      | Silently ignored. Pure agent-internal data fetch.                                                                                                                   |
| `manage_todos` / `get_todos`    | Todo state mutations                                       | Silently ignored. Legacy state from an earlier demo iteration.                                                                                                      |
| `generate_form`                 | A2UI component tree                                        | Silently ignored. Separate `@ag-ui/a2ui-middleware` rendering pipeline; out of scope for v1.                                                                        |
| `task`                          | `{subagent_type, description}` (deep-agents sub-agent dispatch) | **Fallback path.** Mostly unused now that widgetRenderer is advertised, but if the agent does dispatch a sub-agent, its `TOOL_CALL_RESULT.content` is run through the same shape check as assistant text — so a widget payload can still be recovered. |
| `pieChart` / `barChart`         | Chart-shape data                                           | Detected via `onToolCallStartEvent`; if no widget is captured by end-of-run, the MCP tool errors with the §9.3 chart-not-supported message.                         |

If we later want to surface the plan, the minimal change is to capture `plan_visualization` args and pass them to the View via `structuredContent.plan` for a small header card above the widget iframe (~30 lines total).

## 6. Project layout

```
OpenGenUIMCP/
├── package.json
├── tsconfig.json              # for the View bundle (DOM lib, no emit)
├── tsconfig.server.json       # for the server (Node lib, no emit; tsx runs .ts directly)
├── vite.config.ts             # bundles mcp-app.html → dist/mcp-app.html (single file)
├── server.ts                  # createServer(): tool + resource registration
├── main.ts                    # entry point: HTTP or --stdio transport + stray-rejection guard
├── mcp-app.html               # View entry
├── probe.ts                   # one-shot AG-UI diagnostic script (npm run probe)
├── src/
│   ├── mcp-app.ts             # View runtime (App class, ontoolresult, iframe injection, theme push)
│   ├── agent-client.ts        # @ag-ui/client HttpAgent wrapper, widgetRenderer tool advertisement,
│   │                          #   primary capture + text fallback, AgentError mapping
│   ├── assemble-document.ts   # FORK of OpenGenerativeUI/apps/mcp/src/renderer.ts
│   │                          #   (extended: importmap, [data-theme="dark"], alias vars,
│   │                          #    theme-message bridge, multi-source height measurement)
│   └── logger.ts              # per-call structured logger (one JSONL file per tool call)
├── dist/                      # built View bundle (gitignored)
├── logs/                      # per-call JSONL run logs (gitignored)
└── README.md
```

### 6.1 Dependencies

Server: `@modelcontextprotocol/ext-apps`, `@modelcontextprotocol/sdk`, `@ag-ui/client`, `@ag-ui/core`, `express`, `cors`, `zod`.
View: `@modelcontextprotocol/ext-apps`.
Dev: `typescript`, `vite`, `vite-plugin-singlefile`, `tsx`, `concurrently`, `cross-env`, `@types/express`, `@types/cors`, `@types/node`.

All installed via `npm install` (no version-pinning from memory — per `create-mcp-app` skill guidance).

### 6.2 Transports

Match the OpenGenerativeUI MCP server: dual transport from a single `main.ts`.

- Default: Streamable HTTP on `PORT=3101` (avoid clashing with the existing OpenGenerativeUI MCP server on 3100). Endpoint `/mcp`. CORS open (no auth).
- `--stdio` flag: stdio transport for Claude Desktop config.

### 6.3 Configuration

| Env var          | Default                  | Purpose                                         |
| ---------------- | ------------------------ | ----------------------------------------------- |
| `PORT`           | `3101`                   | HTTP port                                       |
| `AGENT_URL`      | `http://localhost:8123/` | AG-UI agent base URL (note trailing slash)      |
| `AGENT_TIMEOUT_MS` | `120000`               | Max time to wait for a `widgetRenderer` call    |

### 6.4 Sharing `assembleDocument` with OpenGenerativeUI

The agent's HTML output requires the design-system shell (theme CSS variables, SVG color classes, form styles, bridge JS) that `OpenGenerativeUI/apps/mcp/src/renderer.ts` already produces. We have three options:

| Option | Trade-off |
| --- | --- |
| **A.** Fork `renderer.ts` into this repo | Simple; this project stays self-contained; risks drift if the OpenGenerativeUI design system changes |
| **B.** Add OpenGenerativeUI MCP as a workspace dep | Tight coupling; requires reaching across repos |
| **C.** Publish `@open-generative-ui/design-system` as a small package | Clean; over-engineered for the current scope |

Locked in as **A** (see §9.4): copy `renderer.ts` into `src/assemble-document.ts` with a header comment pointing back at the source.

## 7. Lifecycle: a complete tool call

1. Host calls `tools/call` with `{ name: "generate_ui_component", arguments: { description: "binary search visualization" } }`.
2. Server hands the host the View's resource URI via `_meta.ui.resourceUri`; host renders the bundled `viewer.html` in a sandboxed iframe.
3. Server starts the tool handler in parallel:
   1. Opens a per-call structured log (`logs/<ts>_<runId>.jsonl`).
   2. Instantiates `HttpAgent` with a fresh `threadId` and the shaped prompt in `initialMessages`.
   3. Calls `runAgent({ runId, abortController, tools: [WIDGET_RENDERER_TOOL] })` with a typed `AgentSubscriber`.
   4. **Primary capture (§5.2.2)**: in `onToolCallEndEvent`, when `toolCallName === "widgetRenderer"`, capture the parsed `toolCallArgs` as the widget payload. In `onToolCallStartEvent`, watches for `pieChart`/`barChart` to detect the chart-path error condition. Keeps the **last** captured `{title, description, html}`.
   5. **Fallback (§5.2.3)**: if no `widgetRenderer` tool call arrived, scan accumulated assistant texts for the three legacy surfaces. Records `source` (e.g. `tool_call:widgetRenderer` vs. `assistant_text[N]`) in the log.
   6. Wraps `html` with `assembleDocument()` to produce a self-contained HTML document.
   7. Closes the log with `{ok, widget|error}`.
4. Server returns the tool result with `content` + `structuredContent`.
5. Host forwards the result to the View via `ui/notifications/tool-result`.
6. View's `ontoolresult` reads `structuredContent.html` and injects it into `<iframe srcdoc=…>`.
7. View posts `{type: "set-theme", theme}` to the nested iframe on its `load` event (§4.3).
8. Nested iframe's bridge JS sets `data-theme` on its documentElement and posts `widget-resize` messages back. View sizes the iframe (initial 500px, then grown/shrunk to match content via the multi-source measurement in `assemble-document.ts`).

## 8. Testing strategy

- **Local smoke test**: run the OpenGenerativeUI agent (`make dev-agent` in `OpenGenerativeUI/`), run the MCP server, and use `basic-host` (cloned from `https://github.com/modelcontextprotocol/ext-apps`, then `cd examples/basic-host`) to call the tool with representative descriptions ("an interactive binary search visualization", "a 3D rotating cube using Three.js", "an SVG diagram of TCP handshake"). Clone destination is left to the developer (Windows-friendly path, e.g., `C:\Sandboxes\ext-apps`).
- **Manual coverage**: verify each error mode from §4.1 (kill the agent → "not reachable"; send a description that triggers a text-only response → "no UI produced"; send a "pie chart of X" → confirm explicit pieChart error from §9.3).
- **No unit test framework** matches the rest of the OpenGenUI repo. Skip for now.

## 9. Decisions log

All design questions resolved. §9.1 is "verify at the keyboard" — its answer determines a few field names in §5.2's code sample but doesn't gate the design. Implementation can begin.

### 9.1 AG-UI event-type casing, field names, and widgetRenderer reality — RESOLVED

Verified against installed `@ag-ui/client@0.0.53` plus multiple live fixtures captured under both with/without-tool-advertisement conditions. Findings:

- **Enum casing**: SCREAMING_SNAKE (`TOOL_CALL_START`, `TOOL_CALL_ARGS`, `TOOL_CALL_END`, `TOOL_CALL_RESULT`).
- **Field names**: `toolCallId`, `toolCallName`, `delta`, `content` — as documented.
- **HttpAgent shape**: `threadId` / `initialMessages` go to the constructor; `runAgent` accepts only `{ runId?, tools?, context?, forwardedProps?, abortController? }`.
- **Typed subscriber hooks** (`onToolCallEndEvent`, `onToolCallResultEvent`, `onTextMessageEndEvent`) provide pre-parsed `toolCallArgs`, raw `content`, and pre-buffered `textMessageBuffer` — no manual delta concatenation.
- **Behavioral finding (initial)**: without `widgetRenderer` advertised, the agent inlines the payload in assistant text or routes through a `task` sub-agent dispatch — `widgetRenderer` did **not** appear as a `TOOL_CALL_*` event in the first fixture.
- **Behavioral finding (corrected)**: this is because CopilotKit's middleware (which we bypass) is what advertises `widgetRenderer` to the agent in the Next.js frontend. When we pass `tools: [WIDGET_RENDERER_TOOL]` to `runAgent`, the agent calls `widgetRenderer` as a real tool and emits the expected events with parsed args. This is the canonical path; see §5.2.1 and §9.7.

### 9.2 CSP boundaries — RESOLVED: maximally permissive

Decision: declare a wide-open `_meta.ui.csp` (allow inline + eval, `https:`, and explicit CDN `resourceDomains`) and use a matching permissive `<meta CSP>` inside the nested `srcdoc` document. See §4.2 for the exact policy. This is acceptable because the server is local-only, has no auth, and runs unaudited agent-generated JS regardless of CSP strictness.

The only verification step still required: load a three.js example through basic-host once during implementation to confirm that the host honors our declared CSP (some hosts may impose additional sandbox attributes on the outer iframe that we can't override from the server side). If three.js fails to load, the workaround is to inline the libs into `assembleDocument` instead of pulling from CDNs.

### 9.3 What if the agent picks a non-widgetRenderer tool? — RESOLVED: error out

Decision: when the agent emits `pieChart` or `barChart` (structured data, not HTML), the tool returns an explicit error (see §4.1 error table) directing the caller to rephrase. We still prompt-shape the user's description toward `widgetRenderer` (§5.3) as a first-line mitigation, but we don't synthesize HTML from chart data server-side.

Rationale: server-side chart synthesis would be ~30 lines and modestly useful, but it adds a parallel rendering path with its own failure modes (Chart.js compatibility, theme handling) for a case the agent should mostly avoid given proper prompt shaping. Keeping the tool single-purpose ("widgetRenderer in, HTML out") is simpler and lets us see in practice how often the agent escapes the prompt shaping. If it turns out to happen often, revisit and add chart synthesis as a follow-up.

### 9.4 Design-system fork vs. shared — RESOLVED: fork

Decision: option **A** in §6.4 — copy `renderer.ts` into `src/assemble-document.ts` with a header comment pointing back at the OpenGenerativeUI source. Rationale: one ~350-line file of static CSS + bridge JS, near-zero churn, and the two MCP servers share no other code. Revisit only if the design system starts changing weekly or a third consumer appears.

### 9.5 Should the View be interactive beyond rendering? — RESOLVED: no

Decision: skip for v1. The View is a passive renderer: loading state → result (nested iframe with the agent's HTML) → error state. No "Regenerate" button, no description echo, no client-side state to track. Revisit if real usage suggests it's worth the added complexity.

### 9.6 Naming — RESOLVED

- **Tool name**: `generate_ui_component` (confirmed).
- **Server name**: `opengen-ui-mcp` (proposed default; change later if needed).
- **Resource URI**: `ui://opengen/viewer.html` (proposed default; change later if needed).

### 9.7 widgetRenderer advertised as a client-side AG-UI tool — RESOLVED

Decision: pass `tools: [WIDGET_RENDERER_TOOL]` to `runAgent`, with the tool's `name`, `description`, and parameter descriptions copied verbatim from CopilotKit's `useComponent` registration in `apps/app/src/hooks/use-generative-ui-examples.tsx` and `widget-renderer.tsx`.

Rationale: this replicates what CopilotKit's middleware does for the Next.js frontend. Without it the agent doesn't see `widgetRenderer` in its tool list, refuses ("I can't use widgetRenderer here") or falls back to inline-JSON/fenced-block/JSX-tag workarounds in assistant text. With it, the agent emits clean `TOOL_CALL_START/ARGS/END` events for `widgetRenderer` with parsed args — exactly what we want. The legacy text-fallback scanners (§5.2.3) are retained as defense-in-depth but expected to be dead code in normal operation.

Verbatim copy of names and descriptions matters: keeps the agent's framing identical to the production frontend, so behavior is consistent.

### 9.8 Per-call structured logging — RESOLVED

Decision: write one JSONL log file per `generate_ui_component` call to `logs/<ISO-timestamp>_<runId-prefix>.jsonl`. Mirror a compact summary line to stderr for live monitoring. Implemented in `src/logger.ts`, hooked into `agent-client.ts`.

Captured per call: shaped prompt, every AG-UI event (with `TEXT_MESSAGE_CONTENT` and `RAW` suppressed for volume — full text is logged once via `TEXT_MESSAGE_END`'s `textMessageBuffer`), every tool call's args + result, every text-extraction attempt with verdict, final extraction summary (which path captured the widget, source-tagged as `tool_call:widgetRenderer` vs. `assistant_text[N]`), and call outcome (`ok: true|false` + widget/error).

Rationale: agent behavior varies enough run-to-run that without per-call logs, "it didn't work" is unactionable. With logs we can answer "did the agent call widgetRenderer?", "did it fall back to text?", "how long did the model step take?", "did pieChart/barChart appear?", "did the agent emit malformed step events?" — all from a single file we can grep or `jq`.

The `logs/` directory is gitignored. No retention policy; manual cleanup.

### 9.9 Host theme propagation to the nested iframe — RESOLVED

Decision: forward the MCP host's theme (light/dark) from the View into the nested `srcdoc` iframe via `postMessage({type: "set-theme", theme})`. The inner BRIDGE_JS sets `documentElement.dataset.theme` and `style.colorScheme` in response. Inner CSS carries a `:root[data-theme="dark"]` block alongside the existing `@media (prefers-color-scheme: dark)`, so either signal works.

Rationale: the inner iframe is a separate document — `applyDocumentTheme` on the View's document doesn't reach it. Without explicit propagation the inner iframe queries the OS via `prefers-color-scheme`, which often mismatches the host theme (classic case: VS Code in dark mode but OS in light mode → unreadable light-on-light widget).

Also added: alias CSS variables (`--color-bg-surface`, `--color-surface`, `--color-fg`, `--color-bg`, `--color-background`) that resolve to the design system's primary variables. The agent sometimes invents these and references them with fallbacks like `var(--color-bg-surface, white)`; the aliases make those resolve to theme-correct values rather than literal `white`.

### 9.10 Height measurement and 100vh content — RESOLVED

Decision (three parts):

1. **Tool description nudges the agent away from viewport-relative units** (`100vh`/`100dvh`/`100svh`/`100vmin`) — the html parameter's description spells this out. The widget is rendered in a sized container, not full-screen.
2. **Inner iframe initial height is 500px** (not 300px), so any residual `100vh` content has a reasonable starting viewport before the bridge reports back.
3. **Bridge measurement uses the max of five sources** — `content.offsetHeight`, `content.scrollHeight`, a clone-with-auto-height `scrollHeight` (the React widget-renderer's trick), `document.body.scrollHeight`, and `document.documentElement.scrollHeight`. Robust to flow layouts, absolute positioning, and intrinsic-fill content mixed together.

Rationale: even with prompt guidance the agent occasionally still emits viewport-relative sizing. Defense-in-depth on the measurement side means a single misbehaving widget doesn't get rendered at 0px.

## 10. Out-of-spec but worth noting

- **Self-hosting the agent**: currently the user must run the OpenGenerativeUI agent themselves at `:8123`. No auto-start. The README should call this out.
- **Strong-model requirement**: the agent README warns that weak models produce broken visualizations. The MCP server inherits this. We should surface it in our README and possibly in the tool description (so the calling model has context for why a "failed" generation may have happened).
- **Transient agent protocol errors**: occasionally the LangGraph deep-agent emits `"Cannot send 'STEP_FINISHED' for step \"model\" that was not started"` (an AG-UI middleware invariant violation from the Python side). Observed to happen in clusters once the agent's state gets corrupted, with the only known remedy being to restart the agent (`make dev-agent`). Not fixable from the MCP server side; surface the agent's error text to the host so the user knows to retry / restart.
- **Stray AG-UI socket errors after `runAgent` resolves**: undici sometimes emits an uncaught `UND_ERR_SOCKET` / `terminated` rejection after our `await runAgent(...)` has already returned and our try/catch has mapped the real result. Handled by an `unhandledRejection` listener in `main.ts` that recognises and logs (rather than crashes the process on) these stray rejections.
- **Long generations vs. host tool-call timeouts**: complex prompts (large, multi-section UIs) can take 100+ seconds end-to-end. Some hosts cap a single tool call at less than that and will give up before the response arrives, leaving the user with "nothing happened" while the server-side log shows a successful capture. A future improvement would be to stream progress to the host (e.g. `ontoolinputpartial` updates with progress text) so the host knows to keep waiting.
- **Bundled in-browser libraries vs. CDNs**: the agent's HTML uses an import map for `three`/`gsap`/`d3`/`chart.js` resolved against `https://esm.sh`. If any host imposes a stricter CSP that blocks those CDNs, the workaround is to inline the libraries into `assembleDocument` instead of pulling from CDNs (~hundreds of KB added to every widget, but no external network deps). See §9.2.
