# OpenGenUI MCP

An **MCP Apps**-capable MCP server that turns a natural-language description into an interactive HTML/JS UI component, rendered in any compliant MCP host ([Microsoft 365 Copilot declarative agents](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/overview-declarative-agent), Claude Desktop, VS Code, basic-host).

The server exposes a single tool — `generate_ui_component(description)` — that drives the [OpenGenerativeUI](https://github.com/CopilotKit/OpenGenerativeUI) LangGraph deep agent over the [AG-UI](https://docs.ag-ui.com) protocol, captures the agent's `widgetRenderer` tool call, and serves the result as a sandboxed MCP App view.

> [!WARNING]
> **This is a tech demo, not an enterprise-ready product.** It deliberately ships with:
>
> - **Maximally permissive CSP** in the rendered iframe (`'unsafe-inline'`, `'unsafe-eval'`, several CDN domains) so the agent's arbitrary HTML/JS executes without friction.
> - **No authentication** on the HTTP transport — open to anything that can reach `localhost:3101`.
> - **No rate limiting, no input validation, no audit trail** beyond per-call debug logs.
> - **Execution of unaudited LLM-generated JavaScript** in the user's host (sandboxed in an iframe, but still arbitrary code).
>
> Do not deploy this as-is anywhere reachable from a network you don't control. Hardening for production would need (at minimum) authentication, a narrow CSP scoped to specific CDNs with `'unsafe-eval'` dropped, supply-chain review, and a careful look at how agent output flows into the host.

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

### Microsoft 365 Copilot declarative agents

Follow Microsoft's [Build agents with MCP](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/build-mcp-plugins) guide and point the declarative agent at `http://localhost:3101/mcp` (or wherever this server is reachable). This is the host the demo was built on — see the [LinkedIn post](https://www.linkedin.com/posts/andreasadner_microsoftcopilot-agui-copilotkit-ugcPost-7460401668283854850-wqmW).

### VS Code

Add the HTTP endpoint to `mcp.json`:

```json
{
  "servers": {
    "opengen-ui": { "type": "http", "url": "http://localhost:3101/mcp" }
  }
}
```

### Then

Ask the model to "show me a rotating triangle" / "an interactive binary search visualization" / etc.

## Logs

Every tool call writes a structured JSONL log to `logs/<timestamp>_<runId>.jsonl`. Useful when a generation looks wrong — the log records every AG-UI event, every assistant text, and which extraction path captured the widget (`tool_call:widgetRenderer` vs. the legacy `assistant_text[N]` fallback). See spec §9.8.
