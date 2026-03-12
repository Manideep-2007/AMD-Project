# ECC × NexusOps Integration Setup

Complete guide for connecting **Everything Claude Code** (ECC) to **NexusOps** for enterprise-grade AI agent governance.

---

## Architecture Overview

```
┌────────────────────┐     hooks (fire-and-forget)      ┌────────────────────┐
│  Everything Claude  │ ─────────────────────────────── ▶│   NexusOps API     │
│  Code (ECC)         │   nexusops-audit-emit.js         │   /api/v1/ecc/*    │
│                     │   cost-tracker.js                │                    │
│  17 Agent Personas  │                                  │  Prisma + Postgres │
│  Hook System        │ ◀ ─── GET /instincts ─────────── │  BullMQ Workers    │
│  CLAUDE.md configs  │      governance rules            │  Audit Chain       │
└────────────────────┘                                  └────────────────────┘
```

## Prerequisites

- NexusOps instance running (Docker or Kubernetes)
- PostgreSQL 16+ with Prisma migrations applied
- Redis 7+ for BullMQ job queue
- Node.js 20+ on the ECC side

## Quick Start

### 1. Generate NexusOps API Key

In the NexusOps dashboard:
1. Go to **Settings → API Keys**
2. Click **Create API Key**
3. Name it `ecc-integration`
4. Copy the key (shown only once)

### 2. Configure ECC Environment

Add to your ECC environment (`.env`, shell profile, or CI):

```bash
# NexusOps API endpoint
NEXUSOPS_API_URL=https://api.nexusops.dev

# API key from step 1
NEXUSOPS_AGENT_API_KEY=nxk_...

# Your NexusOps workspace ID (visible in Settings → Workspace)
NEXUSOPS_WORKSPACE_ID=ws_abc123

# HMAC webhook secret (optional but recommended for production)
# Must match ECC_WEBHOOK_SECRET on the NexusOps side
ECC_WEBHOOK_SECRET=your-shared-secret-at-least-32-chars
```

### 3. Configure NexusOps Environment

Add to NexusOps `.env` or deployment config:

```bash
# Must match ECC_WEBHOOK_SECRET above
ECC_WEBHOOK_SECRET=your-shared-secret-at-least-32-chars
```

### 4. Run Database Migration

```bash
cd packages/db
npx prisma migrate dev --name ecc-integration
```

### 5. Sync ECC Agents

In the NexusOps dashboard:
1. Navigate to **Dev Intelligence** (sidebar)
2. Click **Sync Agents**
3. Verify 17 agents appear in the registry

Or via API:
```bash
curl -X POST https://api.nexusops.dev/api/v1/ecc/agents/sync \
  -H "Authorization: Bearer <YOUR_JWT_TOKEN>"
```

## Integration Endpoints

| Endpoint | Method | Auth | Purpose |
|:---------|:-------|:-----|:--------|
| `/api/v1/ecc/events` | POST | API Key | Receives hook events from `nexusops-audit-emit.js` |
| `/api/v1/ecc/session/cost` | POST | API Key | Receives cost data from `cost-tracker.js` |
| `/api/v1/ecc/agents` | GET | JWT | Lists registered ECC agents |
| `/api/v1/ecc/agents/sync` | POST | JWT | Upserts all 17 ECC agents + policies + budgets |
| `/api/v1/ecc/instincts` | GET | API Key | Returns governance instincts for ECC hooks |
| `/api/v1/ecc/instincts/refresh` | POST | API Key | Triggers instinct regeneration job |
| `/api/v1/ecc/status` | GET | JWT | Integration health and session stats |
| `/api/v1/ecc/cost-summary` | GET | JWT | Combined dev + prod cost breakdown (30d) |

## Event Flow

### Hook Events (`nexusops-audit-emit.js`)
Events sent with `ECC_` prefix:

