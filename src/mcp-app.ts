/**
 * OpenGenUI Viewer — View runtime.
 *
 * Three render states:
 *   loading — before any toolresult / toolinputpartial arrives
 *   error   — if the server returns isError or structuredContent.html is missing
 *   content — a single nested <iframe srcdoc> containing the agent's HTML
 *
 * The nested iframe carries its own meta-CSP (set by assembleDocument on the
 * server) and posts `widget-resize` messages back here so we can match its
 * content height.
 */
import { App, applyDocumentTheme, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";

const root = document.getElementById("root")!;
let widgetFrame: HTMLIFrameElement | null = null;
let currentTheme: "light" | "dark" = "light";

function pushThemeToWidget() {
  if (!widgetFrame?.contentWindow) return;
  widgetFrame.contentWindow.postMessage(
    { type: "set-theme", theme: currentTheme },
    "*",
  );
}

const LOADING_PHRASES = [
  "Sketching pixels",
  "Wiring up nodes",
  "Painting gradients",
  "Compiling visuals",
  "Arranging atoms",
  "Rendering magic",
  "Polishing edges",
];

function renderLoading(initialMessage?: string) {
  let phraseIdx = 0;
  const span = document.createElement("span");
  span.textContent = initialMessage ?? LOADING_PHRASES[0] + "…";
  root.replaceChildren(
    Object.assign(document.createElement("div"), { className: "state-loading" }),
  );
  const container = root.firstElementChild!;
  const spinner = document.createElement("span");
  spinner.className = "spinner";
  container.appendChild(spinner);
  container.appendChild(span);

  const id = window.setInterval(() => {
    phraseIdx = (phraseIdx + 1) % LOADING_PHRASES.length;
    span.textContent = LOADING_PHRASES[phraseIdx] + "…";
  }, 1800);
  // Stop cycling once the next render replaces this DOM.
  const observer = new MutationObserver(() => {
    if (!root.contains(container)) {
      clearInterval(id);
      observer.disconnect();
    }
  });
  observer.observe(root, { childList: true });
}

function renderError(title: string, detail?: string) {
  const wrap = document.createElement("div");
  wrap.className = "state-error";
  const strong = document.createElement("strong");
  strong.textContent = title;
  wrap.appendChild(strong);
  if (detail) {
    const p = document.createElement("div");
    p.textContent = detail;
    wrap.appendChild(p);
  }
  root.replaceChildren(wrap);
  widgetFrame = null;
}

function renderInIframe(html: string) {
  const iframe = document.createElement("iframe");
  iframe.className = "widget-frame";
  // allow-same-origin is required for import maps inside srcdoc iframes
  // (see OpenGenerativeUI widget-renderer.tsx). No auth/session data is
  // present client-side, so this is acceptable.
  iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");
  // Initial height is what `100vh` inside the iframe resolves to before the
  // bridge reports back. 500px is a reasonable default for typical widgets;
  // the bridge then grows or shrinks via widget-resize messages.
  iframe.style.height = "500px";
  iframe.addEventListener("load", () => {
    pushThemeToWidget();
  });
  iframe.srcdoc = html;
  root.replaceChildren(iframe);
  widgetFrame = iframe;
}

window.addEventListener("message", (e) => {
  if (!widgetFrame || e.source !== widgetFrame.contentWindow) return;
  const data = e.data as { type?: string; height?: number } | null;
  if (!data || data.type !== "widget-resize" || typeof data.height !== "number") return;
  const h = Math.max(50, Math.min(data.height, 8000));
  widgetFrame.style.height = `${h}px`;
});

const app = new App({ name: "OpenGenUI Viewer", version: "0.1.0" }, {});

app.onhostcontextchanged = (ctx) => {
  if (ctx.theme) {
    applyDocumentTheme(ctx.theme);
    currentTheme = ctx.theme;
    pushThemeToWidget();
  }
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
};

app.ontoolinputpartial = () => {
  if (!widgetFrame) renderLoading();
};

app.ontoolresult = (result) => {
  if (result.isError) {
    const textBlock = (result.content ?? []).find((c) => c.type === "text") as
      | { type: "text"; text: string }
      | undefined;
    renderError(
      "Component generation failed",
      textBlock?.text ?? "The tool returned an error with no message.",
    );
    return;
  }
  const sc = result.structuredContent as { html?: unknown } | undefined;
  const html = sc && typeof sc.html === "string" ? sc.html : null;
  if (!html) {
    renderError(
      "No HTML in tool result",
      "The server returned a successful result but no `structuredContent.html` was present.",
    );
    return;
  }
  renderInIframe(html);
};

app.onteardown = async () => ({});

renderLoading("Waiting for the agent…");

void app.connect().then(() => {
  const ctx = app.getHostContext();
  if (ctx?.theme) {
    applyDocumentTheme(ctx.theme);
    currentTheme = ctx.theme;
    pushThemeToWidget();
  }
  if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
});
