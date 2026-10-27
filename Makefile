.DEFAULT_GOAL := check
IMAGE ?= krun:local

.PHONY: build test lint check generate docker kind-up kind-down e2e helm-lint

build:
	pnpm -r build

test: build
	pnpm -r exec vitest run
	pnpm test
	uv run --directory sdk/python pytest

lint: build
	pnpm -r lint
	pnpm run lint
	uv run --directory sdk/python ruff check .
	uv run --directory sdk/python ruff format --check .
	uv run --directory sdk/python mypy --strict

check: lint test
	pnpm exec knip

generate:
	@set -eu; for script in $(sort $(wildcard scripts/gen-*.ts)); do node "$$script"; done

docker:
	docker build --tag "$(IMAGE)" .

kind-up:
	node test/e2e/cluster.ts up

kind-down:
	node test/e2e/cluster.ts down

e2e: kind-up
	node test/e2e/cluster.ts verify
	pnpm exec vitest run --config test/e2e/vitest.config.ts

helm-lint:
	helm lint deploy/helm/krun
