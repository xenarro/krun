FROM node:26.7.0-bookworm-slim@sha256:4db36457f406501e6f608802e5da617e5fbd0e80b75901b6a09de1ae5a667d32 AS toolchain
WORKDIR /app
RUN npm install --prefix /opt/pnpm pnpm@12.14.0
ENV PATH="/opt/pnpm/node_modules/.bin:${PATH}"

FROM toolchain AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .node-version ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/sdk-node/package.json ./packages/sdk-node/package.json
COPY packages/cli/package.json ./packages/cli/package.json
COPY apps/gateway/package.json ./apps/gateway/package.json
COPY apps/scheduler/package.json ./apps/scheduler/package.json
RUN node -e "require('node:assert/strict').equal(process.version, 'v' + require('node:fs').readFileSync('.node-version', 'utf8').trim())"

FROM manifests AS build
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages/ ./packages/
COPY apps/ ./apps/
RUN pnpm -r build

# A fresh installation prevents unused development packages remaining in .pnpm.
FROM manifests AS production-dependencies
RUN pnpm install --prod --frozen-lockfile

# Registry history verified to execute Node 26.7.0, matching .node-version.
FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:f06197861512cb7ca773bd95f5d193fbbc48bde85710a358fb0bff71ebc7a2af AS runtime
WORKDIR /app
ENV NODE_ENV=production
ARG KRUN_VERSION=0.0.0
ARG KRUN_COMMIT=unknown
LABEL org.opencontainers.image.title="krun" \
      org.opencontainers.image.version="${KRUN_VERSION}" \
      org.opencontainers.image.revision="${KRUN_COMMIT}"
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=production-dependencies /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=production-dependencies /app/packages/cli/node_modules ./packages/cli/node_modules
COPY --from=production-dependencies /app/apps/gateway/node_modules ./apps/gateway/node_modules
COPY --from=production-dependencies /app/apps/scheduler/node_modules ./apps/scheduler/node_modules
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/sdk-node/dist ./packages/sdk-node/dist
COPY --from=build /app/packages/cli/dist ./packages/cli/dist
COPY --from=build /app/apps/gateway/dist ./apps/gateway/dist
COPY --from=build /app/apps/scheduler/dist ./apps/scheduler/dist
COPY --from=manifests /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=manifests /app/packages/sdk-node/package.json ./packages/sdk-node/package.json
COPY --from=manifests /app/packages/cli/package.json ./packages/cli/package.json
COPY --from=manifests /app/apps/gateway/package.json ./apps/gateway/package.json
COPY --from=manifests /app/apps/scheduler/package.json ./apps/scheduler/package.json
COPY --from=manifests /app/package.json /app/.node-version ./
COPY bin/krun.js ./bin/krun.js
USER 65532:65532
ENTRYPOINT ["/nodejs/bin/node", "/app/bin/krun.js"]
