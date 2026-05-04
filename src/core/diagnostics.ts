import ts from "typescript";
import {
  Diagnostic,
  DiagnosticCategory,
  DiagnosticSeverity,
  LegacySeverity,
  SourceLocation,
  normalizeDiagnosticSeverity,
} from "./types.js";

export function comparePositions(
  left: SourceLocation["start"],
  right: SourceLocation["start"]
): number {
  if (left.line !== right.line) {
    return left.line - right.line;
  }

  return left.character - right.character;
}

export function compareSourceLocations(left: SourceLocation, right: SourceLocation): number {
  if (left.file !== right.file) {
    return left.file.localeCompare(right.file);
  }

  const start = comparePositions(left.start, right.start);
  if (start !== 0) {
    return start;
  }

  return comparePositions(left.end, right.end);
}

export function sortDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort((left, right) => {
    if (left.location.file !== right.location.file) {
      return left.location.file.localeCompare(right.location.file);
    }

    const start = comparePositions(left.location.start, right.location.start);
    if (start !== 0) {
      return start;
    }

    const end = comparePositions(left.location.end, right.location.end);
    if (end !== 0) {
      return end;
    }

    if (left.ruleId !== right.ruleId) {
      return left.ruleId.localeCompare(right.ruleId);
    }

    if (left.severity !== right.severity) {
      return left.severity.localeCompare(right.severity);
    }

    return left.message.localeCompare(right.message);
  });
}

export function severityFromTypeScriptCategory(category: ts.DiagnosticCategory): DiagnosticSeverity {
  if (category === ts.DiagnosticCategory.Warning) {
    return "warning";
  }

  if (category === ts.DiagnosticCategory.Suggestion || category === ts.DiagnosticCategory.Message) {
    return "info";
  }

  return "error";
}

export function severityFromLegacy(value: LegacySeverity): DiagnosticSeverity {
  return normalizeDiagnosticSeverity(value);
}

export function sourceLocationFromOffsets(
  sourceFile: ts.SourceFile,
  filePath: string,
  startOffset: number,
  endOffset: number
): SourceLocation {
  const start = sourceFile.getLineAndCharacterOfPosition(startOffset);
  const end = sourceFile.getLineAndCharacterOfPosition(endOffset);

  return {
    file: filePath,
    start: {
      line: start.line,
      character: start.character,
    },
    end: {
      line: end.line,
      character: end.character,
    },
  };
}

export function makeDiagnosticId(parts: Array<string | number>): string {
  return parts.map((part) => String(part)).join(":");
}

export function createZeroLengthLocation(file: string): SourceLocation {
  return {
    file,
    start: { line: 0, character: 0 },
    end: { line: 0, character: 1 },
  };
}

export function locationToOffsetRange(text: string, location: SourceLocation): { start: number; end: number } {
  const start = positionToOffset(text, location.start.line, location.start.character);
  const end = positionToOffset(text, location.end.line, location.end.character);

  return { start, end };
}

export function positionToOffset(text: string, line: number, character: number): number {
  if (line < 0 || character < 0) {
    throw new Error(`Invalid position ${line}:${character}`);
  }

  let offset = 0;
  let currentLine = 0;

  while (currentLine < line) {
    const lineBreak = text.indexOf("\n", offset);
    if (lineBreak === -1) {
      throw new Error(`Line ${line} is out of bounds`);
    }

    offset = lineBreak + 1;
    currentLine += 1;
  }

  const nextLineBreak = text.indexOf("\n", offset);
  const lineEnd = nextLineBreak === -1 ? text.length : nextLineBreak;
  const target = offset + character;

  if (target > lineEnd) {
    throw new Error(`Character ${character} is out of bounds for line ${line}`);
  }

  return target;
}
