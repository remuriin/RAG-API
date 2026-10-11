#!/bin/bash
# Checks k8s-new-project (on any machine with bash and git) and, with "vps" as its argument,
# k8s-add-project. That second part writes to /home/deploy, so it only runs in a throwaway container:
#   bash deploy/k8s-template.test.sh
#   docker run --rm -v "$PWD/deploy":/d:ro alpine sh -c "apk add -q bash openssh-keygen coreutils && bash /d/k8s-template.test.sh vps"
set -u
here=$(cd "$(dirname "$0")" && pwd)
fails=0
ok() { if eval "$2"; then echo "PASS  $1"; else echo "FAIL  $1"; fails=$((fails + 1)); fi; }

if [[ "${1:-}" == vps ]]; then
  ok "refused without the deploy user's folder" '! bash "$here/k8s-add-project" my-app >/dev/null 2>&1'
  mkdir -p /home/deploy/.ssh
  out=$(bash "$here/k8s-add-project" my-app 2>&1)
  line=$(cat /home/deploy/.ssh/authorized_keys)
  ok "prints a whole private key" '[[ "$out" == *"BEGIN OPENSSH PRIVATE KEY"* && "$out" == *"END OPENSSH PRIVATE KEY"* ]]'
  ok "the key is pinned to its namespace" '[[ "$line" == "restrict,command=\"sudo /usr/local/sbin/k8s-deploy my-app\" ssh-ed25519 "* ]]'
  ok "no private key is left on disk" '! grep -rqs "PRIVATE KEY" /tmp /home /root'
  ok "a second key for the same namespace is refused" '! bash "$here/k8s-add-project" my-app >/dev/null 2>&1'
  ok "... and my-app-2 is a different namespace" 'bash "$here/k8s-add-project" my-app-2 >/dev/null 2>&1 && [[ $(wc -l < /home/deploy/.ssh/authorized_keys) -eq 2 ]]'
  ok "a bad name is refused" '! bash "$here/k8s-add-project" "x y" >/dev/null 2>&1 && ! bash "$here/k8s-add-project" "../x" >/dev/null 2>&1'
else
  tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
  new() { bash "$here/k8s-new-project" "$@" >/dev/null 2>&1; }
  git init -q "$tmp/full"; git init -q "$tmp/web"

  ok "a project with a backend is written" 'new "$tmp/full" my-app my-app.remservers.me 10.43.0.83 10.43.0.84'
  ok "... with its backend files" '[[ -f "$tmp/full/backend/Dockerfile" && -f "$tmp/full/k8s/api.yaml" ]]'
  ok "a web-only project is written" 'new "$tmp/web" my-site my-site.remservers.me 10.43.0.85'
  ok "... without backend files or lines" '[[ ! -e "$tmp/web/backend" && ! -e "$tmp/web/k8s/api.yaml" ]] && ! grep -rqE "\-api:|backend/|name: backend|location /api|\"api " "$tmp/web/.github" "$tmp/web/nginx-site.conf"'
  ok "nothing of the template is left unfilled" '! grep -rqE "PROJECT|REPO|SITE_NAME|WEB_IP|API_IP|api:(begin|end)" "$tmp/full" "$tmp/web" --exclude-dir=.git'
  ok "the names landed where they belong" 'grep -q "clusterIP: 10.43.0.84" "$tmp/full/k8s/api.yaml" && grep -q "namespace: my-app" "$tmp/full/k8s/web.yaml" && grep -q "ghcr.io/remuriin/my-app-web:main" "$tmp/full/k8s/web.yaml" && grep -q "server_name my-app.remservers.me;" "$tmp/full/nginx-site.conf"'
  ok "it never overwrites" '! new "$tmp/full" my-app my-app.remservers.me 10.43.0.83 10.43.0.84'
  git init -q "$tmp/bad"
  ok "a bad project name is refused" '! new "$tmp/bad" "My App" a.remservers.me 10.43.0.90'
  ok "an address outside the range is refused" '! new "$tmp/bad" ok a.remservers.me 10.43.0.10 && ! new "$tmp/bad" ok a.remservers.me 8.8.8.8'
  ok "the same address twice is refused" '! new "$tmp/bad" ok a.remservers.me 10.43.0.90 10.43.0.90'
  ok "a bad site name is refused" '! new "$tmp/bad" ok "a b" 10.43.0.90'
  ok "a folder that is not a repository is refused" '! new "$tmp" ok a.remservers.me 10.43.0.90'
  ok "... and nothing was written for any of those" '[[ -z "$(ls "$tmp/bad")" ]]'
fi
[[ $fails -eq 0 ]] && echo "all passed" || { echo "$fails failed"; exit 1; }
