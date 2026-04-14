# SolidScheduler Backend Dockerfile
# Multi-stage build for optimized production image

# =============================================================================
# Stage 1: Dependencies
# =============================================================================
FROM node:20-alpine AS deps

WORKDIR /app

# Install git and openssh for GitHub dependency resolution via deploy key
RUN apk add --no-cache git openssh-client

# Copy package files
COPY package*.json ./

# Install production dependencies using SSH agent forwarding for private packages
RUN --mount=type=ssh npm install --omit=dev --install-links && npm cache clean --force

# =============================================================================
# Stage 2: Development (for local development with hot reload)
# =============================================================================
FROM node:20-alpine AS development

WORKDIR /app

# Install development tools
RUN apk add --no-cache git

# Copy package files and install all dependencies
COPY package*.json ./
RUN npm install

# Copy source code
COPY . .

# Expose port
EXPOSE 3001

# Development command with watch mode
CMD ["npm", "run", "dev"]

# =============================================================================
# Stage 3: Production
# =============================================================================
FROM node:20-alpine AS production

# Add labels for container identification
LABEL org.opencontainers.image.title="SolidScheduler Backend"
LABEL org.opencontainers.image.description="Privacy-first scheduling API with Solid Pod integration"
LABEL org.opencontainers.image.vendor="SolidScheduler"

# Create non-root user for security and install su-exec for entrypoint
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    apk add --no-cache su-exec

# Create data directory with correct ownership so SQLite can write
RUN mkdir -p /data && chown nodejs:nodejs /data

WORKDIR /app

# Copy production dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy source code
COPY --chown=nodejs:nodejs . .

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3001

# Expose port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3001/health || exit 1

# Entrypoint: fix /data ownership (handles pre-existing volumes) then drop to nodejs
ENTRYPOINT ["sh", "-c", "chown -R nodejs:nodejs /data && exec su-exec nodejs node src/server.js"]
