# Deploying to the VPS

The backend runs in the VPS's Kubernetes cluster (k3s) as three kinds of pod, all started from one image built from this repository:

- **Management API** (`management`): verifies Firebase logins, writes service requests, issues API keys, relays the dashboard's file and chat requests. Public at `/api/`.
- **Control agent** (`agent`): no port. Polls the `instances` table and creates or removes one pod per client service.
- **RAG service** (`rag-<instanceId>`): one pod per service a client created.

Public URLs:

```
https://rag.remservers.me/                    the web app (dashboard)
https://rag.remservers.me/api/...             the management API
https://rag.remservers.me/i/<instanceId>/...  one client's service
```

The older name `rag.140-245-60-8.sslip.io` still answers (its own certificate, from cert-manager).

```
cluster (k3s)
└── node: rem-vm (the VPS)
    ├── namespace envoy-gateway-system the front door: Envoy on ports 80 and 443, and its certificates
    ├── namespace flux-system          Flux: applies the Fleet repository, deploys new builds
    ├── namespace flagger-system       Flagger: blue-green for the web app and the management API
    ├── namespace rem-raas             the web app (from the RaaS repository)
    ├── namespace rem-raas-backend
    │   ├── pod: management-primary    what users get, Service "management", where the front door sends /api
    │   ├── pod: management            a new build being checked, only during a deploy
    │   └── pod: agent                 no address
    └── namespace rem-raas-clients
        └── pod: rag-<instanceId>      one per service, found by name
```

