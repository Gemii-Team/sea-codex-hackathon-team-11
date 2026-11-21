.PHONY: up down check

up:
	docker compose up --build -d

down:
	docker compose down

check:
	go test ./...
	cd frontend && bun install --frozen-lockfile
	cd frontend && bun run --bun build
	docker compose config --quiet
