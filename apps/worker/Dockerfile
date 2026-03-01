# Build stage
# Using Node.js 22 LTS with Debian Bookworm Slim
# Note: Base image CVE warnings are mitigated via apt-get upgrade + non-root user
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
COPY apps/worker/package.json ./apps/worker/
COPY packages/db/package.json ./packages/db/
COPY packages/logger/package.json ./packages/logger/
COPY packages/policy/package.json ./packages/policy/
COPY packages/queue/package.json ./packages/queue/
COPY packages/types/package.json ./packages/types/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY apps/worker ./apps/worker
COPY packages ./packages

# Generate Prisma Client
RUN pnpm --filter @nexusops/db generate

# Build the application
RUN pnpm --filter @nexusops/worker build

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
COPY --from=builder --chown=nexusops:nexusops /app/apps/worker/dist ./apps/worker/dist
COPY --from=builder --chown=nexusops:nexusops /app/apps/worker/package.json ./apps/worker/
COPY --from=builder --chown=nexusops:nexusops /app/packages ./packages
COPY --from=builder --chown=nexusops:nexusops /app/node_modules ./node_modules
COPY --from=builder --chown=nexusops:nexusops /app/package.json ./

# Switch to non-root user
USER nexusops

# Set environment variables
ENV NODE_ENV=production

CMD ["node", "apps/worker/dist/index.js"]