Outside the cluster, on the VPS itself: Postgres and the nightly database dump. The internet talks only to the front door, which runs in the cluster (Envoy Gateway, set up in Fleet's `infrastructure/`).

Commands below are run on the VPS unless stated otherwise. Needs: Ubuntu 22.04, k3s (see the `Cluster` repository), Postgres with the `vector` extension. Node is not needed on the VPS: nothing is built or run there outside the cluster.

## One-time setup

### 0. Database

```bash
sudo -u postgres psql -c "CREATE ROLE rag_app LOGIN PASSWORD 'PASSWORD';"
sudo -u postgres psql -c "CREATE DATABASE rag_service OWNER rag_app;"
sudo -u postgres psql -d rag_service -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

Postgres has to accept connections from the pods, which arrive from `10.42.0.0/16` and not from localhost. It listens on every address and takes any address with a password (`pg_hba.conf`), so the firewall is what keeps the internet out: ufw allows port 5432 only from the VPS's private network and from the pod network.

```bash
sudo ufw allow from 10.42.0.0/16 to any port 5432 proto tcp
```

### 1. Settings files

Two files hold every secret. They stay on the VPS, root-only, and are never in this repository or in the image.

```bash
sudo mkdir -p /etc/rag-control && sudo chmod 700 /etc/rag-control
sudo nano /etc/rag-control/management.env
sudo nano /etc/rag-control/agent.env
sudo chmod 600 /etc/rag-control/management.env /etc/rag-control/agent.env
```

`management.env` (all five are required):

```
DATABASE_URL=postgres://rag_app:PASSWORD@VPS_ADDRESS:5432/rag_service
FIREBASE_PROJECT_ID=rag-service-remuriin
PUBLIC_BASE_URL=https://rag.remservers.me
MGMT_PORT=4050
INTERNAL_SECRET=THE_SAME_RANDOM_VALUE_IN_BOTH_FILES
```

`agent.env` (what the agent and every client's service need):

```
DATABASE_URL=postgres://rag_app:PASSWORD@VPS_ADDRESS:5432/rag_service
GEMINI_API_KEY=YOUR_KEY
INTERNAL_SECRET=THE_SAME_RANDOM_VALUE_IN_BOTH_FILES
```

- `VPS_ADDRESS` is one of the VPS's own private addresses (`hostname -I`), never `localhost`: inside a pod, `localhost` is the pod.
- No quotes around values. The secrets below are made from these files as written, and a quote would become part of the value. `sudo grep -c '="' <file>` must print `0`.
- `INTERNAL_SECRET` is what lets the management API call a service on the owner's behalf (the dashboard's file and chat pages). Generate one with `openssl rand -hex 32`. It must be identical in both files; if it isn't, those pages answer "the service is not responding" and the management pod's log says why.

### 2. Namespaces and secrets

The namespaces, the management API, the agent and its permissions are in the private `Fleet` repository (`apps/rag-api/`, `apps/rag-api-agent/`), and Flux, in the cluster, applies them. Nothing here is applied by hand. The secrets are the exception: they are made by hand and are in no repository.

```bash
sudo kubectl -n rem-raas-clients create secret generic rag-env        --from-env-file=/etc/rag-control/agent.env
sudo kubectl -n rem-raas-backend create secret generic management-env --from-env-file=/etc/rag-control/management.env
sudo kubectl -n rem-raas-backend create secret generic agent-env      --from-env-file=/etc/rag-control/agent.env
```

`rag-env` is shared by every client's service; which service a pod is, is set on the pod itself. `sudo kubectl -n <namespace> describe secret <name>` lists the names and sizes, never the values.

**Changing a setting later.** A pod reads its settings once, when it starts. Edit the file, delete the secret and create it again, then restart what uses it:

```bash
sudo kubectl -n rem-raas-backend rollout restart deployment/management-primary deployment/agent
sudo kubectl -n rem-raas-clients rollout restart deployment -l app=rag
```

### 3. The management API and the agent

Flux runs them from Fleet: first the management API (`rag-api`), then the agent (`rag-api-agent`, which waits for it). Their state, on the VPS:

```bash
sudo flux get kustomizations rag-api rag-api-agent --kubeconfig=/etc/rancher/k3s/k3s.yaml
sudo kubectl -n rem-raas-backend get canary,deploy,pods
curl -s http://management.rem-raas-backend.svc.cluster.local/api/health    # only works from a pod; from the VPS use https://rag.remservers.me/api/health
```

The management API is deployed blue-green by Flagger: users reach `management-primary` through the Service `management`, and a new build starts as `management` beside it, is checked, and only then copied over. The management pod brings the database schema up to date before it starts (its start command runs `dist/scripts/migrate.js` first), so there is no separate migration step. Because the new pod migrates while the old one still serves, a migration must keep working for the build before it (add first, remove in a later deploy).

The agent's permissions (`apps/rag-api/agent-rbac.yaml` in Fleet), and that is all it can do: create, read, change and delete Deployments and Services in `rem-raas-clients`. It cannot read secrets, cannot touch its own namespace, and has no access to the VPS.

`/api/health` needs no login: it says whether the database answers and whether the agent has checked in within the last minute (`agent: "stale"` and a 503 otherwise). Point a monitor at `https://rag.remservers.me/api/health`, so a dead agent is noticed. The cluster's own readiness check uses `/api/ready` instead, which asks the database only: a dead agent must not take the dashboard's API down with it.

### 4. The front door and HTTPS

Nothing to do by hand: the addresses are Gateway API routes in Fleet, applied by Flux, and the certificates are made and renewed by cert-manager in the cluster.

- `/api/` is the route `apps/rag-api/route.yaml`, with a 300 s timeout for uploads. Its limits are `apps/rag-api/api-policy.yaml`: 10 requests a second and 300 a minute per visitor address, 11 MiB per request, and JSON replies (413, 429, 503) in place of the front door's own plain-text errors.
- `/` and `/assets/` are the route `apps/raas/route.yaml`, with the security headers and the Content-Security-Policy. An address under `/i/` that no service claims answers `{"error":"Unknown service"}` with a 404.
- `/i/<instanceId>/` is one route per service, made by the agent with the service (`k8s/client.yaml`, the third document). The policy `clients` in the same Fleet file gives those routes the same limits as `/api/`, found by their label `remservers.me/client-route: "true"`, plus the 300 s timeout.
- Certificates: `rag.remservers.me` is covered by the wildcard `*.remservers.me` (DNS-01 through Cloudflare), `rag.140-245-60-8.sslip.io` has its own (HTTP-01). Both in Fleet's `infrastructure/configs/`.

### Using it

From a machine with the repo's `.env` (which has the test account), `npm run dev:firebase-token` prints a login token valid for an hour. With it as `TOKEN`:

```bash
API=https://rag.remservers.me/api
curl -X POST $API/instances -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"name":"My service","productName":"Acme"}'
curl $API/instances -H "Authorization: Bearer $TOKEN"                 # status goes pending -> active
curl -X POST $API/instances/<id>/key -H "Authorization: Bearer $TOKEN"   # the API key, shown once
curl -X DELETE $API/instances/<id> -H "Authorization: Bearer $TOKEN"
```

## How a service is set up

The agent does this by itself for every `pending` row; nothing here is done by hand.

It fills in `k8s/client.yaml` (a copy is inside the image) with the service's id and with the agent's own image, and hands the result to Kubernetes: a Deployment, a Service and an HTTPRoute (the address `/i/<instanceId>/` at the front door), all named `rag-<instanceId>`. Then it waits until the pod answers `/health` and marks the row `active`. For a `deleting` row it deletes the three, the route first, and then the row.

- The old pod of a service is stopped before a new one starts (`strategy: Recreate`). A service marks its unfinished uploads as failed when it starts, so two pods of one service alive at once would fail an upload the old one is still doing.
- A pod being replaced gets 300 seconds to finish the requests it already has (a PDF upload can run for close to four minutes).
- Each pod: 512 MB at most, not root, read-only files, no login for Kubernetes.

To set one up by hand (the row and its API key must already exist):

```bash
curl -s https://raw.githubusercontent.com/remuriin/RAG-API/main/k8s/client.yaml \
  | sed 's/__INSTANCE_ID__/<instanceId>/g; s#__IMAGE__#ghcr.io/remuriin/rag-api:main#' \
  | sudo kubectl apply -f -
```

## Updating the code

A push to `main` that touches the code runs `.github/workflows/image.yml`:

1. **check**: the check scripts that need no database, model or cluster.
2. **build**: the image is built on an ARM machine and stored as `ghcr.io/remuriin/rag-api`, tagged with the commit, `main`, and `main-<commit>-<commit time>`.

Nothing in the workflow touches the VPS. GitHub then calls Flux's webhook; Flux finds the new `main-...` tag, its bot writes it into `apps/rag-api/management.yaml` and `apps/rag-api-agent/agent.yaml` in Fleet (one commit), and Flux rolls it out: the management API first (blue-green, through Flagger's checks), then the agent.

