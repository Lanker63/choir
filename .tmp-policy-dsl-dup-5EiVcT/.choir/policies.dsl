policy dup {
  when diff.operation = add then allow
}

policy dup {
  when diff.operation = remove then deny
}
