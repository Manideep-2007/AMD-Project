/**
 * k6 Load-Test: NexusOps Proxy Pipeline
 *
 * Validates P95 latency < 250ms for the full 7-step enforcement pipeline
 * under sustained load. Run locally or in CI.
 *
 * Usage:
 *   k6 run benchmarks/proxy-pipeline.js \
 *     -e BASE_URL=http://localhost:3001 \
 *     -e API_KEY=<your-api-key>
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

// ── Custom metrics ──
const proxyLatency = new Trend('proxy_pipeline_latency', true);
const errorRate = new Rate('error_rate');

// ── Configuration ──
export const options = {
  scenarios: {
    // Ramp from 0 → 50 VUs over 30s, sustain for 2m, ramp down
    proxy_load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 50 },
        { duration: '2m', target: 50 },
        { duration: '15s', target: 0 },
      ],
    },
  },
  thresholds: {
    // Gate: P95 latency must stay under 250ms
    proxy_pipeline_latency: ['p(95)<250'],
    // Gate: Error rate must stay under 5%
    error_rate: ['rate<0.05'],
    // Standard HTTP checks
    http_req_duration: ['p(99)<500'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3001';
const API_KEY = __ENV.API_KEY || '';

const headers = {
  'Content-Type': 'application/json',
  ...(API_KEY ? { 'x-api-key': API_KEY } : {}),
};

// ── Helpers ──

function toolExecutePayload() {
  return JSON.stringify({
    agentId: __ENV.AGENT_ID || 'bench-agent-001',
    taskId: __ENV.TASK_ID || 'bench-task-001',
    tool: 'WEB_SEARCH',
    input: {
      query: `benchmark query ${Date.now()}`,
    },
    timestamp: new Date().toISOString(),
  });
}

// ── Default function: runs once per VU iteration ──
export default function () {
  // 1. POST /api/v1/tools/execute — full proxy pipeline
  const executeRes = http.post(
    `${BASE_URL}/api/v1/tools/execute`,
    toolExecutePayload(),
    { headers, tags: { name: 'tools_execute' } }
  );

  proxyLatency.add(executeRes.timings.duration);
  errorRate.add(executeRes.status >= 400 ? 1 : 0);

  check(executeRes, {
    'execute status 2xx': (r) => r.status >= 200 && r.status < 300,
    'execute has body': (r) => r.body && r.body.length > 0,
  });

  // 2. GET /api/v1/agents — list agents (lighter endpoint)
  const agentsRes = http.get(`${BASE_URL}/api/v1/agents`, {
    headers,
    tags: { name: 'list_agents' },
  });

  check(agentsRes, {
    'agents status 2xx': (r) => r.status >= 200 && r.status < 300,
  });

  // 3. GET /health — canary
  const healthRes = http.get(`${BASE_URL}/health`, {
    tags: { name: 'health' },
  });

  check(healthRes, {
    'health status 200': (r) => r.status === 200,
  });

  sleep(0.5);
}

// ── Summary handler ──
export function handleSummary(data) {
  const p95 = data.metrics.proxy_pipeline_latency
    ? data.metrics.proxy_pipeline_latency.values['p(95)']
    : null;
  const errRate = data.metrics.error_rate
    ? data.metrics.error_rate.values.rate
    : null;

  const summary = {
    timestamp: new Date().toISOString(),
    p95_latency_ms: p95,
    error_rate: errRate,
    pass: (p95 !== null && p95 < 250) && (errRate !== null && errRate < 0.05),
  };

  return {
    stdout: JSON.stringify(summary, null, 2) + '\n',
    'benchmarks/results/summary.json': JSON.stringify(summary, null, 2),
  };
}
