import { EnforcementContext } from "../core/context.js";
import { Diagnostic } from "../core/types.js";

export async function runStrategy(
  _context: EnforcementContext,
  _traceId: string
): Promise<Diagnostic[]> {
  return [];
}