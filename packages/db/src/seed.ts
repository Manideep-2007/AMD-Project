import { PrismaClient, UserRole, AgentStatus, PolicyAction, ToolType } from '@prisma/client';
import * as crypto from 'crypto';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // Create demo workspace
  const workspace = await prisma.workspace.upsert({
    where: { slug: 'demo' },
    update: {},
    create: {
      name: 'Demo Workspace',
      slug: 'demo',
    },
  });

  console.log('✅ Created workspace:', workspace.name);

  // Create demo users
  const ownerPassword = crypto.createHash('sha256').update('password123').digest('hex');
  
  const owner = await prisma.user.upsert({
    where: { email: 'owner@nexusops.dev' },
    update: {},
    create: {
      email: 'owner@nexusops.dev',
      passwordHash: ownerPassword,
      name: 'Demo Owner',
      emailVerified: true,
    },
  });

  const adminPassword = crypto.createHash('sha256').update('password123').digest('hex');
  
  const admin = await prisma.user.upsert({
    where: { email: 'admin@nexusops.dev' },
    update: {},
    create: {
      email: 'admin@nexusops.dev',
      passwordHash: adminPassword,
      name: 'Demo Admin',
      emailVerified: true,
    },
  });

  console.log('✅ Created users');

  // Assign users to workspace
  await prisma.workspaceUser.upsert({
    where: {
      workspaceId_userId: {
        workspaceId: workspace.id,
        userId: owner.id,
      },
    },
    update: {},
    create: {
      workspaceId: workspace.id,
      userId: owner.id,
      role: UserRole.OWNER,
    },
  });

  await prisma.workspaceUser.upsert({
    where: {
      workspaceId_userId: {
        workspaceId: workspace.id,
        userId: admin.id,
      },
    },
    update: {},
    create: {
      workspaceId: workspace.id,
      userId: admin.id,
      role: UserRole.ADMIN,
    },
  });

  console.log('✅ Assigned users to workspace');

  // Create demo agents
  const codeReviewer = await prisma.agent.create({
    data: {
      workspaceId: workspace.id,
      name: 'CodeReviewer-v3',
      description: 'Automated code review agent',
      version: 'v3.0.0',
      status: AgentStatus.ACTIVE,
      config: {
        model: 'gpt-4',
        temperature: 0.2,
        rules: ['check-security', 'check-performance', 'check-style'],
      },
      toolPermissions: ['GITHUB'],
      maxTokens: 100000,
      maxCostUsd: 50.0,
      maxExecutionMs: 300000,
      heartbeatAt: new Date(),
    },
  });

  const deployBot = await prisma.agent.create({
    data: {
      workspaceId: workspace.id,
      name: 'DeployBot-v1',
      description: 'Staging deployment automation',
      version: 'v1.2.0',
      status: AgentStatus.ACTIVE,
      config: {
        model: 'gpt-4',
        environment: 'staging',
      },
      toolPermissions: ['GITHUB', 'CLOUD_DEPLOY'],
      maxTokens: 50000,
      maxCostUsd: 25.0,
      maxExecutionMs: 600000,
      heartbeatAt: new Date(),
    },
  });

  console.log('✅ Created agents');

  // Create demo policy rules
  await prisma.policyRule.createMany({
    data: [
      {
        workspaceId: workspace.id,
        name: 'Deny Production Writes',
        description: 'Block all direct writes to production environment',
        enabled: true,
        action: PolicyAction.DENY,
        priority: 100,
        conditions: {
          environment: 'PRODUCTION',
          toolTypes: ['CLOUD_DEPLOY', 'DATABASE'],
          action: 'write',
        },
      },
      {
        workspaceId: workspace.id,
        name: 'Escalate Schema Changes',
        description: 'Require human approval for database schema modifications',
        enabled: true,
        action: PolicyAction.ESCALATE_TO_HUMAN,
        priority: 90,
        conditions: {
          toolType: 'DATABASE',
          operations: ['CREATE', 'ALTER', 'DROP'],
        },
      },
      {
        workspaceId: workspace.id,
        name: 'Allow Staging Deploys',
        description: 'Automated deploys to staging are allowed',
        enabled: true,
        action: PolicyAction.ALLOW,
        priority: 50,
        conditions: {
          environment: 'STAGING',
          toolType: 'CLOUD_DEPLOY',
        },
      },
      {
        workspaceId: workspace.id,
        name: 'Deny Bulk Operations',
        description: 'Block bulk delete/update operations in Jira',
        enabled: true,
        action: PolicyAction.DENY,
        priority: 80,
        conditions: {
          toolType: 'JIRA',
          operations: ['bulkDelete', 'bulkUpdate'],
        },
      },
    ],
  });

  console.log('✅ Created policy rules');

  // Create budget
  await prisma.budget.create({
    data: {
      workspaceId: workspace.id,
      maxTokens: 1000000,
      maxCostUsd: 500.0,
      periodStart: new Date(),
      periodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
      alertThreshold: 0.8,
    },
  });

  console.log('✅ Created budget');

  // Create API key
  const apiKeyValue = crypto.randomBytes(32).toString('hex');
  const apiKeyHash = crypto.createHash('sha256').update(apiKeyValue).digest('hex');
  
  await prisma.apiKey.create({
    data: {
      workspaceId: workspace.id,
      name: 'Demo API Key',
      keyHash: apiKeyHash,
      keyPrefix: apiKeyValue.substring(0, 8),
    },
  });

  console.log('✅ Created API key');
  console.log('📋 API Key (save this, it won\'t be shown again):');
  console.log(`   ${apiKeyValue}`);

  console.log('');
  console.log('🎉 Seed complete!');
  console.log('');
  console.log('👤 Demo Credentials:');
  console.log('   Owner: owner@nexusops.dev / password123');
  console.log('   Admin: admin@nexusops.dev / password123');
}

main()
  .catch((e) => {
    console.error('Error seeding database:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
