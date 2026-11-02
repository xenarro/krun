FROM node:26.7.0-bookworm-slim@sha256:4db36457f406501e6f608802e5da617e5fbd0e80b75901b6a09de1ae5a667d32 AS build
WORKDIR /app
COPY . .
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --ignore-scripts --no-audit --no-fund; else npm install --omit=dev --ignore-scripts --no-audit --no-fund; fi

FROM node:26.7.0-bookworm-slim@sha256:4db36457f406501e6f608802e5da617e5fbd0e80b75901b6a09de1ae5a667d32 AS runtime
WORKDIR /app
ENV NODE_ENV=production HOME=/tmp
COPY --from=build /app /app
USER 65532:65532
STOPSIGNAL SIGTERM
CMD ["node", "handler.js"]