The agent, when it starts, brings every client's service to its own build, one at a time, waiting for each to answer before the next. It only reports ready once all of them run it. If a service does not come up on the new build, the agent puts that service back on the build it ran before and stops without reporting ready.

Going back: in Fleet, take the `# {"$imagepolicy": ...}` marker off the image lines and set the old tag by hand, commit and push; the bot then leaves those lines alone. Put the markers back to follow `main` again. A management build that fails Flagger's checks never reaches users: Flagger throws it away by itself. A broken agent build has no automatic way back: pin the old tag.

A change to the cluster files is a commit to Fleet. A change to `k8s/client.yaml` (the template the agent fills in for each service, the only cluster file still in this repository) reaches the services with the next build, since the agent reads its copy from the image: when it starts, it applies the template again to every service, routes included.

## The web app

The dashboard is built from the `RaaS` repository (`frontend/`) into a container image, and runs in the namespace `rem-raas`. The front door sends `/` to its Service `web` (route `apps/raas/route.yaml`). Its cluster files are in Fleet (`apps/raas/`).

A push to `main` in `RaaS` that touches `frontend/` runs the linter, builds the image and stores it as `ghcr.io/remuriin/raas-web`. Flux deploys it the same way as the backend, blue-green through Flagger: the new version is checked beside the old one and only then switched to, and a version that fails its checks is thrown away by itself.

The container sets the caching (`index.html` never cached, `/assets/` cached for a year). The route adds the security headers and a Content-Security-Policy that allows Firebase's sign-in pop-up. The app itself reloads when a tab open from before the deploy asks for a file that no longer exists.

If the web app's pod is down, `/` answers 503 while `/api/` and `/i/` keep working. `sudo kubectl -n rem-raas get pods` and `sudo kubectl -n rem-raas describe pod -l app=web` say why.

Before the first deploy, in the Firebase console, `rag.remservers.me` must be on Authentication → Settings → Authorized domains (it is).

## Files a service accepts

A service takes `.md`, `.txt`, `.pdf`, `.html` and `.xml` files. Markdown and plain text are stored as they are. A PDF, a web page and XML are first written out as markdown by a Gemini model, and only that markdown is kept.

