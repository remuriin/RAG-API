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
sudo cp /opt/rag/deploy/nginx/rag.conf /etc/nginx/sites-available/rag.conf
sudo ln -s /etc/nginx/sites-available/rag.conf /etc/nginx/sites-enabled/rag.conf
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d rag.140-245-60-8.sslip.io
```

## Adding an instance

The instance must already exist in the `instances` table with an API key. Until the management API and control agent exist, create it from a machine that has the repo and database access:

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
sudo systemctl restart 'rag@*'
```

If the update changes the database schema, run `npm run db:migrate` (from a machine with the repo's `.env`) before restarting.

## Logs and status

```bash
systemctl list-units 'rag@*'
journalctl -u rag@$ID -f
```
