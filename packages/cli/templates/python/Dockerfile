FROM ghcr.io/astral-sh/uv:0.13.1@sha256:4a1f3666816dafadd20ceb71eac9a7d56d7ef30279f7d64048519ab901ada336 AS uv
FROM python:3.13.15-slim-bookworm@sha256:2325bb286ec344af3e5898cc224b5844e2707ac6e26b1632516fd3edc84a5e26 AS build
WORKDIR /app
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_PYTHON_DOWNLOADS=never UV_LINK_MODE=copy
COPY . .
RUN if [ -f uv.lock ]; then uv sync --locked --no-dev --no-install-project; else uv sync --no-dev --no-install-project; fi

FROM python:3.13.15-slim-bookworm@sha256:2325bb286ec344af3e5898cc224b5844e2707ac6e26b1632516fd3edc84a5e26 AS runtime
WORKDIR /app
ENV PATH="/app/.venv/bin:${PATH}" HOME=/tmp PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY --from=build /app /app
USER 65532:65532
STOPSIGNAL SIGTERM
CMD ["python", "handler.py"]
