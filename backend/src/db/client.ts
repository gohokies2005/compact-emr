import { createRequire } from 'node:module';

type PrismaLikeClient = {
  $connect: () => Promise<void>;
  $disconnect: () => Promise<void>;
};

const globalForPrisma = globalThis as unknown as { prisma?: PrismaLikeClient };

function createPrismaClient(): PrismaLikeClient {
  // Dynamic load keeps TypeScript builds green before `prisma generate` has produced the generated client.
  // Runtime and CI should still run `npm run db:generate` before executing database code.
  const requireFromHere = createRequire(import.meta.url);
  const { PrismaClient } = requireFromHere('@prisma/client') as { PrismaClient: new (args?: unknown) => PrismaLikeClient };
  return new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
