/**
 * /lib/prisma.ts
 *
 * Singleton PrismaClient factory with the better-sqlite3 driver adapter.
 * Prisma 7 requires a driver adapter for SQLite — the connection URL is
 * specified here, not in schema.prisma.
 *
 * Import this singleton instead of constructing PrismaClient directly.
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import path from 'path';

// Re-export PrismaClient type for callers that need it
export type { PrismaClient };

function getDbPath(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL environment variable is not set');
  }
  // DATABASE_URL format: "file:./dev.db"
  // better-sqlite3 wants an absolute or relative file path
  const filePart = url.replace(/^file:/, '');
  return path.resolve(process.cwd(), filePart);
}

function createPrismaClient(): PrismaClient {
  const dbPath = getDbPath();
  const adapter = new PrismaBetterSqlite3({ url: dbPath });
  return new PrismaClient({ adapter } as any);
}

// Singleton pattern — reuse in dev to avoid exhausting connections
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export default prisma;
