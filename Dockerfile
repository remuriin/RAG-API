# The whole backend as one container image: the RAG service, the management API and the control agent.
# They are the same code started with a different command (see the three "start" scripts in package.json);
# the cluster picks the command, this image only sets the most common one.
#
# Built on the same kind of CPU it runs on (ARM), so nothing is emulated.

# Step 1: all packages, and TypeScript turned into JavaScript in dist/.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# Step 2 is the image that runs: the packages the code needs to run (no TypeScript, no tsx) and dist/.
FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# what one client's service looks like; the control agent fills it in for every service it sets up
COPY k8s/client.yaml ./k8s/client.yaml
# The image's own name, commit included. The control agent starts each client's service from the
# image it runs itself, so all three pieces are always the same build.
ARG GIT_SHA=main
ENV RAG_IMAGE=ghcr.io/remuriin/rag-api:${GIT_SHA}
# the image's built-in user that is not root
USER node
EXPOSE 3000
# the settings (database, keys, which service this is) are not in the image: Kubernetes hands them in
CMD ["node", "dist/src/server.js"]
