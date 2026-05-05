policy org-deny-db {
  when diff.path = "intent.constraints" and diff.operation = add and contains "db" then deny
}
