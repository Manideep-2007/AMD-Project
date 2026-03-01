# NexusOps — AI Autonomy & Governance Platform

> **Kubernetes for AI Agents** — Enterprise control plane for autonomous AI operations

## 🏗️ Architecture

NexusOps is a monorepo containing:

### Apps
- **`api`** — Fastify REST API + WebSocket server
- **`worker`** — Agent orchestration engine
- **`proxy`** — Tool proxy layer (GitHub, Jira, Cloud, DB)
- **`policy`** — Policy evaluation engine
- **`dashboard`** — React frontend (Vite + TypeScript)

### Packages
- **`@nexusops/sdk`** — TypeScript SDK for agent registration
- **`@nexusops/types`** — Shared TypeScript types
- **`@nexusops/db`** — Prisma schema + migrations
- **`@nexusops/logger`** — Structured logging (pino)
- **`@nexusops/queue`** — BullMQ abstractions

## 🚀 Quick Start

```bash
# Install dependencies
pnpm install

# Start all services (API, Worker, Proxy, Policy, Dashboard, Redis, Postgres)
docker-compose up

# Access services
# Dashboard:  http://localhost:3000
# API:        http://localhost:3001
# Jaeger UI:  http://localhost:16686
# BullMQ UI:  http://localhost:3002
```

## 📦 Development

```bash
# Run all services in dev mode
pnpm dev

# Run specific service
pnpm --filter @nexusops/api dev
pnpm --filter @nexusops/dashboard dev

# Build all
pnpm build

# Run tests
pnpm test

# Lint
pnpm lint
```

## 🔧 Environment Setup

Copy `.env.example` to `.env` and configure:

```bash
# Database
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/nexusops"

# Redis
REDIS_URL="redis://localhost:6379"

# JWT
JWT_SECRET="your-secret-key-change-in-production"
JWT_REFRESH_SECRET="your-refresh-secret-key"

# Supabase (for MVP)
SUPABASE_URL="your-supabase-url"
SUPABASE_ANON_KEY="your-supabase-anon-key"
```

## 📋 Tech Stack

- **Runtime**: Node.js 20 LTS + TypeScript
- **API**: Fastify + WebSocket
- **Frontend**: React + Vite + Tailwind + shadcn/ui
- **Database**: PostgreSQL 16 (via Supabase)
- **Cache/Queue**: Redis 7 + BullMQ
- **ORM**: Prisma
- **Telemetry**: OpenTelemetry + Jaeger
- **Containerization**: Docker + Docker Compose
- **Monorepo**: pnpm workspaces + Turbo

## 🔐 Security

- JWT authentication (15min access + 7day refresh)
- API key auth for agents
- RBAC enforcement
- Workspace isolation
- Rate limiting
- Input validation (Zod)
- Audit logging (immutable)

## 📊 Key Features

- ✅ Agent registration & lifecycle management
- ✅ Task orchestration with state machine
- ✅ Policy engine (< 5ms p99 latency)
- ✅ Tool proxy layer (GitHub, Jira, Cloud, DB)
- ✅ Real-time monitoring dashboard
- ✅ Cost tracking & token budgets
- ✅ Immutable audit trail
- ✅ Multi-tenant workspace isolation

## 📈 Roadmap

### MVP (Months 0-6) ✓
- Core platform infrastructure
- Policy engine v1
- Tool proxies (4 types)
- Real-time dashboard
- RBAC & auth

### Year 1
- ML anomaly detection
- Advanced analytics
- Policy simulation
- Agent marketplace

### Year 2+
- Federated learning
- Multi-cloud support
- Mobile app
- Enterprise features

## 🤝 Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md)

## 📄 License

Proprietary — All rights reserved
