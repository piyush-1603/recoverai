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
import Database from 'better-sqlite3';
import path from 'path';

// Re-export PrismaClient type for callers that need it
export type { PrismaClient };

/**
 * How long a writer waits for a competing writer's lock before giving up with
 * SQLITE_BUSY. Passed to better-sqlite3 as `timeout`, which it applies as
 * `PRAGMA busy_timeout` on every connection it opens.
 */
export const SQLITE_BUSY_TIMEOUT_MS = 5000;

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

/**
 * Put the database file into WAL journal mode before Prisma opens it.
 *
 * The default `delete` journal mode takes a whole-database lock for every write,
 * so the Next dev server polling /api/audit every 3s and a test script writing
 * audit rows contend directly: one of them gets SQLITE_BUSY and the write is
 * lost. WAL lets readers proceed while a writer is committing, which is exactly
 * this workload — one writer, several concurrent readers.
 *
 * `journal_mode` is a persistent property stored in the database file header, so
 * this only has to be executed once per file; it is done on every boot because
 * `npm run restore-baseline` can drop in a file that predates the change.
 *
 * `:memory:` is skipped — WAL is meaningless without a file to write it to.
 *
 * Failure here is logged and swallowed on purpose. A read-only filesystem or a
 * concurrently-locked file should degrade to the old journal mode, not take the
 * whole process down before it has served a single request.
 */
function enableWalMode(dbPath: string): void {
  if (dbPath === ':memory:') return;
  try {
    const handle = new Database(dbPath, { timeout: SQLITE_BUSY_TIMEOUT_MS });
    try {
      handle.pragma('journal_mode = WAL');
      // Durability/throughput trade: with WAL, NORMAL fsyncs the WAL on
      // checkpoint rather than on every commit. A power loss can cost the last
      // transaction, never the database.
      handle.pragma('synchronous = NORMAL');
      handle.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
      handle.pragma('foreign_keys = ON');
    } finally {
      handle.close();
    }
  } catch (err) {
    console.warn(
      `[Prisma] Could not set WAL journal mode on ${dbPath} — continuing with the ` +
        `existing journal mode. Concurrent writes may hit SQLITE_BUSY. Cause: ${
          err instanceof Error ? err.message : String(err)
        }`,
    );
  }
}

function createPrismaClient(): PrismaClient {
  const dbPath = getDbPath();
  enableWalMode(dbPath);
  const adapter = new PrismaBetterSqlite3({
    url: dbPath,
    // better-sqlite3 translates this into PRAGMA busy_timeout on the connection
    // it opens for Prisma, so Prisma's own writes retry instead of failing fast.
    timeout: SQLITE_BUSY_TIMEOUT_MS,
  });
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
