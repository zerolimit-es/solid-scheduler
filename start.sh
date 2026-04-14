#!/bin/bash
# =============================================================================
# SolidScheduler Quick Start Script
# =============================================================================
# Usage:
#   ./start.sh           - Start in development mode
#   ./start.sh prod      - Start in production mode
#   ./start.sh stop      - Stop all services
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $1"; }

check_prerequisites() {
    log_info "Checking prerequisites..."

    if ! command -v docker &> /dev/null; then
        log_error "Docker is not installed. Please install Docker first."
        exit 1
    fi

    if ! docker compose version &> /dev/null; then
        log_error "Docker Compose is not installed. Please install Docker Compose first."
        exit 1
    fi

    log_success "Prerequisites check passed"
}

setup_env() {
    if [ ! -f .env ]; then
        log_info "Creating .env file from .env.example..."
        cp .env.example .env
        log_warning "Please edit .env with your configuration before starting"
        log_warning "At minimum, set SESSION_SECRET to a secure random value:"
        log_warning "  SESSION_SECRET=\$(openssl rand -hex 32)"
        echo ""
        read -p "Press Enter to continue or Ctrl+C to exit and configure first..."
    fi
}

start_dev() {
    log_info "Starting SolidScheduler in DEVELOPMENT mode..."
    docker compose -f docker-compose.dev.yml up --build
}

start_prod() {
    log_info "Building frontend..."
    cd proton-scheduler-frontend && npm ci && rm -rf dist && npm run build && cd ..

    log_info "Starting SolidScheduler in PRODUCTION mode..."
    docker compose up -d --build

    log_success "SolidScheduler is starting..."
    echo ""
    sleep 5
    docker compose ps
    echo ""
    log_info "View logs with: docker compose logs -f"
}

stop_all() {
    log_info "Stopping SolidScheduler..."
    docker compose down 2>/dev/null || true
    docker compose -f docker-compose.dev.yml down 2>/dev/null || true
    log_success "All services stopped"
}

show_status() {
    log_info "Service Status:"
    docker compose ps
}

main() {
    echo ""
    echo "╔═══════════════════════════════════════════════════════════════╗"
    echo "║             SolidScheduler Docker Deployment                 ║"
    echo "║         Privacy-first scheduling with Solid Pods              ║"
    echo "╚═══════════════════════════════════════════════════════════════╝"
    echo ""

    check_prerequisites

    case "${1:-dev}" in
        dev|development)
            setup_env
            start_dev
            ;;
        prod|production)
            setup_env
            start_prod
            ;;
        stop)
            stop_all
            ;;
        status)
            show_status
            ;;
        *)
            echo "Usage: $0 {dev|prod|stop|status}"
            echo ""
            echo "Commands:"
            echo "  dev, development  - Start in development mode with hot reload"
            echo "  prod, production  - Start in production mode (detached)"
            echo "  stop              - Stop all services"
            echo "  status            - Show service status"
            exit 1
            ;;
    esac
}

main "$@"
