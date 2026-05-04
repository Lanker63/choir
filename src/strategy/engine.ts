import { EnforcementContext } from "../core/context.js";
import { Violation } from "../core/types.js";

export async function runStrategy(
  _context: EnforcementContext
): Promise<Violation[]> {
  return [];
}