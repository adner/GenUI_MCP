/**
 * MCP server for OpenGenUI: one tool (`generate_ui_component`) + one
 * UI resource (`ui://opengen/viewer.html`).
 *
 * The viewer HTML is the Vite single-file build output of `mcp-app.html` —
 * loaded from disk on resource-read. The tool runs the agent, wraps the
 * returned HTML with the design-system shell, and returns it as
 * `structuredContent.html` for the View to drop into a nested srcdoc iframe.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import * as z from "zod";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { assembleDocument } from "./src/assemble-document.js";
import { generateWidget, AgentError } from "./src/agent-client.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const VIEWER_HTML_PATH = resolve(HERE, "dist/mcp-app.html");
const VIEWER_URI = "ui://opengen/viewer.html";

const AGENT_URL = process.env.AGENT_URL ?? "http://localhost:8123/";
const AGENT_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS) || 120_000;

export function createServer(): McpServer {
  const server = new McpServer({
    name: "opengen-ui-mcp",
    version: "0.1.0",
  });

  registerAppTool(
    server,
    "generate_ui_component",
    {
      title: "Generate UI Component",
      description:
        "Generate an interactive HTML/JS UI component from a natural-language description. " +
        "Calls the OpenGenerativeUI agent (a LangChain Deep Agent) to produce the HTML and " +
        "returns it as an MCP App view. Best results require a strong model on the agent side " +
        "(gpt-5.4 / claude-opus-4-6 / gemini-3.1-pro); weak models produce broken visualizations.",
      inputSchema: {
        description: z
          .string()
          .min(1)
          .describe(
            "Natural-language description of the UI component to generate, " +
              "e.g., 'an interactive SVG visualization of binary search on a sorted array' " +
              "or 'a 3D rotating cube using three.js with controls for size and color'.",
          ),
      },
      _meta: { ui: { resourceUri: VIEWER_URI } },
    },
    async ({ description }) => {
      try {
        const widget = await generateWidget({
          agentUrl: AGENT_URL,
          description,
          timeoutMs: AGENT_TIMEOUT_MS,
        });
        const html = assembleDocument(widget.html);
        return {
          content: [
            {
              type: "text",
              text:
                `Generated UI component: ${widget.title}\n${widget.description}`,
            },
          ],
          structuredContent: {
            title: widget.title,
            description: widget.description,
            html,
          },
        };
      } catch (err) {
        const message =
          err instanceof AgentError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        return {
          isError: true,
          content: [{ type: "text", text: message }],
        };
      }
    },
  );

  registerAppResource(
    server,
    "OpenGenUI Viewer",
    VIEWER_URI,
    {
      description:
        "Renders the HTML/JS component produced by `generate_ui_component` " +
        "inside a sandboxed iframe with the OpenGenerativeUI design system applied.",
    },
    async () => {
      const text = await readFile(VIEWER_HTML_PATH, "utf-8");
      return {
        contents: [
          {
            uri: VIEWER_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text,
            _meta: {
              ui: {
                csp: {
                  // The agent's HTML loads three / gsap / d3 / chart.js from these
                  // CDNs. Domain allowlists are all the server can declare; the host
                  // applies its own script-src / style-src defaults on top. The inner
                  // <iframe srcdoc> additionally carries its own <meta http-equiv CSP>
                  // (set in assembleDocument()) which mirrors this list.
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
                },
              },
            },
          },
        ],
      };
    },
  );

  return server;
}
