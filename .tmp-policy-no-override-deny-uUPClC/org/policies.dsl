policy org-deny-db {
  override child
  when diff.path = "intent.constraints" and diff.operation = add then deny
}
