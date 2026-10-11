# A new project in the cluster

What a project needs to run in the VPS's Kubernetes cluster and deploy on a push to `main`, and the order to do it in. Two scripts do the fiddly parts; the rest is a checklist.

It fits a repository shaped like `RaaS` and `RemServers`: a web app in `frontend/` (built with `npm run build` into `dist/`) and, optionally, a Node backend in `backend/` (`npm run build` into `dist/`, started with `node dist/server.js` on port 3000). Anything else: change the two Dockerfiles.

How the cluster and the pipeline work is written up in `Kubernetes-and-pipeline.md`.

## Before you start: pick three things

- **A project name**, lowercase with dashes (`my-app`). It becomes the namespace and the start of the image names.
- **The site name** (`my-app.remservers.me`).
- **One free address per pod**, from `10.43.0.83` up. See which are taken, on the VPS:

```bash
sudo kubectl get svc -A
```

## 1. Put the files in the repository (PC, Git Bash)

From the `RAG-API` folder. Leave the last address out for a project with no backend.

```bash
deploy/k8s-new-project ../MyApp my-app my-app.remservers.me 10.43.0.83 10.43.0.84
```

It writes `frontend/Dockerfile`, `frontend/nginx.conf`, `frontend/.dockerignore`, `k8s/namespace.yaml`, `k8s/web.yaml`, `nginx-site.conf`, `.github/workflows/image.yml` and, with a backend, `backend/Dockerfile`, `backend/.dockerignore`, `k8s/api.yaml`. It never overwrites a file and commits nothing.

Then look at three things in what it wrote:

- **Values the web app needs while building** (Vite's `VITE_` ones): an `ARG` line each in `frontend/Dockerfile`, and the same names under `build-args` in the workflow. Both have a commented example.
- **The backend's readiness address** in `k8s/api.yaml`: an address that answers 200 without a login. The template asks `/`.
- **Settings that say `localhost`** in the backend's `.env`: inside a pod that is the pod itself. Name the VPS by its own address, `10.0.0.135`, in the `env:` part of `k8s/api.yaml` (commented example there).

## 2. GitHub: the variables

Repository → Settings → Secrets and variables → Actions → **Variables** tab: one variable per `ARG` line from step 1. Skip this if there are none.

## 3. VPS: the deploy key

```bash
cd /opt/rag && sudo git pull
sudo /opt/rag/deploy/k8s-add-project my-app
```

It prints a private key once. Copy all of it, the `BEGIN` and `END` lines included, into the repository's **secret** `DEPLOY_KEY` (same page as step 2, **Secrets** tab).

## 4. Commit and push

The first run builds the images and then fails in `deploy`, because nothing exists in the cluster yet. That is expected; the images are what this step is for.

## 5. GitHub: make the images public

Profile → Packages → `my-app-web` (and `my-app-api`) → Package settings → Change visibility → Public. Once per image. The cluster downloads without a login.

## 6. VPS: start it in the cluster

```bash
sudo kubectl apply -f https://raw.githubusercontent.com/remuriin/MyApp/main/k8s/namespace.yaml
```

With a backend, its settings first (the file is your own `.env`, with plain unquoted values), and if it uses Postgres on the VPS nothing more is needed: the firewall already lets pods reach port 5432.

```bash
sudo kubectl -n my-app create secret generic backend-env --from-env-file=/path/to/.env
sudo kubectl apply -f https://raw.githubusercontent.com/remuriin/MyApp/main/k8s/api.yaml
sudo kubectl -n my-app rollout status deployment/api --timeout=120s
```

Then the web app:

```bash
sudo kubectl apply -f https://raw.githubusercontent.com/remuriin/MyApp/main/k8s/web.yaml
sudo kubectl -n my-app rollout status deployment/web --timeout=120s
sudo kubectl -n my-app get pods,svc
curl -s http://10.43.0.83/healthz        # ok
```

If a pod does not come up: `sudo kubectl -n my-app describe pod -l app=api` and `sudo kubectl -n my-app logs deployment/api`.

## 7. The site: DNS, nginx, certificate

1. In Cloudflare, an `A` record for the site name pointing at the VPS ("DNS only"), or a route in the tunnel to `https://localhost:443`.
2. On the VPS, with `nginx-site.conf` from the repository:

```bash
sudo curl -fsSL -o /etc/nginx/sites-available/my-app https://raw.githubusercontent.com/remuriin/MyApp/main/nginx-site.conf
sudo ln -s /etc/nginx/sites-available/my-app /etc/nginx/sites-enabled/my-app
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d my-app.remservers.me
```

## 8. Prove the pipeline

On the failed run's page: **Re-run jobs → Re-run failed jobs**. `deploy` should go green and print `my-app/web now runs <commit>`. From then on, a push to `main` is the deploy.

## 9. Write it down

Add the project to `Kubernetes-and-pipeline.md`: the table of namespaces and addresses, and the picture.

## Taking a project out again

```bash
sudo kubectl delete namespace my-app                       # its pods, services and secrets
sudo rm /etc/nginx/sites-enabled/my-app && sudo nginx -t && sudo systemctl reload nginx
```

and delete its line from `/home/deploy/.ssh/authorized_keys`.
