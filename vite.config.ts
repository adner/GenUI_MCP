import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// Bundles mcp-app.html (with its <script type="module" src="/src/mcp-app.ts">)
// into a single self-contained HTML file at dist/mcp-app.html. That file is
// then read at runtime by registerAppResource() and served as the
// ui://opengen/viewer.html resource.
export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    outDir: "dist",
    emptyOutDir: false,
    target: "es2022",
    rollupOptions: {
      input: "mcp-app.html",
    },
  },
});
