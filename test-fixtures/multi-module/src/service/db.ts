export function runQuery(): void {
  db.query("select 1");
}

declare const db: { query(sql: string): void };
