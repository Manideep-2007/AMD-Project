# NexusOps System Architecture

> **Kubernetes for AI Agents** — Enterprise Control Plane for Autonomous AI Operations

---

## 🏗️ Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         Client Layer                             │
├─────────────────────────────────────────────────────────────────┤
│  React Dashboard (Vite)                                          │
│  - Authentication UI                                             │
│  - Real-time monitoring                                          │
│  - Policy management                                             │
│  - Agent controls                                                │
└────────────────┬────────────────────────────────────────────────┘
                 │ HTTP/WebSocket
                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                      API Gateway Layer                           │
├─────────────────────────────────────────────────────────────────┤
│  Fastify API Server (@nexusops/api)                              │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Auth:        JWT + API Keys (RBAC)                       │   │
│  │ Endpoints:   /agents, /tasks, /policies, /tools, /audit │   │
│  │ WebSocket:   Real-time task & agent updates             │   │
│  │ Security:    Rate limiting, CORS, Helmet, input valid.  │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────┬──────────────────────────┬────────────────────────────────┘
      │                          │
      ▼                          ▼
┌─────────────────┐    ┌──────────────────────────────────────────┐
│  Policy Engine  │◄───┤         Worker Layer                     │
│  (@nexusops/    │    ├──────────────────────────────────────────┤
│   policy)       │    │ Agent Orchestration Worker               │
│                 │    │ (@nexusops/worker)                        │
│ ✓ < 5ms p99     │    │                                           │
│ ✓ Priority-based│    │ ┌──────────────────────────────────────┐ │
│ ✓ Cached        │    │ │ • Task Execution Engine              │ │
│ ✓ Audited       │    │ │ • Agent Lifecycle Management         │ │
└─────────────────┘    │ │ • Budget Enforcement                 │ │
                       │ │ • Metrics Collection                 │ │
                       │ │ • Heartbeat Monitoring               │ │
                       │ └──────────────────────────────────────┘ │
                       └────────┬─────────────────────────────────┘
                                │
                                ▼
                       ┌──────────────────────────────────────────┐
                       │      Tool Proxy Layer                     │
                       │      (@nexusops/proxy)                    │
                       ├──────────────────────────────────────────┤
                       │                                           │
                       │  ┌────────────┐  ┌────────────┐          │
                       │  │  GitHub    │  │   Jira     │          │
                       │  │  Proxy     │  │   Proxy    │          │
                       │  └────────────┘  └────────────┘          │
                       │                                           │
                       │  ┌────────────┐  ┌────────────┐          │
                       │  │  Database  │  │   Cloud    │          │
                       │  │  Proxy     │  │   Deploy   │          │
                       │  └────────────┘  └────────────┘          │
                       │                                           │
                       │  Policy-Driven Access Control            │
                       │  ✓ Allowlist model                       │
                       │  ✓ Audit every call                      │
                       │  ✓ Block dangerous operations            │
                       └──────────────────────────────────────────┘
                                │
                                ▼
                       ┌──────────────────────────────────────────┐
                       │      External Services                    │
                       ├──────────────────────────────────────────┤
                       │  • GitHub API                             │
                       │  • Jira API                               │
                       │  • AWS/GCP/Azure APIs                     │
                       │  • Customer Databases                     │
                       └──────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                      Data Layer                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────────────┐    ┌──────────────────────────┐   │
│  │   PostgreSQL 16          │    │   Redis 7                │   │
│  │   (@nexusops/db)         │    │   (@nexusops/queue)      │   │
│  ├─────────────────────────┤    ├──────────────────────────┤   │
│  │ • Workspaces             │    │ • Task queue (BullMQ)    │   │
│  │ • Users (RBAC)           │    │ • Job scheduling         │   │
│  │ • Agents                 │    │ • Rate limit state       │   │
│  │ • Tasks                  │    │ • Policy cache           │   │
│  │ • Policies               │    └──────────────────────────┘   │
│  │ • Tool calls (audit)     │                                   │
│  │ • Audit events (append)  │                                   │
│  │ • Metrics (time-series)  │                                   │
│  └─────────────────────────┘                                   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                   Observability Layer                            │
├─────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │   Pino       │  │   Jaeger     │  │   BullMQ Board       │  │
│  │   (Logs)     │  │   (Traces)   │  │   (Queue Monitor)    │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🔄 Request Flow

