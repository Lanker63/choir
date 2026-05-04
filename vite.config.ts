import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  build: {
    outDir: "media",
    emptyOutDir: false,
    sourcemap: false,
    target: "es2020",
    chunkSizeWarningLimit: 3000,
    cssCodeSplit: false,
    rollupOptions: {
      input: "src/webview/main.ts",
      output: {
        format: "es",
        entryFileNames: "app.bundle.js",
        chunkFileNames: "assets/chunks/[name]-[hash].js",
        manualChunks: (id) => {
          if (id.includes("monaco-yaml")) {
            return "vendor-monaco-yaml";
          }

          if (id.includes("monaco-editor")) {
            return "vendor-monaco";
          }

          if (id.includes("node_modules")) {
            return "vendor";
          }

          return undefined;
        },
        assetFileNames: (assetInfo) => {
          if (assetInfo.name === "style.css") {
            return "app.css";
          }

          return "assets/[name][extname]";
        },
      },
    },
  },
  worker: {
    format: "es",
    rollupOptions: {
      output: {
        entryFileNames: "workers/[name].worker.js",
        chunkFileNames: "workers/[name].worker.js",
        assetFileNames: "workers/[name][extname]",
      },
    },
  },
});
