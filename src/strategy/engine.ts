import { EnforcementContext } from "../core/context";
import { Violation } from "../core/types";

export async function runStrategy(
  _context: EnforcementContext
): Promise<Violation[]> {
  return [];
}