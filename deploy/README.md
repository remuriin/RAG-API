# Deploying to the VPS

Every RAG instance runs the same code from `/opt/rag` as its own systemd service (`rag@<instanceId>`), with its own env file and its own nginx route. The management API and the web app share the same host. Public URLs:

```
https://rag.remservers.me/                    the web app (dashboard)
https://rag.remservers.me/api/...             the management API
https://rag.remservers.me/i/<instanceId>/...  one client's service
```

The older name `rag.140-245-60-8.sslip.io` still answers, on the same certificate.

Commands below are run on the VPS unless stated otherwise. Needs: Ubuntu 22.04, Node **22 or newer** (20 is out of support since April 2026), Postgres with the `vector` extension, nginx, certbot.

## One-time setup

### 0. Database

```bash
sudo -u postgres psql -c "CREATE ROLE rag_app LOGIN PASSWORD 'PASSWORD';"
sudo -u postgres psql -c "CREATE DATABASE rag_service OWNER rag_app;"
sudo -u postgres psql -d rag_service -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

Postgres must listen on localhost only (the default); the VPS firewall and the OCI security list expose only 22, 80 and 443.

### 1. Code

```bash
which node          # if this is not /usr/bin/node, edit ExecStart in the three service files
sudo useradd --system --home /opt/rag --shell /usr/sbin/nologin rag
sudo git clone https://github.com/remuriin/RAG-API.git /opt/rag
cd /opt/rag
sudo npm ci
sudo npm run build
```

The code stays owned by root; the `rag` user only needs to read it. Do not put a `.env` file in `/opt/rag`.

### 2. systemd template

```bash
sudo cp /opt/rag/deploy/rag@.service /etc/systemd/system/rag@.service
sudo systemctl daemon-reload
sudo mkdir -p /etc/rag && sudo chmod 700 /etc/rag
```

### 3. nginx site and HTTPS

```bash
sudo install -d -o root -g root -m 755 /etc/nginx/rag-instances
sudo cp /opt/rag/deploy/nginx/headers.conf      /etc/nginx/snippets/rag-headers.conf
sudo cp /opt/rag/deploy/nginx/api-location.conf /etc/nginx/snippets/rag-api.conf
sudo cp /opt/rag/deploy/nginx/app-location.conf /etc/nginx/snippets/rag-app.conf
sudo cp /opt/rag/deploy/nginx/instance.conf.example /etc/nginx/snippets/rag-instance.template
sudo cp /opt/rag/deploy/nginx/rag.conf /etc/nginx/sites-available/rag.conf
sudo ln -s /etc/nginx/sites-available/rag.conf /etc/nginx/sites-enabled/rag.conf
sudo mkdir -p /var/www/rag-app        # the web app's files go here (see "The web app")
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d rag.remservers.me
```

Certbot edits the installed site file in place (adds the `listen 443` block and the HTTP→HTTPS redirect), so after this step never copy `deploy/nginx/rag.conf` over it again; apply later changes to the site file by hand. The snippets can be copied over freely.

## Control plane (management API + control agent)

With these two running, services are created and deleted through the management API and nothing below "Adding an instance by hand" is needed any more.

- **Management API** (`rag-management`): verifies Firebase logins, writes service requests, issues API keys, relays the dashboard's file and chat requests. Public at `/api/`.
- **Control agent** (`rag-agent`): no port. Polls the `instances` table and does the env file / systemd / nginx work for `pending` and `deleting` rows, through `rag-ctl`.

Run the schema migration first (`npm run db:migrate` from a machine with the repo's `.env` and a VPN or SSH tunnel to Postgres; it is safe to run again).

### 1. Update the code

```bash
cd /opt/rag
sudo git pull
sudo npm ci
sudo npm run build
```

### 2. Agent user and its permissions

```bash
sudo useradd --system --home /opt/rag --shell /usr/sbin/nologin ragagent
sudo chown -R ragagent:ragagent /etc/rag
sudo chmod 700 /etc/rag
sudo install -o root -g root -m 755 /opt/rag/deploy/rag-ctl /usr/local/sbin/rag-ctl
sudo install -o root -g root -m 440 /opt/rag/deploy/sudoers-rag-agent /etc/sudoers.d/rag-agent
sudo visudo -cf /etc/sudoers.d/rag-agent
```

The agent owns `/etc/rag` (the instance env files) and nothing else. Its only root access is `sudo /usr/local/sbin/rag-ctl`, which accepts `start <uuid>`, `stop <uuid>`, `route <uuid> <port>` and `unroute <uuid>`. The nginx route files in `/etc/nginx/rag-instances` are written by `rag-ctl` as root, from the root-owned template, so the agent never puts anything into nginx's configuration itself.

### 3. Env files

```bash
sudo mkdir -p /etc/rag-control && sudo chmod 700 /etc/rag-control
sudo nano /etc/rag-control/management.env
sudo nano /etc/rag-control/agent.env
sudo chmod 600 /etc/rag-control/management.env /etc/rag-control/agent.env
```

`management.env` (all five are required):

```
DATABASE_URL=postgres://rag_app:PASSWORD@localhost:5432/rag_service
FIREBASE_PROJECT_ID=rag-service-remuriin
PUBLIC_BASE_URL=https://rag.remservers.me
MGMT_PORT=4050
INTERNAL_SECRET=THE_SAME_RANDOM_VALUE_IN_BOTH_FILES
```

`agent.env` (the database URL, Gemini key and internal secret here are what the agent writes into each instance's env file):

```
DATABASE_URL=postgres://rag_app:PASSWORD@localhost:5432/rag_service
GEMINI_API_KEY=YOUR_KEY
INTERNAL_SECRET=THE_SAME_RANDOM_VALUE_IN_BOTH_FILES
```

`INTERNAL_SECRET` is what lets the management API call an instance on the owner's behalf (the dashboard's file and chat pages). Generate one with `openssl rand -hex 32`. It must be identical in both files; if it isn't, the dashboard's file and chat pages answer "the service is not responding" and the management log says why.

**Changing a setting later.** Every time the agent starts, it compares each running instance's env file with its own current settings and, where they differ, rewrites the file and restarts that instance. So to change the Gemini key or the internal secret: edit `agent.env` (and `management.env` for the secret), then `sudo systemctl restart rag-agent rag-management`.

### 4. Services

```bash
sudo cp /opt/rag/deploy/rag-management.service /opt/rag/deploy/rag-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now rag-management rag-agent
systemctl status rag-management rag-agent --no-pager
curl http://127.0.0.1:4050/api/health      # {"status":"ok","agent":"ok"} once the agent has polled
```

`/api/health` needs no login: it says whether the database answers and whether the agent has checked in within the last minute (`agent: "stale"` and a 503 otherwise). Point an external pinger at `https://rag.remservers.me/api/health` so a dead agent is noticed.

