# OpenGenUI MCP

An **MCP Apps**-capable MCP server that turns a natural-language description into an interactive HTML/JS UI component, rendered in any compliant MCP host ([Microsoft 365 Copilot declarative agents](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/overview-declarative-agent), Claude Desktop, VS Code, basic-host).

The server exposes a single tool — `generate_ui_component(description)` — that drives the [OpenGenerativeUI](https://github.com/CopilotKit/OpenGenerativeUI) LangGraph deep agent over the [AG-UI](https://docs.ag-ui.com) protocol, captures the agent's `widgetRenderer` tool call, and serves the result as a sandboxed MCP App view.

See [`spec.md`](./spec.md) for the full design, decisions log, and architecture diagram.

## Prerequisites

- Node.js 20+
- The OpenGenerativeUI agent running at `http://localhost:8123/`. From a clone of [`CopilotKit/OpenGenerativeUI`](https://github.com/CopilotKit/OpenGenerativeUI):

  ```bash
  make dev-agent
  ```

  The agent requires an `OPENAI_API_KEY` (or equivalent for whichever provider you configure) in `apps/agent/.env`. **Strong models only** — weak models produce broken visualizations (the agent's own README spells out which models are supported).

## Install, build, run

```bash
npm install
npm run build      # bundles the View into dist/mcp-app.html (single file)
npm run serve      # HTTP transport on http://localhost:3101/mcp
# or
npm run serve:stdio   # stdio transport for Claude Desktop
```

`npm run dev` runs Vite in watch mode plus tsx watching the server.

## Configuration

| Env var             | Default                    | Purpose                                       |
| ------------------- | -------------------------- | --------------------------------------------- |
| `PORT`              | `3101`                     | HTTP port                                     |
| `AGENT_URL`         | `http://localhost:8123/`   | AG-UI agent base URL                          |
| `AGENT_TIMEOUT_MS`  | `120000`                   | Max time to wait for a `widgetRenderer` call  |

## Connecting from an MCP host

Add the HTTP endpoint to the host's MCP server config. For VS Code's `mcp.json`:

```json
{
  "servers": {
    "opengen-ui": { "type": "http", "url": "http://localhost:3101/mcp" }
  }
}
```

Then ask the model to "show me a rotating triangle" / "an interactive binary search visualization" / etc.

## Logs

Every tool call writes a structured JSONL log to `logs/<timestamp>_<runId>.jsonl`. Useful when a generation looks wrong — the log records every AG-UI event, every assistant text, and which extraction path captured the widget (`tool_call:widgetRenderer` vs. the legacy `assistant_text[N]` fallback). See spec §9.8.
