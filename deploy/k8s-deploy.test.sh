#!/bin/bash
# Checks k8s-deploy against a pretend kubectl. It installs that pretend kubectl at /usr/local/bin,
# so run it in a throwaway container, never on the VPS:
#   docker run --rm -v "$PWD":/d:ro bash:5 bash /d/k8s-deploy.test.sh
set -u
cat > /usr/local/bin/kubectl <<'EOF'
#!/usr/bin/env bash
echo "$*" >> /tmp/calls
case "$*" in
  *"containers[0].name"*) echo -n web ;;
  *"containers[0].image"*) echo -n ghcr.io/remuriin/raas-web:main ;;
  *"rollout status"*) [[ -e /tmp/unhealthy && ! -e /tmp/undone ]] && exit 1 ;;
  *"rollout undo"*) touch /tmp/undone ;;
esac
exit 0
EOF
chmod +x /usr/local/bin/kubectl
SHA=0123456789abcdef0123456789abcdef01234567
fails=0
run() { # <wanted exit code> <what it shows> <args...>
  local want=$1 name=$2; shift 2
  rm -f /tmp/calls /tmp/undone
  SSH_ORIGINAL_COMMAND="${2-}" bash /d/k8s-deploy "$1" >/dev/null 2>&1; local got=$?
  if [[ $got -eq $want ]]; then echo "PASS  $name"; else echo "FAIL  $name (exit $got, wanted $want)"; fails=$((fails + 1)); fi
}
refused() { # nothing may reach kubectl
  run 2 "$@"
  [[ ! -e /tmp/calls ]] || { echo "FAIL  ... and kubectl was called"; fails=$((fails + 1)); }
}

run 0 "a good request deploys" rem-raas "web $SHA"
grep -qx -- "-n rem-raas set image deployment/web web=ghcr.io/remuriin/raas-web:$SHA" /tmp/calls \
  && echo "PASS  only the tag changed" || { echo "FAIL  wrong set image call"; fails=$((fails + 1)); }

refused "a short commit is refused" rem-raas "web 0123abc"
refused "a tag name is refused" rem-raas "web main"
refused "an image address is refused" rem-raas "web evil.example/x:$SHA"
refused "a shell command is refused" rem-raas "web $SHA; rm -rf /"
refused "an extra word is refused" rem-raas "web $SHA --all"
refused "an option as the name is refused" rem-raas "--all-namespaces $SHA"
refused "another namespace in the request is refused" rem-raas "rem-servers/api $SHA"
refused "an empty request is refused" rem-raas ""
refused "a bad namespace is refused" "../x" "web $SHA"

touch /tmp/unhealthy
run 1 "an unhealthy pod fails the deploy" rem-raas "web $SHA"
grep -qx -- "-n rem-raas rollout undo deployment/web" /tmp/calls \
  && echo "PASS  ... and it went back" || { echo "FAIL  no rollout undo"; fails=$((fails + 1)); }

[[ $fails -eq 0 ]] && echo "all passed" || { echo "$fails failed"; exit 1; }
