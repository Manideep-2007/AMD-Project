# NexusOps Platform — Quick Start Guide

## 🚀 Getting Started

### Prerequisites
- **Node.js** 20+ and **pnpm** 8+
- **Docker** and **Docker Compose**
- **PostgreSQL** 16+ (or use Docker)
- **Redis** 7+ (or use Docker)

### Installation

```bash
# 1. Clone the repository
cd agent-nexus-main

# 2. Install dependencies
pnpm install

# 3. Copy environment variables
cp .env.example .env
# Edit .env with your configuration

# 4. Start infrastructure services (PostgreSQL, Redis, Jaeger)
docker-compose up -d

# 5. Run database migrations
pnpm db:migrate

# 6. Seed demo data
pnpm db:seed

# 7. Start all services in development mode
pnpm dev
```

### Services will be available at:
- **Dashboard**: http://localhost:3000
- **API**: http://localhost:3001
- **API Docs**: http://localhost:3001/documentation
- **Jaeger UI** (tracing): http://localhost:16686
- **BullMQ Board** (queue monitoring): http://localhost:3002

## 📝 Demo Credentials

After seeding, you can log in with:
- **Owner**: `owner@nexusops.dev` / `password123`
- **Admin**: `admin@nexusops.dev` / `password123`

## 🏗️ Project Structure

```
agent-nexus-main/
├── apps/
│   ├── api/         # Fastify REST API + WebSocket
│   ├── worker/      # Agent orchestration engine
│   ├── proxy/       # Tool proxy layer
│   └── dashboard/   # React frontend (existing)
├── packages/
│   ├── db/          # Prisma schema + migrations
│   ├── types/       # Shared TypeScript types
│   ├── logger/      # Structured logging (pino)
│   ├── queue/       # BullMQ abstractions
│   └── policy/      # Policy evaluation engine
├── docker-compose.yml
└── turbo.json
```

## 🔧 Development Commands

```bash
# Start all services
pnpm dev

# Start specific service
pnpm --filter @nexusops/api dev
pnpm --filter @nexusops/worker dev
pnpm --filter @nexusops/dashboard dev

# Build all
pnpm build

# Run tests
pnpm test

# Database operations
pnpm db:migrate      # Run migrations
pnpm db:studio       # Open Prisma Studio
pnpm db:seed         # Seed demo data

# Docker operations
pnpm docker:up       # Start infrastructure
pnpm docker:down     # Stop infrastructure
pnpm docker:logs     # View logs
```

## 📚 API Documentation

### Authentication

All API endpoints require authentication via JWT or API key.

**Login:**
```bash
POST /api/v1/auth/login
{
  "email": "owner@nexusops.dev",
  "password": "password123"
}
```

**Response:**
```json
{
  "data": {
    "accessToken": "eyJ...",
    "refreshToken": "eyJ...",
    "user": { ... },
    "workspace": { ... }
  }
}
```

### Key Endpoints

**Agents:**
- `POST /api/v1/agents` — Register agent
- `GET /api/v1/agents` — List agents
- `GET /api/v1/agents/:id` — Get agent details
- `DELETE /api/v1/agents/:id` — Deregister agent

**Tasks:**
- `POST /api/v1/tasks` — Submit task
- `GET /api/v1/tasks` — List tasks
- `GET /api/v1/tasks/:id` — Get task details
- `POST /api/v1/tasks/:id/cancel` — Cancel task
- `POST /api/v1/tasks/:id/approve` — Approve escalated action

**Policies:**
- `POST /api/v1/policies` — Create policy rule
- `GET /api/v1/policies` — List policies
- `PUT /api/v1/policies/:id` — Update policy
- `DELETE /api/v1/policies/:id` — Disable policy

**Metrics:**
- `GET /api/v1/metrics/cost` — Cost dashboard data
- `GET /api/v1/metrics/usage` — Token usage time series
- `GET /api/v1/metrics/health` — System health

**WebSocket:**
- `ws://localhost:3001/ws/tasks?workspaceId=xxx` — Real-time task updates
- `ws://localhost:3001/ws/agents?workspaceId=xxx` — Real-time agent status

## 🧪 Testing

Run the policy engine test suite to verify < 5ms p99 latency:

```bash
pnpm --filter @nexusops/policy test
```

## 🔐 Security Notes

- **Never commit `.env` files**
- Change default JWT secrets in production
- Use strong passwords for database and Redis
- Enable TLS for all external connections
- Review and customize policy rules for your use case

## 📖 Next Steps

1. **Customize Policies**: Edit policy rules in the dashboard or via API
2. **Register Agents**: Use the SDK to register your AI agents
3. **Configure Tool Proxies**: Add your GitHub, Jira, and cloud credentials
4. **Monitor Operations**: Use the dashboard to monitor agent activity
5. **Review Audit Logs**: Check compliance in the audit log

## 🆘 Troubleshooting

**Database connection errors:**
```bash
# Ensure PostgreSQL is running
docker-compose ps postgres

# Check connection
psql postgresql://postgres:postgres@localhost:5432/nexusops
```

**Redis connection errors:**
```bash
# Ensure Redis is running
docker-compose ps redis

# Test connection
redis-cli -h localhost -p 6379 ping
```

**Port conflicts:**
```bash
# Check what's using a port
netstat -ano | findstr :3001  # Windows
lsof -i :3001                 # Mac/Linux
```

## 📞 Support

- Documentation: [See inline code comments]
- Issues: [Your repository issues]
- Email: support@nexusops.dev

---

**Built with ❤️ for enterprise AI autonomy and governance**
