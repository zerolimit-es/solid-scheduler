# SolidScheduler Frontend Dockerfile
# Multi-stage build for optimized production image
#
# Build context must be the REPO ROOT (not proton-scheduler-frontend/).
#
# Usage:
#   docker build -f proton-scheduler-frontend/Dockerfile .
#   docker compose build frontend

# =============================================================================
# Stage 1: Dependencies
# =============================================================================
FROM node:20-alpine AS deps

WORKDIR /app

# Install git and openssh for GitHub dependency resolution via deploy key
RUN apk add --no-cache git openssh-client

# Copy package files (from repo root context)
COPY proton-scheduler-frontend/package*.json ./

# Install all dependencies using SSH agent forwarding for private packages
# Use npm install (not npm ci) to resolve platform-specific optional deps correctly
RUN --mount=type=ssh rm -f package-lock.json && npm install && npm cache clean --force

# =============================================================================
# Stage 2: Builder
# =============================================================================
FROM node:20-alpine AS builder

# Mirror the repo layout so Vite's ../cloud/frontend alias resolves correctly
WORKDIR /workspace/proton-scheduler-frontend

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy frontend source
COPY proton-scheduler-frontend/ ./

# Build arguments for environment variables
ARG VITE_API_URL=http://localhost:3001

# Set environment variable for build
ENV VITE_API_URL=$VITE_API_URL

# Build the application
RUN npm run build

# =============================================================================
# Stage 3: Development (for local development with hot reload)
# =============================================================================
FROM node:20-alpine AS development

WORKDIR /workspace/proton-scheduler-frontend

# Copy package files and install dependencies
COPY proton-scheduler-frontend/package*.json ./
RUN npm ci

# Copy source code
COPY proton-scheduler-frontend/ ./

# Expose port
EXPOSE 3000

# Development command with hot reload
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]

# =============================================================================
# Stage 4: Production with Nginx
# =============================================================================
FROM nginx:alpine AS production

# Add labels
LABEL org.opencontainers.image.title="SolidScheduler Frontend"
LABEL org.opencontainers.image.description="Privacy-first scheduling UI with Solid Pod integration"
LABEL org.opencontainers.image.vendor="SolidScheduler"

# Remove default nginx config
RUN rm /etc/nginx/conf.d/default.conf

# Copy custom nginx config
COPY proton-scheduler-frontend/nginx.conf /etc/nginx/conf.d/

# Copy built assets from builder stage
COPY --from=builder /workspace/proton-scheduler-frontend/dist /usr/share/nginx/html

# Add non-root user permissions
RUN chown -R nginx:nginx /usr/share/nginx/html && \
    chown -R nginx:nginx /var/cache/nginx && \
    chown -R nginx:nginx /var/log/nginx && \
    touch /var/run/nginx.pid && \
    chown -R nginx:nginx /var/run/nginx.pid

# Expose port
EXPOSE 80

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:80/health || exit 1

# Start nginx
CMD ["nginx", "-g", "daemon off;"]