### Using it

From a machine with the repo's `.env` (which has the test account), `npm run dev:firebase-token` prints a login token valid for an hour. With it as `TOKEN`:

```bash
API=https://rag.remservers.me/api
curl -X POST $API/instances -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"name":"My service","productName":"Acme"}'
curl $API/instances -H "Authorization: Bearer $TOKEN"                 # status goes pending -> active
curl -X POST $API/instances/<id>/key -H "Authorization: Bearer $TOKEN"   # the API key, shown once
curl -X DELETE $API/instances/<id> -H "Authorization: Bearer $TOKEN"
```

Logs: `journalctl -u rag-agent -f` and `journalctl -u rag-management -f`.

## The web app

The dashboard is a static build from the `RaaS` repository (`frontend/`). nginx serves it at `/` from `/var/www/rag-app`; nothing runs for it, so a redeploy is a file copy and needs no nginx reload.

On the PC, in `RaaS/frontend`:

```bash
npm run build
```

Copy `dist/` to the VPS (for example with `scp -r dist/ user@vps:/tmp/rag-app`), then on the VPS:

```bash
sudo rm -rf /var/www/rag-app.new
sudo cp -r /tmp/rag-app /var/www/rag-app.new
sudo chown -R root:root /var/www/rag-app.new && sudo chmod -R a+rX /var/www/rag-app.new
sudo rm -rf /var/www/rag-app.old
sudo mv /var/www/rag-app /var/www/rag-app.old 2>/dev/null; sudo mv /var/www/rag-app.new /var/www/rag-app
```

