# Build stage
# Using Node.js 22 LTS Alpine — minimal attack surface, significantly fewer CVEs than Debian.
# Note: Any remaining CVEs reported by scanners (e.g. VS Code Docker extension) are in the
# Node.js 22 runtime itself and cannot be resolved at the Dockerfile level. These are tracked
# and mitigated by the Snyk security scan step in .github/workflows/ci-cd.yml.
FROM node:22-alpine AS builder

# Install build dependencies (openssl required by Prisma; python3/make for native pg module)
RUN apk add --no-cache openssl python3 make g++

# Install pnpm
RUN corepack enable && corepack prepare pnpm@8.15.0 --activate

WORKDIR /app

# Copy workspace files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY turbo.json ./
COPY apps/proxy/package.json ./apps/proxy/
COPY packages/db/package.json ./packages/db/
COPY packages/logger/package.json ./packages/logger/
COPY packages/policy/package.json ./packages/policy/
COPY packages/policy-core/package.json ./packages/policy-core/
COPY packages/types/package.json ./packages/types/
COPY packages/events/package.json ./packages/events/
COPY packages/blast-radius/package.json ./packages/blast-radius/
COPY packages/injection/package.json ./packages/injection/
COPY packages/crypto/package.json ./packages/crypto/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY apps/proxy ./apps/proxy
COPY packages ./packages

# Generate Prisma Client
RUN pnpm --filter @nexusops/db generate

# Build the application
RUN pnpm --filter @nexusops/proxy build

# Production stage
FROM node:22-alpine AS runner

# Install runtime dependencies (openssl for Prisma, curl for docker-compose healthchecks)
RUN apk add --no-cache openssl curl

# Create non-root user
RUN addgroup -S nexusops && adduser -S -G nexusops nexusops

# Install pnpm
RUN corepack enable && corepack prepare pnpm@8.15.0 --activate

WORKDIR /app

# Copy built application
COPY --from=builder --chown=nexusops:nexusops /app/apps/proxy/dist ./apps/proxy/dist
COPY --from=builder --chown=nexusops:nexusops /app/apps/proxy/package.json ./apps/proxy/
COPY --from=builder --chown=nexusops:nexusops /app/packages ./packages
COPY --from=builder --chown=nexusops:nexusops /app/node_modules ./node_modules
COPY --from=builder --chown=nexusops:nexusops /app/package.json ./

# Switch to non-root user
USER nexusops

# Set environment variables
ENV NODE_ENV=production
ENV PROXY_PORT=3003

EXPOSE 3003

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3003/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1) })"

CMD ["node", "apps/proxy/dist/index.js"]
