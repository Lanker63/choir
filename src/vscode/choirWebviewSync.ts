import * as vscode from "vscode";
import type { ChoirEvent, WebviewKind } from "./webviewProtocol.js";

export type MessageTrace = {
  direction: "host->webview" | "webview->host";
  type: string;
  timestamp: number;
  viewId: string;
};

type ChoirEventListener = (event: ChoirEvent) => void | Promise<void>;

export class ChoirEventBus {
  private readonly listeners = new Set<ChoirEventListener>();

  emit(event: ChoirEvent): void {
    for (const listener of this.listeners) {
      void listener(event);
    }
  }

  subscribe(listener: ChoirEventListener): vscode.Disposable {
    this.listeners.add(listener);
    return new vscode.Disposable(() => {
      this.listeners.delete(listener);
    });
  }
}

export class MessageTraceStore {
  private readonly traces: MessageTrace[] = [];

  constructor(private readonly maxEntries = 200) {}

  push(trace: MessageTrace): void {
    this.traces.push(trace);
    if (this.traces.length > this.maxEntries) {
      this.traces.splice(0, this.traces.length - this.maxEntries);
    }
  }

  list(): MessageTrace[] {
    return [...this.traces];
  }
}

export class WebviewRegistry {
  private readonly registry: Record<WebviewKind, Set<vscode.Webview>> = {
    control: new Set<vscode.Webview>(),
    graph: new Set<vscode.Webview>(),
    timeline: new Set<vscode.Webview>(),
    diagnostics: new Set<vscode.Webview>(),
  };

  register(kind: WebviewKind, webview: vscode.Webview): vscode.Disposable {
    this.registry[kind].add(webview);
    return new vscode.Disposable(() => {
      this.registry[kind].delete(webview);
    });
  }

  list(kind?: WebviewKind): vscode.Webview[] {
    if (kind) {
      return [...this.registry[kind]];
    }

    return [
      ...this.registry.control,
      ...this.registry.graph,
      ...this.registry.timeline,
      ...this.registry.diagnostics,
    ];
  }
}

export async function sendToWebview(
  traceStore: MessageTraceStore,
  viewId: string,
  webview: vscode.Webview,
  message: { type: string; [key: string]: unknown }
): Promise<boolean> {
  traceStore.push({
    direction: "host->webview",
    type: message.type,
    timestamp: Date.now(),
    viewId,
  });

  return await webview.postMessage(message);
}

export function traceInbound(
  traceStore: MessageTraceStore,
  viewId: string,
  message: { type?: unknown }
): void {
  traceStore.push({
    direction: "webview->host",
    type: typeof message.type === "string" ? message.type : "unknown",
    timestamp: Date.now(),
    viewId,
  });
}
