# Deploying to the VPS

Every RAG instance runs the same code from `/opt/rag` as its own systemd service (`rag@<instanceId>`), with its own env file and its own nginx route. Public URL:

```
https://rag.140-245-60-8.sslip.io/i/<instanceId>/...
```

Commands below are run on the VPS unless stated otherwise.

## One-time setup

### 1. Code

```bash
which node          # if this is not /usr/bin/node, edit ExecStart in deploy/rag@.service
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
sudo mkdir -p /etc/nginx/rag-instances
sudo cp /opt/rag/deploy/nginx/api-location.conf /etc/nginx/snippets/rag-api.conf
sudo cp /opt/rag/deploy/nginx/rag.conf /etc/nginx/sites-available/rag.conf
sudo ln -s /etc/nginx/sites-available/rag.conf /etc/nginx/sites-enabled/rag.conf
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d rag.140-245-60-8.sslip.io
```

## Control plane (management API + control agent)

With these two running, services are created and deleted through the management API and nothing below "Adding an instance by hand" is needed any more.

- **Management API** (`rag-management`): verifies Firebase logins, writes service requests, issues API keys. Public at `https://rag.140-245-60-8.sslip.io/api/`.
- **Control agent** (`rag-agent`): no port. Polls the `instances` table and does the env file / systemd / nginx work for `pending` and `deleting` rows.

Run the schema migration first (`npm run db:migrate` from a machine with the repo's `.env`).

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
sudo chown -R ragagent:ragagent /etc/rag /etc/nginx/rag-instances
sudo chmod 700 /etc/rag
sudo install -o root -g root -m 755 /opt/rag/deploy/rag-ctl /usr/local/sbin/rag-ctl
sudo install -o root -g root -m 440 /opt/rag/deploy/sudoers-rag-agent /etc/sudoers.d/rag-agent
sudo visudo -cf /etc/sudoers.d/rag-agent
```

The agent owns the two folders it writes to. Its only root access is `sudo /usr/local/sbin/rag-ctl`, which accepts `start <uuid>`, `stop <uuid>` and `reload-nginx`.

### 3. Env files

```bash
sudo mkdir -p /etc/rag-control && sudo chmod 700 /etc/rag-control
sudo nano /etc/rag-control/management.env
sudo nano /etc/rag-control/agent.env
sudo chmod 600 /etc/rag-control/management.env /etc/rag-control/agent.env
```

`management.env`:

```
DATABASE_URL=postgres://rag_app:PASSWORD@localhost:5432/rag_service
FIREBASE_PROJECT_ID=rag-service-remuriin
PUBLIC_BASE_URL=https://rag.140-245-60-8.sslip.io
```

`agent.env` (the database URL and Gemini key here are what the agent writes into each new instance's env file):

```
DATABASE_URL=postgres://rag_app:PASSWORD@localhost:5432/rag_service
GEMINI_API_KEY=YOUR_KEY
```

### 4. Services

```bash
sudo cp /opt/rag/deploy/rag-management.service /opt/rag/deploy/rag-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now rag-management rag-agent
systemctl status rag-management rag-agent --no-pager
curl -i http://127.0.0.1:4000/api/me      # 401 "Missing login token" means it is up
```

### 5. nginx route for the API

Certbot edited the installed site file, so don't copy `deploy/nginx/rag.conf` over it. The route lives in its own snippet file; the site file only needs one `include` line, added right after the line that includes the instance routes:

```bash
sudo cp /opt/rag/deploy/nginx/api-location.conf /etc/nginx/snippets/rag-api.conf
sudo sed -i '/rag-instances\/\*\.conf;/a\    include /etc/nginx/snippets/rag-api.conf;' /etc/nginx/sites-available/rag.conf
grep -n "include" /etc/nginx/sites-available/rag.conf     # the new line should appear exactly once
sudo nginx -t && sudo systemctl reload nginx
```

### Using it

From a machine with the repo's `.env` (which has the test account), `npm run dev:firebase-token` prints a login token valid for an hour. With it as `TOKEN`:

```bash
API=https://rag.140-245-60-8.sslip.io/api
curl -X POST $API/instances -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"name":"My service","productName":"Acme"}'
curl $API/instances -H "Authorization: Bearer $TOKEN"                 # status goes pending -> active
curl -X POST $API/instances/<id>/key -H "Authorization: Bearer $TOKEN"   # the API key, shown once
curl -X DELETE $API/instances/<id> -H "Authorization: Bearer $TOKEN"
```

Logs: `journalctl -u rag-agent -f` and `journalctl -u rag-management -f`.

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
DATABASE_URL=postgres://rag_app:PASSWORD@localhost:5432/rag_service
GEMINI_API_KEY=YOUR_KEY
EOF
sudo chmod 600 /etc/rag/$ID.env
sudo nano /etc/rag/$ID.env      # fill in PASSWORD (URL-encoded, e.g. # as %23) and the Gemini key

# 2. service
sudo systemctl enable --now rag@$ID
systemctl status rag@$ID --no-pager
curl http://127.0.0.1:$PORT/health

# 3. nginx route
sed "s/INSTANCE_ID/$ID/g; s/PORT/$PORT/g" /opt/rag/deploy/nginx/instance.conf.example \
  | sudo tee /etc/nginx/rag-instances/$ID.conf > /dev/null
sudo nginx -t && sudo systemctl reload nginx

# 4. from anywhere
curl https://rag.140-245-60-8.sslip.io/i/$ID/health
```

## Removing an instance

```bash
sudo systemctl disable --now rag@$ID
sudo rm /etc/rag/$ID.env /etc/nginx/rag-instances/$ID.conf
sudo nginx -t && sudo systemctl reload nginx
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

If the update changes the database schema, run `npm run db:migrate` (from a machine with the repo's `.env`) before restarting.

## Logs and status

```bash
systemctl list-units 'rag@*'
journalctl -u rag@$ID -f
```
