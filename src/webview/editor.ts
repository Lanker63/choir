import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import { configureMonacoYaml } from "monaco-yaml";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import yamlWorker from "monaco-yaml/yaml.worker?worker";
import { dslSchema } from "./schema";

type MonacoWorkerFactory = {
  getWorker: (_workerId: string, label: string) => Worker;
};

const globalScope = self as typeof self & {
  MonacoEnvironment?: MonacoWorkerFactory;
};

globalScope.MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    if (label === "yaml") {
      return new yamlWorker();
    }

    return new editorWorker();
  },
};

configureMonacoYaml(monaco, {
  validate: true,
  enableSchemaRequest: false,
  completion: true,
  hover: true,
  format: true,
  schemas: [
    {
      uri: "choir://rule-schema.json",
      fileMatch: ["*"],
      schema: dslSchema,
    },
  ],
});

export function createRuleEditor(container: HTMLElement, initialValue: string): monaco.editor.IStandaloneCodeEditor {
  const model = monaco.editor.createModel(initialValue, "yaml");

  return monaco.editor.create(container, {
    model,
    theme: "vs-dark",
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 13,
  });
}
