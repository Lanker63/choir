policy deny-db-constraint {
  when diff.path = "intent.constraints" and diff.operation = add and contains "db" then deny
}
