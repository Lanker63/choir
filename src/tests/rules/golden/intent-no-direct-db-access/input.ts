import db from "./db.js";

export function handler() {
  return db.query("select 1");
}
