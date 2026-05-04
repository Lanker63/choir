import fs from "fs";

export function runUnsafe(payload: string): void {
  eval(payload);
  db.query("select now()");
  fs.readFileSync("/tmp/example.txt", "utf-8");
}

declare const db: { query(sql: string): void };