- Limits: 10 MB for a PDF, 500 KB for the others. The front door allows 11 MiB (`requestBuffer` in Fleet's `apps/rag-api/api-policy.yaml`), the service applies the real limit per kind.
- Models: `gemini-3.8-flash` first, `gemini-3.5-flash-lite` when the first is busy or does not start replying within 25 seconds. Both differ from the model that answers questions, so converting never uses the answers' quota. The two names are the defaults in `src/ingest/convert.ts`. A service also reads `GEMINI_CONVERT_MODEL` and `GEMINI_CONVERT_FALLBACK_MODEL` from its environment; to set them for every service, add them to `agent.env` and recreate the `rag-env` secret.
- Time: a conversion gets 230 seconds, because the whole upload has to finish inside the 5 minutes the front door and the relay wait. A file that needs longer is refused whole. In practice that is about 60 dense pages.
- `npx tsx scripts/check-convert.ts` checks the rules with a pretend model.

## Logs and status

```bash
sudo kubectl -n rem-raas-clients get pods                         # one line per client service
sudo kubectl -n rem-raas-backend get pods                         # the management API and the agent
sudo kubectl -n rem-raas-backend logs deployment/agent -f         # what the agent set up or removed
sudo kubectl -n rem-raas-backend logs deployment/management -f
sudo kubectl -n rem-raas-clients logs deployment/rag-<instanceId> -f
sudo kubectl -n rem-raas-clients describe pod -l instance=<instanceId>   # why a service's pod is not starting
sudo kubectl -n rem-raas-clients top pod                          # memory and CPU per service
journalctl -t rag-backup                                          # the nightly backup's failures, if any
```

A replaced pod's log goes with the pod. A pod that keeps crashing is restarted by Kubernetes with growing pauses; `describe pod` shows the reason.

Limits worth knowing: Kubernetes allows 110 pods on the node, so about 100 services. Each one uses about 27 MB of memory when idle.

## Database backups

A daily dump of the `rag_service` database, kept for 7 days in `/var/backups/rag`. It runs on the VPS itself, outside the cluster.

```bash
RAW=https://raw.githubusercontent.com/remuriin/RAG-API/main/deploy
sudo curl -fsS -o /usr/local/sbin/rag-backup $RAW/rag-backup && sudo chmod 755 /usr/local/sbin/rag-backup
sudo install -d -o postgres -g postgres -m 700 /var/backups/rag
sudo curl -fsS -o /etc/cron.d/rag-backup $RAW/rag-backup.cron && sudo chmod 644 /etc/cron.d/rag-backup
sudo -u postgres /usr/local/sbin/rag-backup      # run it once now
sudo ls -lh /var/backups/rag
```

It runs at 18:15 UTC (2:15 AM in the Philippines). A failed run is written to the journal (`journalctl -t rag-backup`). To be told about a night that didn't run at all, set `PING_URL` in `/usr/local/sbin/rag-backup` to a dead-man's-switch address (healthchecks.io has a free tier).

The dumps are on the same disk as the database, so they cover mistakes and bad deploys but not the loss of the VPS. For that, copy them off the machine: for example a second cron line that runs `rclone copy /var/backups/rag remote:rag-backups` to OCI Object Storage (free tier) after the dump.

Restore. Everything that uses the database must be stopped first: a restore drops and recreates the tables, which waits forever on connections that are still open, and the agent could set a service up in between.

Flux would put the backend back while it is stopped, so it is paused first and resumed after:

```bash
sudo flux suspend kustomization rag-api rag-api-agent --kubeconfig=/etc/rancher/k3s/k3s.yaml
sudo kubectl -n rem-raas-backend scale deployment/agent deployment/management-primary --replicas=0
sudo kubectl -n rem-raas-clients scale deployment -l app=rag --replicas=0
sudo -u postgres pg_restore --clean --if-exists --single-transaction -d rag_service /var/backups/rag/rag_service-YYYY-MM-DD.dump
sudo kubectl -n rem-raas-backend scale deployment/management-primary deployment/agent --replicas=1
sudo kubectl -n rem-raas-clients scale deployment -l app=rag --replicas=1
sudo flux resume kustomization rag-api rag-api-agent --kubeconfig=/etc/rancher/k3s/k3s.yaml
```

A service that exists in the restored database but has no pod gets one when the agent starts. A pod whose service is not in the restored database is left over: delete it with `sudo kubectl -n rem-raas-clients delete httproute,deployment,service rag-<instanceId>`.

## Before the cluster

Until 2026-10-13 the backend ran on systemd from a checkout in `/opt/rag`: `rag-management`, `rag-agent`, and one `rag@<instanceId>` unit per service with its own port, env file (`/etc/rag`) and nginx route file (`/etc/nginx/rag-instances`), all driven by a root-owned helper, `rag-ctl`. None of that exists any more, on the VPS or in this repository; the git history before that date has the files.

Until 2026-10-16 the front door was nginx on the VPS, with its site files in `deploy/nginx/` (one rule for every client's service, found by name through the cluster's DNS) and certificates from certbot. Envoy Gateway in the cluster replaced it; the git history before that date has the files.
