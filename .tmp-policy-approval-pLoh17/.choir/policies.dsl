policy approve-db-constraint {
  when diff.path = "intent.constraints" and diff.operation = add and contains "db" then require-approval
}
