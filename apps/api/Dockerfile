# Build stage
FROM node:22-bookworm-slim AS builder

# Install security updates
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
    openssl \
    && rm -rf /var/lib/apt/lists/*

# Install pnpm
RUN corepack enable && corepack prepare pnpm@8.15.0 --activate

WORKDIR /app

# Copy workspace files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY turbo.json ./
COPY apps/api/package.json ./apps/api/
COPY packages/db/package.json ./packages/db/
COPY packages/logger/package.json ./packages/logger/
COPY packages/policy/package.json ./packages/policy/
COPY packages/queue/package.json ./packages/queue/
COPY packages/types/package.json ./packages/types/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY apps/api ./apps/api
COPY packages ./packages

# Generate Prisma Client
RUN pnpm --filter @nexusops/db generate

# Build the application
RUN pnpm --filter @nexusops/api build

# Production stage
FROM node:22-bookworm-slim AS runner

# Install security updates
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
    openssl \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd -r nexusops && useradd -r -g nexusops nexusops

# Install pnpm
RUN corepack enable && corepack prepare pnpm@8.15.0 --activate

WORKDIR /app

# Copy built application
COPY --from=builder --chown=nexusops:nexusops /app/apps/api/dist ./apps/api/dist
COPY --from=builder --chown=nexusops:nexusops /app/apps/api/package.json ./apps/api/
COPY --from=builder --chown=nexusops:nexusops /app/packages ./packages
COPY --from=builder --chown=nexusops:nexusops /app/node_modules ./node_modules
COPY --from=builder --chown=nexusops:nexusops /app/package.json ./

# Switch to non-root user
USER nexusops

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3001/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1) })"

CMD ["node", "apps/api/dist/index.js"]
