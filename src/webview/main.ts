/// <reference path="./global.d.ts" />

import type * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import { createRuleEditor } from "./editor";
import "./styles.css";

const vscode = (window as any).vscode;
if (!vscode) {
  console.warn("VSCode API not available — running outside webview?");
}
const editorRoot = document.getElementById("editor");
const output = document.getElementById("output");

if (!(editorRoot instanceof HTMLElement) || !(output instanceof HTMLElement)) {
  throw new Error("Rule editor webview is missing required DOM elements.");
}

const editorElement: HTMLElement = editorRoot;
const outputElement: HTMLElement = output;

let editor: monaco.editor.IStandaloneCodeEditor;

function postMessageSafe(message: any) {
  if (!vscode) {
    console.warn("Skipping postMessage (no VSCode API)", message);
    return;
  }

  vscode.postMessage(message);
}

function debounce<T extends (...args: any[]) => void>(callback: T, waitMs = 300): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;

  return (...args: Parameters<T>) => {
    if (timer) {
      clearTimeout(timer);
    }

    timer = setTimeout(() => {
      callback(...args);
    }, waitMs);
  };
}

function setOutputText(text: string) {
  outputElement.textContent = text;
}

function initEditor() {
  console.log("editorRoot:", editorRoot);
  editor = createRuleEditor(editorElement, "");
  const debouncedValidate = debounce(() => {
    postMessageSafe({
      type: "validate",
      dsl: editor.getValue(),
    });
  }, 400);

  editor.onDidChangeModelContent(debouncedValidate);
  setTimeout(() => {
    editor.layout();
  }, 0);
}

export function wireSave() {
  const btn = document.getElementById("saveBtn");

  btn?.addEventListener("click", () => {
    if (!editor) return;

    postMessageSafe({
      type: "save",
      dsl: editor.getValue(),
    });
  });
}

export function wireIncoming() {
  window.addEventListener("message", (event) => {
    const { type, payload, error } = event.data;

    if (type === "setDSL") {
      if (!editor) {
        console.warn("Editor not ready yet");
        return;
      }

      editor.setValue(payload?.dsl ?? "");
      return;
    }

    if (type === "result") {
      if (error) {
        setOutputText("ERROR:\n" + error);
        return;
      }

      setOutputText(JSON.stringify(payload, null, 2));
    }

    if (type === "saved") {
      const message = typeof payload?.message === "string" ? payload.message : "Rules saved";
      const mode = payload?.mode ? ` (${payload.mode})` : "";
      const path = payload?.path ? `\n${payload.path}` : "";
      setOutputText(`✅ ${message}${mode}${path}`);
    }
  });
}

function bootstrap() {
  initEditor();
  wireSave();
  wireIncoming();

  postMessageSafe({ type: "ready" });
}

bootstrap();