### 1. **Task Submission Flow**

```
User → Dashboard → API (/api/v1/tasks)
                    │
                    ├─ Authenticate (JWT/API Key)
                    ├─ Validate input (Zod)
                    ├─ Check RBAC
                    ├─ Create Task (DB)
                    ├─ Queue Job (Redis/BullMQ)
                    └─ Return Task ID
                    
Worker picks up job → Execute Task
                      │
                      ├─ Load Agent config
                      ├─ Update status: RUNNING
                      ├─ Execute agent logic
                      │   │
                      │   └─ Tool call needed?
                      │       │
                      │       ├─ Evaluate Policy
                      │       │   │
                      │       │   ├─ ALLOW → Execute via Proxy
                      │       │   ├─ DENY → Block & log
                      │       │   └─ ESCALATE → Human approval
                      │       │
                      │       └─ Log tool call (audit)
                      │
                      ├─ Track tokens & cost
                      ├─ Update status: COMPLETED/FAILED
                      └─ Broadcast via WebSocket
```

### 2. **Policy Evaluation Flow**

```
Tool Call Request → Policy Engine
                    │
                    ├─ Load rules (cached, 60s TTL)
                    ├─ Sort by priority (DESC)
                    ├─ Evaluate conditions:
                    │   ├─ Tool type
                    │   ├─ Environment
                    │   ├─ User role
                    │   ├─ Time window
                    │   └─ Custom rules
                    │
                    ├─ First match wins
                    │   ├─ ALLOW → Proceed
                    │   ├─ DENY → Block
                    │   └─ ESCALATE → Queue approval
                    │
                    └─ Log evaluation (< 5ms)
```

### 3. **Authentication Flow**

```
Login Request → API (/api/v1/auth/login)
                │
                ├─ Validate credentials
                ├─ Check workspace membership
                ├─ Generate JWT access token (15min)
                ├─ Generate JWT refresh token (7d)
                ├─ Store refresh token (DB)
                └─ Return tokens

API Request → Middleware
              │
              ├─ Verify JWT signature
              ├─ Check expiration
              ├─ Load user context
              ├─ Enforce RBAC
              └─ Proceed or 401/403
```

---

## 📦 Package Dependencies

```
┌──────────────────────────────────────────────────────────────┐
│                         Apps Layer                            │
├──────────────────────────────────────────────────────────────┤
│  @nexusops/api                                                │
│  └─ depends on: db, logger, policy, queue, types             │
│                                                               │
│  @nexusops/worker                                             │
│  └─ depends on: db, logger, policy, queue, types             │
│                                                               │
│  @nexusops/proxy                                              │
│  └─ depends on: logger, types                                │
└──────────────────────────────────────────────────────────────┘
               │                   │                   │
               ▼                   ▼                   ▼
┌──────────────────────────────────────────────────────────────┐
│                      Packages Layer                           │
├──────────────────────────────────────────────────────────────┤
│  @nexusops/policy                                             │
│  └─ depends on: db, logger, types                            │
│                                                               │
│  @nexusops/queue                                              │
│  └─ depends on: logger, types                                │
│                                                               │
│  @nexusops/types                                              │
│  └─ depends on: db (re-exports)                              │
│                                                               │
│  @nexusops/logger                                             │
│  └─ depends on: none (base package)                          │
│                                                               │
│  @nexusops/db                                                 │
│  └─ depends on: @prisma/client                               │
└──────────────────────────────────────────────────────────────┘
```

---

## 🔐 Security Architecture

### Defense in Depth

**Layer 1: Network**
- HTTPS/TLS only
- CORS with strict origin whitelist
- Rate limiting (per-IP, per-API-key)

**Layer 2: Authentication**
- JWT with short expiry (15min)
- Refresh token rotation
- API keys hashed (SHA-256), never stored plaintext
- Password hashing with bcrypt (10 rounds)

**Layer 3: Authorization**
- RBAC: Owner > Admin > Operator > Viewer
- Workspace isolation (enforced at DB middleware)
- Policy-driven tool access

