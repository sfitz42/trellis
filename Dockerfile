# Trellis server + web app (PLAN.md §11). Builds the monorepo, ships only the compiled server and
# the built SPA. acli, the trellis CLI and the Jira scripts are NOT in the image: they run on the
# facilitator's machine against the bind-mounted workspace.

# ---- build
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo

# Manifests first so the dependency layer is cached until they change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/cli/package.json packages/cli/
COPY packages/jira/package.json packages/jira/
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY . .
# tsc -b follows references (shared → server); Vite builds the SPA against shared's dist.
RUN pnpm exec tsc -b apps/server \
 && pnpm --filter @trellis/web build \
 && pnpm --filter @trellis/server deploy --prod --ignore-scripts /app

# ---- runtime
FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    WORKSPACE_DIR=/workspace \
    STATIC_DIR=/app/public
WORKDIR /app
COPY --from=build /app ./
COPY --from=build /repo/apps/web/dist ./public
RUN mkdir -p /workspace && chown node:node /workspace
USER node
VOLUME /workspace
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s CMD wget -qO- http://127.0.0.1:8080/api/status >/dev/null || exit 1
# Single replica only: the live state is held in this process (PLAN.md §11).
CMD ["node", "dist/main.js"]
