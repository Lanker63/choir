policy repo-assign-allow-db {
  inherit assign
  when diff.path = "intent.constraints" and diff.operation = add then allow
}
