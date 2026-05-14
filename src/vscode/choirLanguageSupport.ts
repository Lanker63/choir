import * as vscode from "vscode";
import {
  getDeterministicCompletions,
  getHoverTextForKeyword,
  validateChoirDocument,
} from "../core/choirLanguageModel.js";

export type EditorTrace = {
  completionsTriggered: number;
  diagnosticsCount: number;
  parseErrors: number;
};

const trace: EditorTrace = {
  completionsTriggered: 0,
  diagnosticsCount: 0,
  parseErrors: 0,
};

const CHOIR_LANGUAGE_ID = "choir";

function toCompletionItem(item: ReturnType<typeof getDeterministicCompletions>[number]): vscode.CompletionItem {
  const completion = new vscode.CompletionItem(
    item.label,
    item.kind === "keyword"
      ? vscode.CompletionItemKind.Keyword
      : item.kind === "identifier"
        ? vscode.CompletionItemKind.Variable
        : vscode.CompletionItemKind.Snippet
  );

  completion.detail = item.detail;
  completion.insertText = new vscode.SnippetString(item.insertText);

  return completion;
}

function validateDocument(document: vscode.TextDocument, collection: vscode.DiagnosticCollection): void {
  if (document.languageId !== CHOIR_LANGUAGE_ID) {
    return;
  }

  const diagnostics = validateChoirDocument(document.getText()).map((error) => {
    const range = new vscode.Range(
      new vscode.Position(error.line, error.startCharacter),
      new vscode.Position(error.line, Math.max(error.startCharacter + 1, error.endCharacter))
    );

    return new vscode.Diagnostic(range, error.message, vscode.DiagnosticSeverity.Error);
  });

  trace.diagnosticsCount = diagnostics.length;
  trace.parseErrors += diagnostics.length;
  collection.set(document.uri, diagnostics);
}

function registerCompletionProvider(context: vscode.ExtensionContext): void {
  const provider = vscode.languages.registerCompletionItemProvider(
    CHOIR_LANGUAGE_ID,
    {
      provideCompletionItems(document, position) {
        trace.completionsTriggered += 1;

        const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
        const suggestions = getDeterministicCompletions(linePrefix);

        const replacementMatch = linePrefix.match(/[A-Za-z0-9_-]+$/);
        const replacementRange = replacementMatch
          ? new vscode.Range(
            new vscode.Position(position.line, position.character - replacementMatch[0].length),
            position
          )
          : undefined;

        return suggestions.map((item, index) => {
          const completion = toCompletionItem(item);
          completion.sortText = index.toString().padStart(4, "0");
          if (replacementRange) {
            completion.range = replacementRange;
          }
          return completion;
        });
      },
    },
    " ",
    '"'
  );

  context.subscriptions.push(provider);
}

function registerHoverProvider(context: vscode.ExtensionContext): void {
  const provider = vscode.languages.registerHoverProvider(CHOIR_LANGUAGE_ID, {
    provideHover(document, position) {
      const range = document.getWordRangeAtPosition(position, /[A-Za-z-]+/);
      if (!range) {
        return undefined;
      }

      const keyword = document.getText(range).toLowerCase();
      const description = getHoverTextForKeyword(keyword);
      if (!description) {
        return undefined;
      }

      return new vscode.Hover(new vscode.MarkdownString(`**${keyword}**\n\n${description}`), range);
    },
  });

  context.subscriptions.push(provider);
}

function registerValidation(context: vscode.ExtensionContext): void {
  const collection = vscode.languages.createDiagnosticCollection("choir-dsl");

  for (const document of vscode.workspace.textDocuments) {
    validateDocument(document, collection);
  }

  context.subscriptions.push(
    collection,
    vscode.workspace.onDidOpenTextDocument((document) => {
      validateDocument(document, collection);
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      validateDocument(event.document, collection);
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      collection.delete(document.uri);
    })
  );
}

function registerTraceCommand(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Choir DSL Editor Trace");
  context.subscriptions.push(output);

  context.subscriptions.push(
    vscode.commands.registerCommand("choir.showDslEditorTrace", () => {
      const snapshot = getEditorTrace();
      const message = [
        `completionsTriggered=${snapshot.completionsTriggered}`,
        `diagnosticsCount=${snapshot.diagnosticsCount}`,
        `parseErrors=${snapshot.parseErrors}`,
      ].join(" | ");

      output.clear();
      output.appendLine("Choir DSL Editor Trace");
      output.appendLine(new Date().toISOString());
      output.appendLine("");
      output.appendLine(message);
      output.show(true);
      void vscode.window.showInformationMessage("Choir DSL editor trace opened in Output.");
    })
  );
}

export function registerChoirLanguageSupport(context: vscode.ExtensionContext): void {
  registerCompletionProvider(context);
  registerHoverProvider(context);
  registerValidation(context);
  registerTraceCommand(context);
}

function getEditorTrace(): EditorTrace {
  return { ...trace };
}
