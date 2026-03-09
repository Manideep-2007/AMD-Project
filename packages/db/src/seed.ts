import { PrismaClient, UserRole, AgentStatus, PolicyAction, TaskStatus, ToolType } from '@prisma/client';
import * as crypto from 'crypto';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

// Safety guard: never seed a production database.
if (process.env.NODE_ENV === 'production') {
  console.error('ERROR: Refusing to run seed in NODE_ENV=production.');
  console.error('Seeding would overwrite production data with default demo credentials.');
  process.exit(1);
}

function hashSha3Fallback(data: string): string {
  try {
    return crypto.createHash('sha3-256').update(data, 'utf8').digest('hex');
  } catch {
    return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
  }
}

async function main() {
  console.log('🌱 Seeding database...');

  // ─── Workspace ─────────────────────────────────────
  const workspace = await prisma.workspace.upsert({
    where: { slug: 'demo' },
    update: {},
    create: {
      name: 'Demo Workspace',
      slug: 'demo',
      plan: 'enterprise',
      dataRegion: 'US',
    },
  });
  console.log('✅ Created workspace:', workspace.name);

  // ─── Users (all 4 roles) ──────────────────────────
  const passwordHash = await bcrypt.hash('password123', 12);

  const users = await Promise.all([
    prisma.user.upsert({
      where: { email: 'owner@nexusops.dev' },
      update: {},
      create: { email: 'owner@nexusops.dev', passwordHash, name: 'Demo Owner', emailVerified: true },
    }),
    prisma.user.upsert({
      where: { email: 'admin@nexusops.dev' },
      update: {},
      create: { email: 'admin@nexusops.dev', passwordHash, name: 'Demo Admin', emailVerified: true },
    }),
    prisma.user.upsert({
      where: { email: 'operator@nexusops.dev' },
      update: {},
      create: { email: 'operator@nexusops.dev', passwordHash, name: 'Demo Operator', emailVerified: true },
    }),
    prisma.user.upsert({
      where: { email: 'viewer@nexusops.dev' },
      update: {},
      create: { email: 'viewer@nexusops.dev', passwordHash, name: 'Demo Viewer', emailVerified: true },
    }),
  ]);
  const [owner, admin, operator, viewer] = users;
  console.log('✅ Created users (owner, admin, operator, viewer)');

  // ─── Workspace Memberships ────────────────────────
  const roles: [typeof owner, UserRole][] = [
    [owner, UserRole.OWNER],
    [admin, UserRole.ADMIN],
    [operator, UserRole.OPERATOR],
    [viewer, UserRole.VIEWER],
  ];
  for (const [user, role] of roles) {
    await prisma.workspaceUser.upsert({
      where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } },
      update: { role },
      create: { workspaceId: workspace.id, userId: user.id, role },
    });
  }
  console.log('✅ Assigned users to workspace');

  // ─── Agents (3 with different profiles) ───────────
  const keypair1 = { publicKey: crypto.randomBytes(32).toString('hex'), secretKey: crypto.randomBytes(32).toString('hex') };
  const keypair2 = { publicKey: crypto.randomBytes(32).toString('hex'), secretKey: crypto.randomBytes(32).toString('hex') };
  const keypair3 = { publicKey: crypto.randomBytes(32).toString('hex'), secretKey: crypto.randomBytes(32).toString('hex') };

  const codeReviewer = await prisma.agent.upsert({
    where: { id: 'seed-agent-code-reviewer' },
    update: {},
    create: {
      id: 'seed-agent-code-reviewer',
      workspaceId: workspace.id,
      name: 'CodeReviewer-v3',
      description: 'Automated code review agent with GitHub read/write',
      version: 'v3.0.0',
      status: AgentStatus.ACTIVE,
      publicKey: keypair1.publicKey,
      config: { model: 'claude-sonnet-4-6', temperature: 0.2 },
      toolPermissions: ['GITHUB'],
      maxTokens: 100000,
      maxCostUsd: 50.0,
      maxExecutionMs: 300000,
      heartbeatAt: new Date(),
      blastRadiusScore: 25,
      blastRadiusMaxDamageUsd: 50.0,
      blastRadiusGovernedDamageUsd: 50.0,
    },
  });

  const deployBot = await prisma.agent.upsert({
    where: { id: 'seed-agent-deploy-bot' },
    update: {},
    create: {
      id: 'seed-agent-deploy-bot',
      workspaceId: workspace.id,
      name: 'DeployBot-v1',
      description: 'Staging/production deployment automation',
      version: 'v1.2.0',
      status: AgentStatus.ACTIVE,
      publicKey: keypair2.publicKey,
      config: { model: 'gpt-4o', environment: 'staging' },
      toolPermissions: ['GITHUB', 'CLOUD_DEPLOY'],
      maxTokens: 50000,
      maxCostUsd: 25.0,
      maxExecutionMs: 600000,
      heartbeatAt: new Date(),
      blastRadiusScore: 72,
      blastRadiusMaxDamageUsd: 10000.0,
      blastRadiusGovernedDamageUsd: 25.0,
    },
  });

  const dataAnalyst = await prisma.agent.upsert({
    where: { id: 'seed-agent-data-analyst' },
    update: {},
    create: {
      id: 'seed-agent-data-analyst',
      workspaceId: workspace.id,
      name: 'DataAnalyst-v2',
      description: 'Database read-only analytics agent',
      version: 'v2.1.0',
      status: AgentStatus.IDLE,
      publicKey: keypair3.publicKey,
      config: { model: 'claude-sonnet-4-6', maxRows: 10000 },
      toolPermissions: ['DATABASE'],
      maxTokens: 200000,
      maxCostUsd: 100.0,
      maxExecutionMs: 900000,
      blastRadiusScore: 15,
      blastRadiusMaxDamageUsd: 100.0,
      blastRadiusGovernedDamageUsd: 100.0,
      safetySchema: {
        permittedStatements: ['SELECT'],
        restrictedTables: ['users', 'refresh_tokens', 'api_keys'],
        maxRowsAffected: 10000,
      },
    },
  });
  console.log('✅ Created 3 agents');

  // ─── Policy Rules (5 rules: allow, deny, escalate) ─
  const policyData = [
    {
      workspaceId: workspace.id,
      name: 'Deny Production Writes',
      description: 'Block all direct writes to production environment',
      enabled: true,
      action: PolicyAction.DENY,
      priority: 100,
      conditions: { environment: 'PRODUCTION', toolTypes: ['CLOUD_DEPLOY', 'DATABASE'], action: 'write' },
      createdBy: owner.id,
    },
    {
      workspaceId: workspace.id,
      name: 'Escalate Schema Changes',
      description: 'Require human approval for database schema modifications',
      enabled: true,
      action: PolicyAction.ESCALATE_TO_HUMAN,
      priority: 90,
      conditions: { toolType: 'DATABASE', operations: ['CREATE', 'ALTER', 'DROP'] },
      createdBy: owner.id,
    },
    {
      workspaceId: workspace.id,
      name: 'Allow Staging Deploys',
      description: 'Automated deploys to staging are allowed',
      enabled: true,
      action: PolicyAction.ALLOW,
      priority: 50,
      conditions: { environment: 'STAGING', toolType: 'CLOUD_DEPLOY' },
      createdBy: admin.id,
    },
    {
      workspaceId: workspace.id,
      name: 'Deny Bulk Jira Operations',
      description: 'Block bulk delete/update operations in Jira',
      enabled: true,
      action: PolicyAction.DENY,
      priority: 80,
      conditions: { toolType: 'JIRA', operations: ['bulkDelete', 'bulkUpdate'] },
      createdBy: admin.id,
    },
    {
      workspaceId: workspace.id,
      name: 'Escalate High-Cost Actions',
      description: 'Require approval for actions costing more than $5',
      enabled: true,
      action: PolicyAction.ESCALATE_TO_HUMAN,
      priority: 70,
      conditions: { estimatedCostUsd: { gt: 5.0 } },
      createdBy: owner.id,
    },
  ];
  // Delete existing seed policies then recreate (idempotent)
  await prisma.policyRule.deleteMany({
    where: { workspaceId: workspace.id, createdBy: { in: [owner.id, admin.id] } },
  });
  await prisma.policyRule.createMany({ data: policyData });
  console.log('✅ Created 5 policy rules');

  // ─── Budgets (2: workspace-level + agent-level) ───
  await prisma.budget.deleteMany({ where: { workspaceId: workspace.id } });
  const workspaceBudget = await prisma.budget.create({
    data: {
      workspaceId: workspace.id,
      maxTokens: 5000000,
      maxCostUsd: 500.0,
      workspaceDailyLimitUsd: 100.0,
      velocityLimitUsdPerMinute: 5.0,
      periodStart: new Date(),
      periodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      alertThreshold: 80,
      autoHalt: true,
    },
  });
  await prisma.budget.create({
    data: {
      workspaceId: workspace.id,
      agentId: codeReviewer.id,
      maxTokens: 100000,
      maxCostUsd: 50.0,
      velocityLimitUsdPerMinute: 2.0,
      periodStart: new Date(),
      periodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      alertThreshold: 80,
      autoHalt: true,
    },
  });
  console.log('✅ Created 2 budgets');

  // ─── Tasks (for audit events context) ─────────────
  const task = await prisma.task.upsert({
    where: { traceId: 'seed-trace-001' },
    update: {},
    create: {
      workspaceId: workspace.id,
      agentId: codeReviewer.id,
      name: 'Review PR #42',
      description: 'Automated review of pull request #42',
      status: TaskStatus.COMPLETED,
      traceId: 'seed-trace-001',
      input: { pr: 42, repo: 'nexusops/core' },
      output: { approved: true, comments: 3 },
      tokenCount: 15000,
      costUsd: 0.45,
      startedAt: new Date(Date.now() - 60000),
      completedAt: new Date(),
    },
  });

  // A task in ESCALATED state for pending approval demo  
  const escalatedTask = await prisma.task.upsert({
    where: { traceId: 'seed-trace-002' },
    update: {},
    create: {
      workspaceId: workspace.id,
      agentId: deployBot.id,
      name: 'Deploy to production',
      description: 'Deploy latest build to production cluster',
      status: TaskStatus.ESCALATED,
      traceId: 'seed-trace-002',
      input: { environment: 'production', version: 'v2.1.0' },
      tokenCount: 5000,
      costUsd: 0.15,
      startedAt: new Date(Date.now() - 30000),
    },
  });
  console.log('✅ Created tasks');

  // ─── Pending Approval ─────────────────────────────
  await prisma.taskApproval.deleteMany({ where: { taskId: escalatedTask.id } });
  await prisma.taskApproval.create({
    data: {
      taskId: escalatedTask.id,
      blastRadiusDelta: 10000.0,
      riskScore: 72,
      timeoutAt: new Date(Date.now() + 30 * 60 * 1000), // 30 min timeout
    },
  });
  console.log('✅ Created pending approval');

  // ─── Audit Events (10 with valid hash chain) ──────
  await prisma.auditEvent.deleteMany({ where: { workspaceId: workspace.id } });
  const auditEvents = [
    { eventType: 'workspace.created', entityType: 'workspace', entityId: workspace.id, action: 'CREATE', metadata: { name: 'Demo Workspace' } },
    { eventType: 'user.registered', entityType: 'user', entityId: owner.id, action: 'CREATE', metadata: { email: 'owner@nexusops.dev' } },
    { eventType: 'agent.created', entityType: 'agent', entityId: codeReviewer.id, action: 'CREATE', metadata: { name: 'CodeReviewer-v3' } },
    { eventType: 'agent.created', entityType: 'agent', entityId: deployBot.id, action: 'CREATE', metadata: { name: 'DeployBot-v1' } },
    { eventType: 'policy.created', entityType: 'policy', entityId: null, action: 'CREATE', metadata: { name: 'Deny Production Writes' } },
    { eventType: 'budget.created', entityType: 'budget', entityId: workspaceBudget.id, action: 'CREATE', metadata: { maxCostUsd: 500 } },
    { eventType: 'task.created', entityType: 'task', entityId: task.id, action: 'CREATE', metadata: { name: 'Review PR #42' } },
    { eventType: 'task.completed', entityType: 'task', entityId: task.id, action: 'UPDATE', metadata: { costUsd: 0.45 } },
    { eventType: 'task.created', entityType: 'task', entityId: escalatedTask.id, action: 'CREATE', metadata: { name: 'Deploy to production' } },
    { eventType: 'task.escalated', entityType: 'task', entityId: escalatedTask.id, action: 'UPDATE', metadata: { reason: 'Production deploy requires approval' } },
  ];

  let previousHash: string | null = null;
  for (let i = 0; i < auditEvents.length; i++) {
    const ev = auditEvents[i];
    const contentStr = JSON.stringify({ ...ev, workspaceId: workspace.id, chainIndex: i, previousHash });
    const contentHash = hashSha3Fallback(contentStr);

    await prisma.auditEvent.create({
      data: {
        workspaceId: workspace.id,
        userId: owner.id,
        eventType: ev.eventType,
        entityType: ev.entityType,
        entityId: ev.entityId,
        action: ev.action,
        metadata: ev.metadata,
        contentHash,
        previousHash,
        chainIndex: i,
      },
    });
    previousHash = contentHash;
  }
  console.log('✅ Created 10 audit events with valid hash chain');

  // ─── Compliance Artifacts (2) ─────────────────────
  await prisma.complianceArtifact.deleteMany({ where: { workspaceId: workspace.id } });
  const artifactContent1 = JSON.stringify({
    userPrompt: 'Review PR #42',
    reasoningChain: [{ step: 1, thought: 'Analyzing code diff', action: 'github.getPRDiff' }],
    policyDecision: 'ALLOW',
  });
  const artifactHash1 = hashSha3Fallback(artifactContent1);

  await prisma.complianceArtifact.create({
    data: {
      workspaceId: workspace.id,
      taskId: task.id,
      agentId: codeReviewer.id,
      userPrompt: 'Review PR #42 for security issues',
      submittedByUserId: owner.id,
      submittedAt: new Date(Date.now() - 120000),
      reasoningChain: [{ step: 1, thought: 'Analyzing code diff for security patterns', action: 'github.getPRDiff' }],
      contextRefs: [{ source: 'github', contentHash: 'abc123', classification: 'INTERNAL' }],
      policyDecision: PolicyAction.ALLOW,
      policyVersion: 1,
      policyInputHash: hashSha3Fallback('review-pr-42-input'),
      executionDurationMs: 4500,
      costUsd: 0.45,
      contentHash: artifactHash1,
      previousHash: null,
      chainIndex: 0,
    },
  });

  const artifactContent2 = JSON.stringify({
    userPrompt: 'Deploy to production',
    reasoningChain: [{ step: 1, thought: 'Production deploy detected — escalating', action: 'cloud.deploy' }],
    policyDecision: 'ESCALATE_TO_HUMAN',
  });
  const artifactHash2 = hashSha3Fallback(artifactContent2);

  await prisma.complianceArtifact.create({
    data: {
      workspaceId: workspace.id,
      taskId: escalatedTask.id,
      agentId: deployBot.id,
      userPrompt: 'Deploy v2.1.0 to production cluster',
      submittedByUserId: operator.id,
      submittedAt: new Date(Date.now() - 30000),
      reasoningChain: [{ step: 1, thought: 'Production deploy requires human approval per policy', action: 'cloud.deploy' }],
      policyDecision: PolicyAction.ESCALATE_TO_HUMAN,
      policyVersion: 1,
      policyInputHash: hashSha3Fallback('deploy-production-input'),
      costUsd: 0.15,
      dataClassificationTouched: 'CONFIDENTIAL',
      contentHash: artifactHash2,
      previousHash: artifactHash1,
      chainIndex: 1,
    },
  });
  console.log('✅ Created 2 compliance artifacts');

  // ─── API Key ──────────────────────────────────────
  const rawKey = `nxo_sk_${crypto.randomBytes(32).toString('hex')}`;
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  await prisma.apiKey.upsert({
    where: { keyHash },
    update: {},
    create: {
      workspaceId: workspace.id,
      name: 'Demo SDK Key',
      keyHash,
      keyPrefix: rawKey.slice(0, 12),
      scope: 'full_access',
    },
  });

  console.log('');
  console.log('🎉 Seed complete!');
  console.log('');
  console.log('👤 Demo Credentials:');
  console.log('   Owner:    owner@nexusops.dev    / password123');
  console.log('   Admin:    admin@nexusops.dev    / password123');
  console.log('   Operator: operator@nexusops.dev / password123');
  console.log('   Viewer:   viewer@nexusops.dev   / password123');
  console.log('');
  console.log('🔑 API Key (save this):');
  console.log(`   ${rawKey}`);
}

main()
  .catch((e) => {
    console.error('❌ Error seeding database:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