| Event Type | Trigger | Data |
|:-----------|:--------|:-----|
| `ECC_SESSION_STARTED` | Session begins | `sessionIdShort`, `projectHash`, `nodeVersion` |
| `ECC_SESSION_COMPLETED` | Session ends | `transcriptPathHash`, `stopReason`, `recentCosts` |
| `ECC_TOOL_ABOUT_TO_EXECUTE` | Pre-tool hook | `toolName`, `inputHash` |
| `ECC_TOOL_EXECUTED` | Post-tool hook | `toolName`, `exitCode`, `outputHash`, `success` |
| `ECC_CONTEXT_COMPACTED` | Context window compaction | `reason`, `sessionIdShort` |
| `ECC_HOOK_FIRED` | Unknown hook type | `hookEvent` |

### Cost Events (`cost-tracker.js`)
Sent as snake_case JSON:
```json
{
  "timestamp": "2025-01-15T10:30:00.000Z",
  "session_id": "sess_abc123",
  "model": "claude-sonnet-4-20250514",
  "input_tokens": 1000,
  "output_tokens": 500,
  "estimated_cost_usd": 0.0225
}
```

## Security

### HMAC Signature Verification
When `ECC_WEBHOOK_SECRET` is set on both sides:
- ECC hooks compute `sha256=HMAC(secret, body)` and send via `x-ecc-signature` header
- NexusOps verifies using timing-safe comparison
- Invalid signatures are rejected with `401 INVALID_SIGNATURE`

### Workspace Isolation
- API key authentication scopes requests to the key's workspace
- Events with mismatched `workspaceId` are rejected with `403 WORKSPACE_MISMATCH`

### Data Privacy
- No raw tool output is sent — only SHA-256 hashes
- No full file paths — only project directory hashes
- No API keys or secrets in event payloads

## Governance Policies (Auto-Created)

Agent sync creates 5 default policies:

| Policy | Priority | Action |
|:-------|:---------|:-------|
| Block all production access | 1000 | DENY |
| Loop operator cost circuit breaker ($5/session) | 900 | DENY |
| Security reviewer write escalation | 850 | ESCALATE_TO_HUMAN |
| Chief of staff write escalation | 800 | ESCALATE_TO_HUMAN |
| Standard agent development allow | 100 | ALLOW |

## Instinct Refresh

Governance instincts are regenerated automatically:
- **Worker scheduler**: Every 6 hours for all workspaces
- **Manual trigger**: `POST /api/v1/ecc/instincts/refresh`
- **Dashboard**: Hit refresh in Dev Intelligence page

Instincts are derived from production data:
- Policy violation patterns
- SQL gate blocks
- Cost velocity anomalies
- High session volume
- High tool usage volume

## Troubleshooting

### Events not appearing
1. Check `NEXUSOPS_API_URL` is reachable from ECC host
2. Verify API key is valid and not revoked
3. Check `NEXUSOPS_WORKSPACE_ID` matches the key's workspace
4. Look for `[nexusops] emit failed:` in stderr output

### Dashboard shows "Disconnected"
1. Run **Sync Agents** at least once
2. Check API is healthy: `GET /health`
3. Verify JWT token is valid

### Instincts empty
1. Ensure events are flowing (check audit log)
2. Wait for 24h of data or trigger manual refresh
3. Check worker logs for `ecc-instinct-refresh` errors

### HMAC verification failing
1. Ensure `ECC_WEBHOOK_SECRET` matches on both sides
2. Secret must be the same string — no encoding differences
3. Check for proxy/load-balancer modifying request body

## Docker Compose

ECC env vars are included in `docker-compose.yml`:
```yaml
api:
  environment:
    ECC_WEBHOOK_SECRET: ${ECC_WEBHOOK_SECRET:-}
```

## Kubernetes

ECC secret is in `k8s/config.yaml`:
```yaml
stringData:
  ECC_WEBHOOK_SECRET: REPLACE_ME
```
