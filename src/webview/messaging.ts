declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
};

export type HostMessage =
  | {
      type: "setDSL";
      dsl?: string;
    }
  | {
      type: "result";
      payload?: unknown;
      error?: string;
    };

const vscode = acquireVsCodeApi();

export function postValidateRequest(dsl: string): void {
  vscode.postMessage({
    type: "validate",
    dsl,
  });
}

export function onHostMessage(handler: (message: HostMessage) => void): () => void {
  const listener = (event: MessageEvent<HostMessage>) => {
    handler(event.data);
  };

  window.addEventListener("message", listener);

  return () => {
    window.removeEventListener("message", listener);
  };
}
