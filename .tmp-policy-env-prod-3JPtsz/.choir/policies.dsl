policy deny-plan-prod {
  when diff.path = "execution.plans" and environment = production then deny
}
