# Local development stacks (see NEW-DEPLOY-STEP-BY-STEP.md, Part I).
#
# Both stacks auto-read the gitignored root .env for interpolation — GCP needs
# SESSION_PASSWORD + FIREBASE_CLIENT_CONFIG, self-host needs GARAGE_* — so no
# inline vars are required. The two variable sets are disjoint; one .env serves
# both.
#
# Intel/amd64 hosts: the compose files pin platform: linux/arm64 (Apple
# Silicon). If that runs slowly under emulation, add an override that sets
# services.app.platform: linux/amd64 (see the "two locals" note in the docs).

.DEFAULT_GOAL := help
.PHONY: help gcp mongo down-gcp down-mongo

help: ## Show available targets
	@grep -hE '^[a-z-]+:.*?##' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  make %-11s %s\n", $$1, $$2}'

gcp: ## GCP shape: Firestore + Firebase Auth + Storage emulators (app :3001, UI :4000)
	docker compose -f docker-compose.gcr.yml up --build

mongo: ## Self-host shape: mongo + redis + garage S3 (app :3000)
	docker compose up --build

down-gcp: ## Stop and remove the GCP stack
	docker compose -f docker-compose.gcr.yml down

down-mongo: ## Stop and remove the self-host stack
	docker compose down
