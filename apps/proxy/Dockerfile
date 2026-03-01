# Build stage
FROM node:20-alpine AS builder

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
COPY packages/types/package.json ./packages/types/

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
FROM node:20-alpine AS runner

# Install pnpm
RUN corepack enable && corepack prepare pnpm@8.15.0 --activate

WORKDIR /app

# Copy built application
COPY --from=builder /app/apps/proxy/dist ./apps/proxy/dist
COPY --from=builder /app/apps/proxy/package.json ./apps/proxy/
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3002

EXPOSE 3002

CMD ["node", "apps/proxy/dist/index.js"]
