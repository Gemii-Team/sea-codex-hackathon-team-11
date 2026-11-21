.PHONY: up down check plan-aws plan-tencent apply-aws apply-tencent

up:
	docker compose up --build -d

down:
	docker compose down

check:
	go test ./...
	if test -f frontend/package-lock.json; then npm --prefix frontend ci; else npm --prefix frontend install; fi
	npm --prefix frontend run build
	docker compose config --quiet

plan-aws plan-tencent: plan-%:
	tofu -chdir=infra/$* init -input=false
	tofu -chdir=infra/$* plan -input=false -out=sandbox.tfplan

apply-aws apply-tencent: apply-%:
	tofu -chdir=infra/$* show sandbox.tfplan
	@printf 'Apply the reviewed %s plan? Type yes: ' '$*'; read -r answer && test "$$answer" = yes
	tofu -chdir=infra/$* apply -input=false sandbox.tfplan
