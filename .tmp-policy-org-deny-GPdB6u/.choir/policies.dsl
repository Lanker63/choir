policy repo-allow-db {
  when diff.path = "intent.constraints" and diff.operation = add and contains "db" then allow
}
