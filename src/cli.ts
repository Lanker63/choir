#!/usr/bin/env node

import { executeCliIntent } from "./core/cliRuntime.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  process.exitCode = await executeCliIntent(args);
}

void main();
