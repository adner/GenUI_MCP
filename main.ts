/**
 * Entry point. Default = Streamable HTTP on PORT (3101 by default).
 * Pass `--stdio` to run on stdio for Claude Desktop or other stdio hosts.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import { createServer } from "./server.js";

const useStdio = process.argv.includes("--stdio");
const PORT = Number(process.env.PORT) || 3101;

// The @ag-ui/client SSE stream sometimes emits late socket-close errors
// (undici UND_ERR_SOCKET) AFTER our `await runAgent(...)` has returned and
// our try/catch has already mapped any real error. Letting these crash the
// whole server is wrong — they're orphaned cleanup noise, not tool failures.
// Log and continue.
process.on("unhandledRejection", (reason) => {
  const r = reason as { name?: unknown; code?: unknown; message?: unknown };
  const isStraySocketError =
    (typeof r?.name === "string" && r.name === "TypeError" &&
      typeof r?.message === "string" && r.message === "terminated") ||
    (typeof r?.code === "string" &&
      (r.code === "UND_ERR_SOCKET" || r.code === "UND_ERR_CONNECT_TIMEOUT"));
  if (isStraySocketError) {
    console.error("[opengen-ui-mcp] ignoring stray AG-UI socket error:", r?.message ?? r);
    return;
  }
  console.error("[opengen-ui-mcp] unhandledRejection:", reason);
});

async function main() {
  const server = createServer();

  if (useStdio) {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    return;
  }

  const transports = new Map<string, StreamableHTTPServerTransport>();
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use(
    cors({
      origin: "*",
      methods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowedHeaders: [
        "Content-Type",
        "mcp-session-id",
        "Last-Event-ID",
        "mcp-protocol-version",
      ],
      exposedHeaders: ["mcp-session-id", "mcp-protocol-version"],
    }),
  );

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.all("/mcp", async (req, res) => {
    const sessionId = req.header("mcp-session-id");
    let transport = sessionId ? transports.get(sessionId) : undefined;

    if (!transport) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });
      transport.onclose = () => {
        const sid = transport!.sessionId;
        if (sid) transports.delete(sid);
      };
      // Per-transport McpServer keeps tool registration isolated and matches
      // the example pattern; createServer() is cheap (no I/O at construction).
      const mcp = createServer();
      await mcp.connect(transport);
    }

    await transport.handleRequest(req, res, req.body);
    const sid = transport.sessionId;
    if (sid && !transports.has(sid)) transports.set(sid, transport);
  });

  app.listen(PORT, () => {
    console.error(
      `opengen-ui-mcp listening on http://localhost:${PORT}/mcp (health: /health)`,
    );
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
