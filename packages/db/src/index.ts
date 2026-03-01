import { PrismaClient } from '@prisma/client';

// Singleton pattern for Prisma Client
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

// Export all Prisma types and enums
export * from '@prisma/client';
export type { Prisma } from '@prisma/client';

// Explicitly re-export enums for better TypeScript support
export {
  UserRole,
  TaskStatus,
  AgentStatus,
  PolicyAction,
  ToolType,
  Environment,
  DataClassification,
} from '@prisma/client';
