import { runQuery } from "./service/db";

export function main(): void {
  runQuery();
  console.log("run complete");
}

main();
