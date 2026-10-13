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

The older name `rag.140-245-60-8.sslip.io` still answers, on the same certificate.

```
cluster (k3s)
└── node: rem-vm (the VPS)
    ├── namespace rem-raas             the web app (from the RaaS repository)
    ├── namespace rem-raas-backend
    │   ├── pod: management            10.43.0.83, where nginx sends /api
    │   └── pod: agent                 no address
    └── namespace rem-raas-clients
        └── pod: rag-<instanceId>      one per service, found by name
```

Outside the cluster, on the VPS itself: nginx (the only thing the internet talks to), Postgres, and the nightly database dump.

Commands below are run on the VPS unless stated otherwise. Needs: Ubuntu 22.04, k3s (see the `Cluster` repository), Postgres with the `vector` extension, nginx, certbot. Node is not needed on the VPS: nothing is built or run there outside the cluster.

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

```bash
sudo kubectl apply -f https://raw.githubusercontent.com/remuriin/RAG-API/main/k8s/namespaces.yaml
sudo kubectl -n rem-raas-clients create secret generic rag-env        --from-env-file=/etc/rag-control/agent.env
sudo kubectl -n rem-raas-backend create secret generic management-env --from-env-file=/etc/rag-control/management.env
sudo kubectl -n rem-raas-backend create secret generic agent-env      --from-env-file=/etc/rag-control/agent.env
```

`rag-env` is shared by every client's service; which service a pod is, is set on the pod itself. `sudo kubectl -n <namespace> describe secret <name>` lists the names and sizes, never the values.

**Changing a setting later.** A pod reads its settings once, when it starts. Edit the file, delete the secret and create it again, then restart what uses it:

```bash
sudo kubectl -n rem-raas-backend rollout restart deployment/management deployment/agent
sudo kubectl -n rem-raas-clients rollout restart deployment -l app=rag
```

### 3. The management API and the agent

```bash
sudo kubectl apply -f https://raw.githubusercontent.com/remuriin/RAG-API/main/k8s/management.yaml
sudo kubectl -n rem-raas-backend rollout status deployment/management --timeout=120s
curl -s http://10.43.0.83/api/health       # {"status":"ok","agent":"ok"} once the agent has polled

sudo kubectl apply -f https://raw.githubusercontent.com/remuriin/RAG-API/main/k8s/agent.yaml
sudo kubectl -n rem-raas-backend rollout status deployment/agent --timeout=180s
```

The management pod brings the database schema up to date before it starts (its start command runs `dist/scripts/migrate.js` first), so there is no separate migration step.

`agent.yaml` also holds what the agent may do in the cluster, and that is all it can do: create, read, change and delete Deployments and Services in `rem-raas-clients`. It cannot read secrets, cannot touch its own namespace, and has no access to the VPS.

`/api/health` needs no login: it says whether the database answers and whether the agent has checked in within the last minute (`agent: "stale"` and a 503 otherwise). Point a monitor at `https://rag.remservers.me/api/health`, so a dead agent is noticed.

### 4. nginx site and HTTPS

```bash
RAW=https://raw.githubusercontent.com/remuriin/RAG-API/main/deploy/nginx
sudo curl -fsS -o /etc/nginx/snippets/rag-headers.conf   $RAW/headers.conf
sudo curl -fsS -o /etc/nginx/snippets/rag-api.conf       $RAW/api-location.conf
sudo curl -fsS -o /etc/nginx/snippets/rag-app.conf       $RAW/app-location.conf
sudo curl -fsS -o /etc/nginx/snippets/rag-errors.conf    $RAW/errors.conf
sudo curl -fsS -o /etc/nginx/snippets/rag-instances.conf $RAW/instances.conf
sudo curl -fsS -o /etc/nginx/sites-available/rag.conf    $RAW/rag.conf
sudo ln -s /etc/nginx/sites-available/rag.conf /etc/nginx/sites-enabled/rag.conf
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d rag.remservers.me
```

Certbot edits the installed site file in place (adds the `listen 443` block and the HTTP→HTTPS redirect), so after this step never copy `rag.conf` over it again; apply later changes to the site file by hand. The snippets can be copied over freely.

`rag-instances.conf` is one rule for every client's service. nginx finds the pod `rag-<instanceId>` by name, asking the cluster's own name lookup (`10.43.0.10`) per request, so nothing in nginx changes when a service is created or deleted. An address whose id has no service answers with the JSON 503 of `rag-errors.conf`; an id that is not a UUID answers 404.

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

It fills in `k8s/client.yaml` (a copy is inside the image) with the service's id and with the agent's own image, and hands the result to Kubernetes: a Deployment and a Service, both named `rag-<instanceId>`. Then it waits until the pod answers `/health` and marks the row `active`. For a `deleting` row it deletes both and then the row.

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

A push to `main` that touches the code runs `.github/workflows/image.yml`, and that is the deploy:

