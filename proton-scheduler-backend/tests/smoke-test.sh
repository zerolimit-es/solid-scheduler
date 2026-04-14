#!/usr/bin/env bash
#
# smoke-test.sh — Quick health + endpoint verification for staging/production
#
# Usage:
#   ./smoke-test.sh                           # defaults to http://localhost:3001
#   ./smoke-test.sh https://custom-url.example.com
#
# Exit codes:
#   0 = all checks passed
#   1 = one or more checks failed

set -euo pipefail

# ── Configuration ─────────────────────────────────────────────────────────

BASE_URL="${1:-http://localhost:3001}"
if [[ ! "$BASE_URL" =~ ^http ]]; then
  echo "Usage: $0 [<url>]  (default: http://localhost:3001)"; exit 1
fi

PASS=0
FAIL=0

# ── Helpers ───────────────────────────────────────────────────────────────

green()  { printf '\033[32m%s\033[0m\n' "$*"; }
red()    { printf '\033[31m%s\033[0m\n' "$*"; }

check() {
  local name="$1" expected_status="$2" url="$3"
  shift 3
  local extra_args=("$@")

  local http_code body
  body=$(curl -sS -w '\n%{http_code}' --max-time 10 "${extra_args[@]}" "$url" 2>&1) || true
  http_code=$(echo "$body" | tail -1)
  body=$(echo "$body" | sed '$d')

  if [[ "$http_code" == "$expected_status" ]]; then
    green "  ✓ $name (HTTP $http_code)"
    PASS=$((PASS + 1))
  else
    red "  ✗ $name — expected $expected_status, got $http_code"
    [[ -n "$body" ]] && echo "    Response: $(echo "$body" | head -3)"
    FAIL=$((FAIL + 1))
  fi
}

check_json_field() {
  local name="$1" url="$2" field="$3" expected="$4"

  local body
  body=$(curl -sS --max-time 10 "$url" 2>&1) || true

  local actual
  actual=$(echo "$body" | grep -o "\"$field\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 | sed 's/.*: *"\(.*\)"/\1/')

  if [[ "$actual" == "$expected" ]]; then
    green "  ✓ $name ($field=$actual)"
    PASS=$((PASS + 1))
  else
    red "  ✗ $name — expected $field=\"$expected\", got \"$actual\""
    FAIL=$((FAIL + 1))
  fi
}

check_contains() {
  local name="$1" needle="$2"
  shift 2
  local curl_args=("$@")

  local body
  body=$(curl -sS --max-time 10 "${curl_args[@]}" 2>&1) || true

  if echo "$body" | grep -q "$needle"; then
    green "  ✓ $name (contains '$needle')"
    PASS=$((PASS + 1))
  else
    red "  ✗ $name — response does not contain '$needle'"
    echo "    Got: $(echo "$body" | head -3)"
    FAIL=$((FAIL + 1))
  fi
}

check_header() {
  local name="$1" header="$2"
  shift 2
  local curl_args=("$@")

  local response
  response=$(curl -sS -D- --max-time 10 "${curl_args[@]}" 2>&1) || true

  if echo "$response" | grep -qi "$header"; then
    green "  ✓ $name"
    PASS=$((PASS + 1))
  else
    red "  ✗ $name"
    FAIL=$((FAIL + 1))
  fi
}

# ── Run Checks ────────────────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  SolidScheduler Smoke Tests"
echo "  Target: $BASE_URL"
echo "  Time:   $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# ── 1. Health Check ───────────────────────────────────────────────────────
echo "Health Check"
check "GET /health returns 200" 200 "$BASE_URL/health"
check_json_field "Health status is 'ok'" "$BASE_URL/health" "status" "ok"
echo ""

# ── 2. API Info ───────────────────────────────────────────────────────────
echo "API Info"
check "GET /api returns 200" 200 "$BASE_URL/api"
check_contains "API name present" "SolidScheduler" "$BASE_URL/api"
echo ""

# ── 3. Auth Endpoints ─────────────────────────────────────────────────────
echo "Auth Endpoints"
check "GET /api/auth/status returns 200" 200 "$BASE_URL/api/auth/status"
check "GET /api/auth/providers returns 200" 200 "$BASE_URL/api/auth/providers"
echo ""

# ── 4. Public Booking Page (read) ─────────────────────────────────────────
echo "Public Endpoints"
check "GET /api/public/:slug returns 200" 200 "$BASE_URL/api/public/nonexistent-slug-test"
echo ""

# ── 5. Validation (zod) ──────────────────────────────────────────────────
echo "Input Validation"
check "POST /api/public/:slug/book with bad data returns 400" 400 \
  "$BASE_URL/api/public/test-smoke/book" \
  -X POST -H 'Content-Type: application/json' \
  -d '{"date":"bad","time":"bad","name":"","email":"notanemail"}'

check_contains "Validation error has 'Validation failed'" "Validation failed" \
  -X POST -H 'Content-Type: application/json' \
  -d '{"date":"bad","time":"bad","name":"","email":"notanemail"}' \
  "$BASE_URL/api/public/test-smoke/book"

check_contains "Validation error has field details" "fields" \
  -X POST -H 'Content-Type: application/json' \
  -d '{"date":"bad","time":"bad","name":"","email":"notanemail"}' \
  "$BASE_URL/api/public/test-smoke/book"
echo ""

# ── 6. Rate Limiting ─────────────────────────────────────────────────────
echo "Rate Limiting"
check_header "RateLimit-Limit header present" "ratelimit-limit" \
  -X POST -H 'Content-Type: application/json' \
  -d '{"date":"2026-03-01","time":"10:00","name":"Smoke","email":"smoke@test.com"}' \
  "$BASE_URL/api/public/test-smoke/book"

check_header "RateLimit-Remaining header present" "ratelimit-remaining" \
  -X POST -H 'Content-Type: application/json' \
  -d '{"date":"2026-03-01","time":"10:00","name":"Smoke","email":"smoke@test.com"}' \
  "$BASE_URL/api/public/test-smoke/book"
echo ""

# ── 7. 404 handling ──────────────────────────────────────────────────────
echo "Error Handling"
check "GET /nonexistent returns 404" 404 "$BASE_URL/api/nonexistent-route-test"
echo ""

# ── Summary ───────────────────────────────────────────────────────────────

echo "═══════════════════════════════════════════════════════════════"
echo ""
if [[ $FAIL -eq 0 ]]; then
  green "  All $PASS checks passed ✓"
else
  red "  $FAIL check(s) failed, $PASS passed"
fi
echo ""
echo "═══════════════════════════════════════════════════════════════"

exit $FAIL