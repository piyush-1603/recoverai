/**
 * /scripts/migrate-baseline-schema.ts
 *
 * Brings `dev.db.locked-baseline` up to the current Prisma schema WITHOUT
 * touching a single row of its data.
 *
 * Why this exists: `prisma db push` only migrates the live `dev.db`. The frozen
 * 65-scenario benchmark lives in a separate file that `npm run restore-baseline`
 * copies over `dev.db`. If that file keeps an older schema, restoring it silently
 * reverts the schema too and every query against a new column starts failing.
 *
 * The migration is deliberately restricted to ADDITIVE, non-destructive DDL:
 *  - `ALTER TABLE ... ADD COLUMN` for columns present in dev.db but not baseline
 *  - `CREATE INDEX` for indexes present in dev.db but not baseline
 * It will refuse to run if dev.db is missing anything the baseline has, or if a
 * shared column's declared type differs — either means the schemas diverged in a
 * way that cannot be reconciled by adding things, and a human should look.
 *
 * Data equivalence is asserted afterwards on the benchmark headline figures
 * (transaction count, at-risk volume, recovered count, recovered volume). File
 * hashes deliberately are NOT compared: adding a column necessarily rewrites the
 * file header, so the invariant that matters is that the DATASET is unchanged.
 *
 * Run via: npx tsx --tsconfig tsconfig.scripts.json scripts/migrate-baseline-schema.ts
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const LIVE_DB = path.resolve(process.cwd(), 'dev.db');
const BASELINE_DB = path.resolve(process.cwd(), 'dev.db.locked-baseline');

type ColumnInfo = { name: string; type: string; notnull: number; dflt_value: string | null };

function tableNames(db: Database.Database): string[] {
  return db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
    .all()
    .map((r: any) => r.name as string);
}

function columns(db: Database.Database, table: string): ColumnInfo[] {
  return db.prepare(`PRAGMA table_info("${table}")`).all() as ColumnInfo[];
}

function indexDdl(db: Database.Database): Map<string, string> {
  const rows = db
    .prepare(`SELECT name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL`)
    .all() as Array<{ name: string; sql: string }>;
  return new Map(rows.map((r) => [r.name, r.sql]));
}

/** Benchmark headline. Demo artifacts are excluded, exactly as /api/audit does. */
function headline(db: Database.Database) {
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS txns, COALESCE(SUM(amountPaise),0) AS atRiskPaise
       FROM "Transaction" WHERE isDemoArtifact = 0`,
    )
    .get() as { txns: number; atRiskPaise: number };
  const rec = db
    .prepare(
      `SELECT COUNT(*) AS recoveredCount,
              COALESCE(SUM(COALESCE(simulatedRecoveryAmountPaise, amountPaise)),0) AS recoveredPaise
       FROM "Transaction" WHERE isDemoArtifact = 0 AND recovered = 1`,
    )
    .get() as { recoveredCount: number; recoveredPaise: number };
  const auditRows = (db.prepare(`SELECT COUNT(*) AS c FROM "AuditLog"`).get() as { c: number }).c;
  const statuses = db
    .prepare(
      `SELECT status, COUNT(*) AS c FROM "Transaction" WHERE isDemoArtifact = 0
       GROUP BY status ORDER BY status`,
    )
    .all() as Array<{ status: string; c: number }>;
  return { ...totals, ...rec, auditRows, statuses };
}

function main() {
  if (!fs.existsSync(BASELINE_DB)) {
    console.error(`✗ ${BASELINE_DB} does not exist. Nothing to migrate.`);
    process.exit(1);
  }

  // Belt and braces: the baseline is the one artifact that must never be lost.
  const rescue = `${BASELINE_DB}.preschema`;
  if (!fs.existsSync(rescue)) {
    fs.copyFileSync(BASELINE_DB, rescue);
    console.log(`  Safety copy written: ${path.basename(rescue)}`);
  } else {
    console.log(`  Safety copy already present: ${path.basename(rescue)} (left untouched)`);
  }

  const live = new Database(LIVE_DB, { readonly: true });
  const baseline = new Database(BASELINE_DB);

  const before = headline(baseline);
  console.log(`\n  Baseline headline BEFORE: ${JSON.stringify(before)}`);

  const liveTables = new Set(tableNames(live));
  const baselineTables = new Set(tableNames(baseline));

  const missingFromLive = [...baselineTables].filter((t) => !liveTables.has(t));
  if (missingFromLive.length > 0) {
    console.error(
      `\n✗ REFUSING TO MIGRATE: baseline has table(s) dev.db does not: ${missingFromLive.join(', ')}.`,
    );
    process.exit(1);
  }

  const statements: string[] = [];

  for (const table of liveTables) {
    if (!baselineTables.has(table)) {
      // A brand new table. Copy its CREATE statement verbatim from dev.db.
      const ddl = (
        live
          .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name = ?`)
          .get(table) as { sql: string }
      ).sql;
      statements.push(ddl);
      continue;
    }

    const liveCols = columns(live, table);
    const baselineCols = new Map(columns(baseline, table).map((c) => [c.name, c]));

    for (const col of liveCols) {
      const existing = baselineCols.get(col.name);
      if (existing) {
        if (existing.type.toUpperCase() !== col.type.toUpperCase()) {
          console.error(
            `\n✗ REFUSING TO MIGRATE: ${table}.${col.name} type differs ` +
              `(baseline=${existing.type}, dev.db=${col.type}). Additive DDL cannot fix this.`,
          );
          process.exit(1);
        }
        continue;
      }

      // SQLite forbids ADD COLUMN with NOT NULL and no default — which is exactly
      // the shape that would corrupt existing rows. Refuse rather than guess.
      if (col.notnull === 1 && col.dflt_value === null) {
        console.error(
          `\n✗ REFUSING TO MIGRATE: ${table}.${col.name} is NOT NULL with no default. ` +
            `Adding it to a populated table is impossible without inventing values.`,
        );
        process.exit(1);
      }

      const nullClause = col.notnull === 1 ? ' NOT NULL' : '';
      const defaultClause = col.dflt_value !== null ? ` DEFAULT ${col.dflt_value}` : '';
      statements.push(
        `ALTER TABLE "${table}" ADD COLUMN "${col.name}" ${col.type}${nullClause}${defaultClause}`,
      );
    }
  }

  const liveIndexes = indexDdl(live);
  const baselineIndexes = indexDdl(baseline);
  for (const [name, sql] of liveIndexes) {
    if (!baselineIndexes.has(name)) statements.push(sql);
  }

  if (statements.length === 0) {
    console.log('\n  ✓ Baseline schema already matches dev.db. No DDL applied.');
  } else {
    console.log(`\n  Applying ${statements.length} additive statement(s):`);
    for (const s of statements) console.log(`    • ${s}`);
    const run = baseline.transaction(() => {
      for (const s of statements) baseline.prepare(s).run();
    });
    run();
    console.log('  ✓ Applied.');
  }

  const after = headline(baseline);
  console.log(`\n  Baseline headline AFTER : ${JSON.stringify(after)}`);

  const identical = JSON.stringify(before) === JSON.stringify(after);
  console.log(
    `\n  ${identical ? '✅' : '❌'} DATASET IMMUTABILITY: benchmark figures are ` +
      `${identical ? 'byte-identical' : 'DIFFERENT — investigate immediately'}.`,
  );

  live.close();
  baseline.close();

  if (!identical) process.exit(1);
}

main();
