# Source from Evolution shell entry points. Exits 0 without starting a run
# while the product switch is off. Exit status 3 from the node guard means hidden.
evolution_refuse_if_hidden() {
  local root="$1"
  local status=0
  node "$root/scripts/evolution/refuse-if-hidden.mjs" || status=$?
  if [[ "$status" -eq 3 ]]; then
    exit 0
  fi
  if [[ "$status" -ne 0 ]]; then
    exit "$status"
  fi
}
