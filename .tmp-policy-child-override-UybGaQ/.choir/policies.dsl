policy repo-assign-allow {
  inherit assign
  when diff.path = "intent.constraints" and diff.operation = add and contains "db" then allow
}
