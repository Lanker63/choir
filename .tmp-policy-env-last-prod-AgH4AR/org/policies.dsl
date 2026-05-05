policy org-allow-plans {
  when diff.path = "execution.plans" and diff.operation = add then allow
}