**Layer 4: Input Validation**
- Zod schemas on all inputs
- Prisma parameterized queries (no SQL injection)
- File upload restrictions (not implemented yet)

**Layer 5: Audit & Monitoring**
- Immutable audit log (append-only)
- All destructive actions logged
- User ID + IP + timestamp on every event

---

## 📊 Data Flow Patterns

### Write Path
```
API → Validation → RBAC Check → DB Write → Queue Job → Audit Log
```

### Read Path
```
API → RBAC Check → DB Query (scoped by workspace) → Response
```

### Real-time Path
```
Worker → Event → WebSocket Broadcast → Connected Clients
```

---

## 🚀 Deployment Architecture (Recommended)

```
┌────────────────────────────────────────────────────────────────┐
│                         AWS/GCP/Azure                           │
├────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │                   Load Balancer (ALB/NLB)                 │ │
│  │                   - TLS Termination                       │ │
│  │                   - Health checks                         │ │
│  └─────────────────────┬─────────────────────────────────────┘ │
│                        │                                        │
│  ┌─────────────────────┴─────────────────────────────────────┐ │
│  │            Container Orchestration (ECS/K8s)              │ │
│  ├───────────────────────────────────────────────────────────┤ │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐               │ │
│  │  │   API    │  │  Worker  │  │  Proxy   │               │ │
│  │  │  (3x)    │  │  (2x)    │  │  (2x)    │               │ │
│  │  └──────────┘  └──────────┘  └──────────┘               │ │
│  │                                                           │ │
│  │  Auto-scaling based on:                                  │ │
│  │  - Queue depth                                           │ │
│  │  - CPU/Memory                                            │ │
│  │  - Request rate                                          │ │
│  └───────────────────────────────────────────────────────────┘ │
│                        │                                        │
│  ┌─────────────────────┴─────────────────────────────────────┐ │
│  │                   Managed Services                        │ │
│  ├───────────────────────────────────────────────────────────┤ │
│  │  • RDS PostgreSQL (Multi-AZ)                             │ │
│  │  • ElastiCache Redis (Cluster mode)                      │ │
│  │  • CloudWatch Logs & Metrics                             │ │
│  │  • Secrets Manager                                       │ │
│  │  • S3 (audit log archival)                               │ │
│  └───────────────────────────────────────────────────────────┘ │
│                                                                 │
└────────────────────────────────────────────────────────────────┘
```

---

## 🎯 Scalability Considerations

### Horizontal Scaling
- **API**: Stateless, scale to N instances behind load balancer
- **Worker**: Queue-based, add workers to increase throughput
- **Proxy**: Stateless, scale independently

### Vertical Scaling
- **Database**: RDS instance size, read replicas
- **Redis**: Cluster mode for high throughput

### Performance Targets
- **API Response Time**: < 100ms p95
- **Policy Evaluation**: < 5ms p99 ✅
- **Task Queue Processing**: 1000+ jobs/second
- **WebSocket Connections**: 10,000+ concurrent

---

## 🔧 Monitoring & Alerting

### Metrics to Track
- Queue depth (alert if > 1000)
- Policy evaluation latency (alert if > 5ms p99)
- Error rate (alert if > 1%)
- Task throughput (tasks/hour)
- Cost burn rate ($/day)
- Database connection pool usage

### Logging Strategy
- **Structured JSON logs** (pino)
- **Log levels**: error, warn, info, debug
- **Correlation IDs**: Request ID, Trace ID
- **Retention**: 30 days hot, 1 year archive

---

## 🛠️ Technology Stack Summary

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Frontend** | React + Vite + TypeScript | Dashboard UI |
| **API** | Fastify + TypeScript | REST + WebSocket |
| **Auth** | JWT + bcrypt | Authentication |
| **Database** | PostgreSQL 16 + Prisma | Data persistence |
| **Queue** | Redis + BullMQ | Job processing |
| **Logging** | Pino | Structured logs |
| **Tracing** | OpenTelemetry + Jaeger | Distributed tracing |
| **Container** | Docker + Docker Compose | Local dev |
| **Orchestration** | Kubernetes / ECS | Production |
| **CI/CD** | GitHub Actions | Automation |
| **IaC** | Terraform | Infrastructure |

---

**This architecture is production-ready, scalable, and secure.**
