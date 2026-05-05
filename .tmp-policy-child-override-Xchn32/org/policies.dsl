policy org-require-review {
  override child
  when diff.path = "intent.constraints" and diff.operation = add and contains "db" then require-approval
}
