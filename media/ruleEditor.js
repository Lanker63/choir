const vscode = acquireVsCodeApi();

function debounce(fn, wait = 300) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), wait);
  };
}

// Initialize Monaco when the AMD `require` loader is available. This handles
// cases where the loader hasn't executed yet (or was blocked) by dynamically
// injecting `loader.js` and waiting for it to load. This preserves the full
// Monaco experience instead of falling back to a simpler control.
function initMonacoOnceLoaded() {
  try {
    require.config({
      paths: {
        // This bundled Monaco layout has `editor/editor.main.js` at the root.
        // Map `vs/*` module ids directly to `MONACO_BASE/*`.
        vs: MONACO_BASE,
      },
    });

    setupMonacoEnvironment();
    ensureMonacoStyle();

    // Load core Monaco API directly to avoid broken bundled language
    // contribution modules while preserving full Monaco editor behavior.
    require(["vs/editor.api.001a2486"], async function (monaco) {
      try {
        // Try to load monaco-yaml diagnostics if available; it's optional.
        if (typeof HAS_MONACO_YAML !== "undefined" && HAS_MONACO_YAML) {
          try {
            const mod = await import(MONACO_BASE + "/../monaco-yaml/index.js");
            if (mod && typeof mod.setDiagnosticsOptions === "function") {
              mod.setDiagnosticsOptions({
                validate: true,
                schemas: [
                  {
                    uri: "choir://rule-schema.json",
                    fileMatch: ["*"],
                    schema: getSchema(),
                  },
                ],
              });
            }
          } catch (err) {
            console.warn("monaco-yaml failed to load, skipping schema diagnostics", err);
          }
        } else {
          console.info("monaco-yaml bundle not found, skipping schema diagnostics");
        }

        const editor = monaco.editor.create(document.getElementById("editor"), {
          value: getDefaultDSL(),
          language: hasYamlLanguage(monaco) ? "yaml" : "plaintext",
          theme: "vs-dark",
          automaticLayout: true,
        });

        const output = document.getElementById("output");
        const btn = document.getElementById("validateBtn");

        editor.onDidChangeModelContent(
          debounce(() => {
            vscode.postMessage({
              type: "validate",
              dsl: editor.getValue(),
            });
          }, 400)
        );

        btn === null || btn === void 0
          ? void 0
          : btn.addEventListener("click", () => {
              vscode.postMessage({
                type: "validate",
                dsl: editor.getValue(),
              });
            });

        window.addEventListener("message", (event) => {
          const data = event.data || {};

          if (data.type === "setDSL") {
            editor.setValue(data.dsl || "");
            return;
          }

          const { payload, error } = data;

          if (error) {
            if (output) output.textContent = "ERROR:\n" + error;
            return;
          }

          if (output) output.textContent = JSON.stringify(payload, null, 2);
        });
      } catch (err) {
        console.error("Failed to initialize editor", err);
        const output = document.getElementById("output");
        if (output) output.textContent = "Failed to initialize editor: " + String(err);
      }
    });
  } catch (err) {
    console.error("Monaco loader found but initialization failed", err);
  }
}

function ensureMonacoStyle() {
  const href = MONACO_BASE + "/style.css";
  const existing = Array.from(document.getElementsByTagName("link")).find(
    (l) => l.rel === "stylesheet" && (l.href === href || l.getAttribute("href") === href)
  );
  if (existing) return;

  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  document.head.appendChild(link);
}

function setupMonacoEnvironment() {
  if (typeof self === "undefined") return;
  if (self.MonacoEnvironment && typeof self.MonacoEnvironment.getWorker === "function") return;

  const jsonWorker = MONACO_BASE + "/assets/json.worker.32db31cb.js";
  const cssWorker = MONACO_BASE + "/assets/css.worker.4040859e.js";
  const htmlWorker = MONACO_BASE + "/assets/html.worker.1a3caaf3.js";
  const tsWorker = MONACO_BASE + "/assets/ts.worker.77b7bdc2.js";
  const editorWorker = MONACO_BASE + "/assets/editor.worker.50c051c0.js";

  self.MonacoEnvironment = {
    getWorker: function (_moduleId, label) {
      if (label === "json") return createWorker(jsonWorker);
      if (label === "css" || label === "scss" || label === "less") return createWorker(cssWorker);
      if (label === "html" || label === "handlebars" || label === "razor") return createWorker(htmlWorker);
      if (label === "typescript" || label === "javascript") return createWorker(tsWorker);
      return createWorker(editorWorker);
    },
  };
}

function createWorker(workerUrl) {
  const workerBootstrap = [
    "const ttPolicy = globalThis.trustedTypes?.createPolicy('defaultWorkerFactory', { createScriptURL: value => value });",
    "globalThis.workerttPolicy = ttPolicy;",
    "importScripts(ttPolicy?.createScriptURL('" + workerUrl + "') ?? '" + workerUrl + "');",
    "globalThis.postMessage({ type: 'vscode-worker-ready' });",
  ].join("\n");

  const blob = new Blob([workerBootstrap], { type: "application/javascript" });
  return new Worker(URL.createObjectURL(blob));
}

function hasYamlLanguage(monaco) {
  try {
    return monaco.languages.getLanguages().some((l) => l && l.id === "yaml");
  } catch {
    return false;
  }
}

function ensureMonacoLoaderAndInit() {
  if (typeof require === "function") {
    // Loader already present
    initMonacoOnceLoaded();
    return;
  }

  // If loader script tag already exists in the DOM (injected via HTML), wait for it.
  const loaderSrc = MONACO_BASE + "/loader.js";
  const existing = Array.from(document.getElementsByTagName("script")).find(
    (s) => s.src === loaderSrc || s.getAttribute("src") === loaderSrc
  );

  if (existing) {
    existing.addEventListener("load", initMonacoOnceLoaded);
    existing.addEventListener("error", () => console.error("Failed to load Monaco loader"));
    return;
  }

  // Otherwise inject the loader and wait for it.
  const script = document.createElement("script");
  script.src = loaderSrc;
  script.addEventListener("load", initMonacoOnceLoaded);
  script.addEventListener("error", () => console.error("Failed to load Monaco loader"));
  document.head.appendChild(script);
}

ensureMonacoLoaderAndInit();

function getSchema() {
  return {
    type: "array",
    items: {
      type: "object",
      required: ["id", "match", "constraint", "message"],
      properties: {
        id: { type: "string" },
        description: { type: "string" },

        match: {
          type: "object",
          properties: {
            imports: {
              type: "array",
              items: { type: "string" },
            },
            callExpressions: {
              type: "array",
              items: { type: "string" },
            },
          },
        },

        constraint: {
          type: "object",
          required: ["type"],
          properties: {
            type: {
              enum: ["forbid", "require"],
            },
          },
        },

        message: { type: "string" },

        severity: {
          enum: ["error", "warn", "info"],
        },
      },
    },
  };
}

function getDefaultDSL() {
  return `- id: no-db-in-controller
  match:
    imports: ["db"]
  constraint:
    type: forbid
  message: "No DB in controller"
`;
}