1. **check**: the check scripts that need no database, model or cluster.
2. **build**: the image is built on an ARM machine and stored as `ghcr.io/remuriin/rag-api`, tagged `main` and with the commit.
3. **deploy**: the cluster is told to run that commit, the management API first, then the agent. It logs in to the VPS as the `deploy` user with this repository's key (the `DEPLOY_KEY` secret), which can do one thing: ask `k8s-deploy` to change an image in `rem-raas-backend`. The key is made once with `sudo /opt/cluster/k8s-add-project rem-raas-backend`; see the `Cluster` repository.

The management pod migrates the database and starts. The agent, when it starts, brings every client's service to its own build, one at a time, waiting for each to answer before the next. It only reports ready once all of them run it.

If a service does not come up on the new build, the agent puts that service back on the build it ran before and stops without reporting ready. `k8s-deploy` then gives up after two minutes, brings the previous agent back (which returns the services already moved), and the run turns red. The management API stays on the new build in that case; a build whose management API does not start never gets as far as the agent.

By hand, on the VPS:

```bash
sudo kubectl -n rem-raas-backend rollout undo deployment/agent          # back to the previous build, services included
sudo kubectl -n rem-raas-backend rollout undo deployment/management
sudo kubectl -n rem-raas-backend rollout restart deployment/agent       # start the agent again, same build
```

A change to a file in `k8s/` is applied with `sudo kubectl apply -f <its raw address>`. A change to `k8s/client.yaml` reaches the services with the next build, since the agent reads its copy from the image. A changed nginx snippet is copied again (`curl` line above), then `sudo nginx -t && sudo systemctl reload nginx`.

## The web app

The dashboard is built from the `RaaS` repository (`frontend/`) into a container image, and runs as one pod in the namespace `rem-raas`. nginx forwards `/` to that pod's service at the fixed inside-only address `10.43.0.80`. The cluster files are in `RaaS/k8s/`.

A push to `main` in `RaaS` that touches `frontend/` runs the linter, builds the image, stores it as `ghcr.io/remuriin/raas-web` (tagged `main` and with the commit), and makes the cluster run it. How that works, and the script on the VPS that does it, is in the `Cluster` repository. By hand, on the VPS:

```bash
sudo kubectl -n rem-raas rollout undo deployment/web        # back to the previous image
sudo kubectl -n rem-raas rollout history deployment/web     # what it has run
```

The old pod keeps serving until the new one answers its health check, so there is no gap. No nginx reload is needed.

The container sets the caching (`index.html` never cached, `/assets/` cached for a year). The snippet `rag-app.conf` adds the security headers and a Content-Security-Policy that allows Firebase's sign-in pop-up. The app itself reloads when a tab open from before the deploy asks for a file that no longer exists.

If the web app's pod is down, `/` answers 502 while `/api/` and `/i/` keep working. `sudo kubectl -n rem-raas get pods` and `sudo kubectl -n rem-raas describe pod -l app=web` say why.

Before the first deploy, in the Firebase console, `rag.remservers.me` must be on Authentication → Settings → Authorized domains (it is).

## Files a service accepts

A service takes `.md`, `.txt`, `.pdf`, `.html` and `.xml` files. Markdown and plain text are stored as they are. A PDF, a web page and XML are first written out as markdown by a Gemini model, and only that markdown is kept.

- Limits: 10 MB for a PDF, 500 KB for the others. nginx allows 11 MB (`client_max_body_size` in the site file), the service applies the real limit per kind.
- Models: `gemini-3.8-flash` first, `gemini-3.5-flash-lite` when the first is busy or does not start replying within 25 seconds. Both differ from the model that answers questions, so converting never uses the answers' quota. The two names are the defaults in `src/ingest/convert.ts`. A service also reads `GEMINI_CONVERT_MODEL` and `GEMINI_CONVERT_FALLBACK_MODEL` from its environment; to set them for every service, add them to `agent.env` and recreate the `rag-env` secret.
- Time: a conversion gets 230 seconds, because the whole upload has to finish inside the 5 minutes nginx and the relay wait. A file that needs longer is refused whole. In practice that is about 60 dense pages.
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

```bash
sudo kubectl -n rem-raas-backend scale deployment/agent deployment/management --replicas=0
sudo kubectl -n rem-raas-clients scale deployment -l app=rag --replicas=0
sudo -u postgres pg_restore --clean --if-exists --single-transaction -d rag_service /var/backups/rag/rag_service-YYYY-MM-DD.dump
sudo kubectl -n rem-raas-backend scale deployment/management deployment/agent --replicas=1
sudo kubectl -n rem-raas-clients scale deployment -l app=rag --replicas=1
```

A service that exists in the restored database but has no pod gets one when the agent starts. A pod whose service is not in the restored database is left over: delete it with `sudo kubectl -n rem-raas-clients delete deployment,service rag-<instanceId>`.

## Before the cluster

Until 2026-10-13 the backend ran on systemd from a checkout in `/opt/rag`: `rag-management`, `rag-agent`, and one `rag@<instanceId>` unit per service with its own port, env file (`/etc/rag`) and nginx route file (`/etc/nginx/rag-instances`), all driven by a root-owned helper, `rag-ctl`. None of that exists any more, on the VPS or in this repository; the git history before that date has the files.