The snippet `rag-app.conf` already sets the caching (`index.html` never cached, `/assets/` cached for a year), the security headers and a Content-Security-Policy that allows Firebase's sign-in pop-up. The app itself reloads when a tab open from before the deploy asks for a file that no longer exists.

Before the first deploy, in the Firebase console, `rag.remservers.me` must be on Authentication → Settings → Authorized domains (it is).

## Adding an instance by hand

Only needed without the control plane. The instance must already exist in the `instances` table with an API key; create it from a machine that has the repo and database access:

```bash
npm run dev:create-instance -- "<instance name>" ["<product name>"]
```

It prints the `INSTANCE_ID`, the `PORT`, and the API key (shown once).

Then, on the VPS, with `ID` and `PORT` set to those values:

```bash
ID=<instanceId>
PORT=<port>

# 1. env file (root-only; it holds the database password and the Gemini key)
sudo tee /etc/rag/$ID.env > /dev/null <<EOF
INSTANCE_ID=$ID
PORT=$PORT
DATABASE_URL="postgres://rag_app:PASSWORD@localhost:5432/rag_service"
GEMINI_API_KEY="YOUR_KEY"
EOF
sudo chmod 600 /etc/rag/$ID.env
sudo nano /etc/rag/$ID.env      # fill in PASSWORD (URL-encoded, e.g. # as %23) and the Gemini key

# 2. service and route
sudo rag-ctl start $ID
curl http://127.0.0.1:$PORT/health
sudo rag-ctl route $ID $PORT

# 3. from anywhere
curl https://rag.remservers.me/i/$ID/health
```

## Removing an instance

```bash
sudo rag-ctl stop $ID
sudo rag-ctl unroute $ID
sudo rm /etc/rag/$ID.env
```

Then delete its row from `instances`; its keys, documents and chunks are removed with it.

## Updating the code

All instances share one checkout, so they are updated together:

```bash
cd /opt/rag
sudo git pull
sudo npm ci
sudo npm run build
sudo systemctl restart 'rag@*' rag-management rag-agent
```

If the update changes the database schema, run `npm run db:migrate` (from a machine with the repo's `.env`) before restarting. If it changes a file under `deploy/`, copy that file to its place again (service files need `sudo systemctl daemon-reload`; nginx snippets need `sudo nginx -t && sudo systemctl reload nginx`; `rag-ctl` needs the `install` line from step 2).

## Logs and status

```bash
systemctl list-units 'rag@*'
journalctl -u rag@$ID -f
journalctl -t rag-backup           # the nightly backup's failures, if any
```

A unit that fails to start 5 times within 10 minutes is left stopped (so a broken instance doesn't restart every 5 seconds forever). `rag-ctl start` clears that state; by hand it is `sudo systemctl reset-failed rag@$ID`.

## Database backups

A daily dump of the `rag_service` database, kept for 7 days in `/var/backups/rag`.

```bash
sudo install -o root -g root -m 755 /opt/rag/deploy/rag-backup /usr/local/sbin/rag-backup
sudo install -d -o postgres -g postgres -m 700 /var/backups/rag
sudo install -o root -g root -m 644 /opt/rag/deploy/rag-backup.cron /etc/cron.d/rag-backup
sudo -u postgres /usr/local/sbin/rag-backup      # run it once now
sudo ls -lh /var/backups/rag
```

It runs at 18:15 UTC (2:15 AM in the Philippines). A failed run is written to the journal (`journalctl -t rag-backup`). To be told about a night that didn't run at all, set `PING_URL` in `/usr/local/sbin/rag-backup` to a dead-man's-switch address (healthchecks.io has a free tier).

The dumps are on the same disk as the database, so they cover mistakes and bad deploys but not the loss of the VPS. For that, copy them off the machine: for example a second cron line that runs `rclone copy /var/backups/rag remote:rag-backups` to OCI Object Storage (free tier) after the dump.

Restore. The services must be stopped first: a restore drops and recreates the tables, which waits forever on connections that are still open, and the agent could provision in between.

```bash
sudo systemctl stop 'rag@*' rag-management rag-agent
sudo -u postgres pg_restore --clean --if-exists --single-transaction -d rag_service /var/backups/rag/rag_service-YYYY-MM-DD.dump
sudo systemctl start rag-management rag-agent
sudo systemctl start 'rag@*'
```
