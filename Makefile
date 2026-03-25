.PHONY: dev dev-up dev-down build logs status clean

# ── Development ──
dev:
	cd proton-scheduler-frontend && npm run dev

dev-up:
	docker compose up -d backend redis
	@echo "✓ Backend: http://localhost:3001 — Run 'make dev' for frontend"

dev-down:
	docker compose stop backend redis

# ── Production ──
build:
	cd proton-scheduler-frontend && npm install --include=dev && npm run build
	docker compose up -d --build
	@echo "✓ Production build complete"

# ── Utilities ──
logs:
	docker compose logs -f backend nginx --tail 50

status:
	@docker compose ps

clean:
	docker compose down -v
	docker system prune -f
