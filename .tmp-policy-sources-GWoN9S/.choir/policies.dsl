policy repo-base {
  when diff.path = "intent.constraints" and diff.operation = add then require-approval
}
