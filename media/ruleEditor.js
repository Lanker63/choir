const vscode = acquireVsCodeApi();

const dslInput = document.getElementById("dsl");
const output = document.getElementById("output");
const btn = document.getElementById("validateBtn");

let timeout;

dslInput.addEventListener("input", () => {
  clearTimeout(timeout);

  timeout = setTimeout(() => {
    vscode.postMessage({
      type: "validate",
      dsl: dslInput.value
    });
  }, 400);
});

// Default content
dslInput.value = `- id: no-db-in-controller
  match:
    imports: ["db"]
  constraint:
    type: forbid
  message: "No DB in controller"
`;

btn.addEventListener("click", () => {
  vscode.postMessage({
    type: "validate",
    dsl: dslInput.value
  });
});

// Receive results
window.addEventListener("message", (event) => {
  const { payload, error } = event.data;

  if (error) {
    output.textContent = "ERROR:\n" + error;
    return;
  }

  output.textContent = JSON.stringify(payload, null, 2);
});