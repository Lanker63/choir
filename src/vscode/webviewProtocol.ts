import type { ProductActionRequest } from "../ui/contracts.js";

export type NavigationIntent =
  | { type: "focusUnit"; unitId: string }
  | { type: "showDependencies"; unitId: string }
  | { type: "showTimeline"; unitId: string };

export type ChoirEvent =
  | { type: "STATE_UPDATED"; stateHash: string }
  | { type: "GRAPH_UPDATED" }
  | { type: "TIMELINE_UPDATED" }
  | { type: "PLAN_UPDATED" }
  | { type: "NAVIGATE"; intent: NavigationIntent };

export type HostToWebview<TPayload = unknown> =
  | { type: "INIT"; payload: TPayload }
  | { type: "UPDATE"; payload: TPayload }
  | { type: "NAVIGATE"; intent: NavigationIntent };

export type WebviewToHost =
  | { type: "OPEN_NODE"; id: string }
  | { type: "EXECUTE_COMMAND"; command: ProductActionRequest }
  | { type: "REQUEST_STATE" }
  | { type: "NAVIGATE"; intent: NavigationIntent };

export type MessageTrace = {
  direction: "host->webview" | "webview->host";
  type: string;
  timestamp: number;
};

export type WebviewKind = "control" | "graph" | "timeline";
