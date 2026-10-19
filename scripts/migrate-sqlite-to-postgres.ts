import { DatabaseSync } from 'node:sqlite';
import { Client } from 'pg';
import path from 'path';

// Define table names in strict dependency order for relational integrity
export const TABLES = [
  'clients', 'users', 'plans', 'licenses', 'license_feature_credits',
  'settings', 'audit_log', 'knowledge', 'channel_sessions', 'meta_pages',
  'api_keys', 'client_webhooks', 'fb_comment_log', 'website_imports',
  'website_import_pages', 'push_subscriptions', 'client_drive_tokens',
  'admin_totp', 'sessions', 'conversations', 'messages', 'products',
  'orders', 'leads', 'broadcasts', 'broadcast_recipients'
];

export interface CliOptions {
  isDryRun: boolean;
  sqlitePath: string;
  pgUrl: string;
}

export interface PgQueryResult<T = any> {
  rows: T[];
  rowCount?: number | null;
}

export interface PgClientLike {
  query(text: string, values?: any[]): Promise<PgQueryResult>;
  connect?(): Promise<void>;
  end?(): Promise<void>;
}

export interface MigrationOptions {
  isDryRun: boolean;
  sqlitePath?: string;
  pgUrl?: string;
  tables?: string[];
  sqlite?: DatabaseSync;
  pgClient?: PgClientLike;
  exitOnError?: boolean;
}

export interface TableMigrationStats {
  sqliteCount: number;
  pgCountBefore: number;
  pgCountAfter: number;
  inserted: number;
  identical: number;
  conflicting: number;
  skipped: number;
  failed: number;
  orphans: number;
}

export interface MigrationResult {
  tablesChecked: number;
  tablesMigrated: number;
  totalInserted: number;
  totalIdentical: number;
  totalConflicting: number;
  totalSkipped: number;
  totalFailed: number;
  totalOrphans: number;
  stats: Record<string, TableMigrationStats>;
}

export function parseCliArgs(args: string[]): CliOptions {
  const isDryRun = args.includes('--dry-run');
  let sqlitePath = process.env.SQLITE_PATH || path.join(process.cwd(), 'old-code/tectonic-inbox.db');
  let pgUrl = process.env.DATABASE_URL || 'postgresql://tectobox:tectobox_dev@localhost:5432/tectobox';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--sqlite-path' && args[i + 1]) {
      sqlitePath = args[i + 1];
    } else if (args[i].startsWith('--sqlite-path=')) {
      sqlitePath = args[i].split('=')[1];
    } else if (args[i] === '--database-url' && args[i + 1]) {
      pgUrl = args[i + 1];
    } else if (args[i].startsWith('--database-url=')) {
      pgUrl = args[i].split('=')[1];
    }
  }

  return { isDryRun, sqlitePath, pgUrl };
}

export function sanitizeUrl(rawUrl: string): string {
  if (!rawUrl) return '';
  try {
    const parsed = new URL(rawUrl);
    if (parsed.password) {
      parsed.password = '***';
    }
    for (const key of Array.from(parsed.searchParams.keys())) {
      parsed.searchParams.set(key, '***');
    }
    return parsed.toString();
  } catch {
    // Fallback for non-URL or DSN key-value strings
    return rawUrl
      .replace(/(password|passwd|pwd|secret|token|api_key|apikey)=([^\s;&]+)/gi, '$1=***')
      .replace(/([?&][^=]+)=([^&]*)/g, '$1=***');
  }
}

export function sanitizeMessage(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  const text = typeof raw === 'string' ? raw : (raw instanceof Error ? (raw.stack || raw.message) : String(raw));
  return text
    .replace(/(postgres(?:ql)?:\/\/[^:]+:)([^@]+)(@)/gi, '$1***$3')
    .replace(/(password|passwd|pwd|secret|token|api_key|apikey)=([^\s;&]+)/gi, '$1=***')
    .replace(/([?&](?:password|passwd|pwd|secret|token|api_key|apikey|auth_token)=)[^&\s]+/gi, '$1***');
}

export function isTypeCompatible(sqliteType: string, pgDataType: string): boolean {
  if (!sqliteType || !pgDataType) return true;
  const sType = sqliteType.toUpperCase().trim();
  const pType = pgDataType.toLowerCase().trim();

  // Strip length/precision modifiers: VARCHAR(255) -> VARCHAR, DECIMAL(12,2) -> DECIMAL
  const baseSqlite = sType.replace(/\(.*\)/, '').trim();

  // Reject lossy conversions:
  // e.g., floating-point types in SQLite mapped to integers in Postgres
  if (['REAL', 'FLOAT', 'DOUBLE', 'DOUBLE PRECISION'].includes(baseSqlite)) {
    if (['integer', 'smallint', 'bigint', 'serial', 'bigserial', 'boolean'].includes(pType)) {
      return false; // Lossy truncation!
    }
    return ['real', 'double precision', 'numeric', 'decimal'].includes(pType);
  }

  if (['INTEGER', 'INT', 'SMALLINT', 'TINYINT', 'MEDIUMINT', 'BIGINT'].includes(baseSqlite)) {
    return ['integer', 'bigint', 'smallint', 'numeric', 'decimal', 'boolean', 'serial', 'bigserial'].includes(pType);
  }

  if (['NUMERIC', 'DECIMAL'].includes(baseSqlite)) {
    if (['integer', 'smallint', 'bigint', 'boolean'].includes(pType)) {
      return false; // Lossy!
    }
    return ['numeric', 'decimal', 'real', 'double precision'].includes(pType);
  }

  if (['TEXT', 'VARCHAR', 'CHAR', 'CLOB', 'CHARACTER', 'STRING'].includes(baseSqlite)) {
    return [
      'text', 'character varying', 'varchar', 'character', 'char',
      'json', 'jsonb', 'timestamp without time zone', 'timestamp with time zone',
      'timestamptz', 'timestamp', 'date', 'time', 'uuid'
    ].includes(pType);
  }

  if (['DATETIME', 'TIMESTAMP'].includes(baseSqlite)) {
    return ['timestamp without time zone', 'timestamp with time zone', 'timestamptz', 'timestamp', 'date', 'text'].includes(pType);
  }

  if (['BOOLEAN', 'BOOL'].includes(baseSqlite)) {
    return ['boolean', 'smallint', 'integer'].includes(pType);
  }

  if (['BLOB'].includes(baseSqlite)) {
    return ['bytea', 'blob'].includes(pType);
  }

  // Exact fallback match
  if (pType === baseSqlite.toLowerCase()) {
    return true;
  }

  return false;
}

export function areValuesEqual(valA: any, valB: any): boolean {
  if (valA === valB) return true;
  if ((valA === null || valA === undefined) && (valB === null || valB === undefined)) {
    return true;
  }

  // Boolean comparison
  if (typeof valB === 'boolean' || typeof valA === 'boolean') {
    const boolA = valA === 1 || valA === '1' || valA === true || valA === 'true';
    const boolB = valB === 1 || valB === '1' || valB === true || valB === 'true';
    return boolA === boolB;
  }

  // Number comparison (including stringified decimals)
  if ((typeof valA === 'number' || typeof valB === 'number') && valA !== null && valB !== null && valA !== '' && valB !== '') {
    const numA = Number(valA);
    const numB = Number(valB);
    if (!isNaN(numA) && !isNaN(numB)) {
      return numA === numB;
    }
  }

  // Timestamp/Date comparison
  if (valA instanceof Date || valB instanceof Date || (typeof valA === 'string' && /^\d{4}-\d{2}-\d{2}/.test(valA))) {
    const timeA = new Date(valA).getTime();
    const timeB = new Date(valB).getTime();
    if (!isNaN(timeA) && !isNaN(timeB)) {
      return timeA === timeB;
    }
  }

  // JSON object or JSON string comparison
  if (typeof valA === 'object' || typeof valB === 'object' || (typeof valA === 'string' && (valA.startsWith('{') || valA.startsWith('[')))) {
    try {
      const objA = typeof valA === 'string' ? JSON.parse(valA) : valA;
      const objB = typeof valB === 'string' ? JSON.parse(valB) : valB;
      return JSON.stringify(objA) === JSON.stringify(objB);
    } catch {
      // not JSON, fall through
    }
  }

  // String comparison trimmed
  if (String(valA).trim() === String(valB).trim()) {
    return true;
  }

  return false;
}

export function isRowIdentical(sourceRow: Record<string, any>, targetRow: Record<string, any>, columns: string[]): boolean {
  for (const col of columns) {
    if (!Object.hasOwn(targetRow, col) || !areValuesEqual(sourceRow[col], targetRow[col])) {
      return false;
    }
  }
  return true;
}

interface ConstraintColumn {
  constraint_schema: string;
  constraint_name: string;
  constraint_type: 'PRIMARY KEY' | 'UNIQUE';
  column_name: string;
  ordinal_position: number;
}

interface ConstraintGroup {
  schema: string;
  name: string;
  type: 'PRIMARY KEY' | 'UNIQUE';
  columns: string[];
}

export function groupConstraints(rows: ConstraintColumn[]): ConstraintGroup[] {
  const groups = new Map<string, ConstraintGroup>();
  for (const row of rows) {
    const key = JSON.stringify([row.constraint_schema, row.constraint_name, row.constraint_type]);
    const group = groups.get(key) ?? {
      schema: row.constraint_schema,
      name: row.constraint_name,
      type: row.constraint_type,
      columns: []
    };
    group.columns[row.ordinal_position - 1] = row.column_name;
    groups.set(key, group);
  }
  return Array.from(groups.values()).filter(group => group.columns.every(Boolean));
}

async function getTargetSchema(pg: PgClientLike, table: string): Promise<string> {
  const result = await pg.query(`
    SELECT table_schema
    FROM information_schema.tables
    WHERE table_name = $1
      AND table_schema = ANY (CURRENT_SCHEMAS(false))
    ORDER BY (table_schema = current_schema()) DESC, table_schema
    LIMIT 1
  `, [table]);
  const schema = result.rows[0]?.table_schema;
  if (!schema) throw new Error(`Target table '${table}' has no visible schema`);
  return schema;
}

async function getConstraintGroups(pg: PgClientLike, table: string, schema: string): Promise<ConstraintGroup[]> {
  const result = await pg.query(`
    SELECT tc.constraint_schema, tc.constraint_name, tc.constraint_type,
           kcu.column_name, kcu.ordinal_position
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
      AND tc.table_name = kcu.table_name
    WHERE tc.table_name = $1
      AND tc.table_schema = $2
      AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE')
    ORDER BY tc.table_schema, tc.constraint_name, kcu.ordinal_position
  `, [table, schema]);
  return groupConstraints(result.rows as ConstraintColumn[]);
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsupported SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function rowFingerprint(row: Record<string, any>): string {
  return JSON.stringify(Object.keys(row).sort().map(column => [column, row[column]]));
}

function toPostgresValue(column: string, value: any): any {
  if (value === '' && column.endsWith('_at')) return null;
  if (column.endsWith('_json') && typeof value === 'string') {
    try { return JSON.parse(value); } catch { return value; }
  }
  if (['active', 'revoked', 'dm_sent', 'enabled', 'ai_paused', 'suspended', 'wc_require_intro', 'needs_human'].includes(column)) {
    return value === 1 || value === 'true';
  }
  return value;
}

function rowsMatch(source: Record<string, any>, target: Record<string, any>, columns: string[]): boolean {
  return isRowIdentical(
    Object.fromEntries(columns.map(column => [column, toPostgresValue(column, source[column])])),
    target,
    columns
  );
}

async function findRowsByConstraints(
  pg: PgClientLike,
  table: string,
  schema: string,
  row: Record<string, any>,
  groups: ConstraintGroup[]
): Promise<any[]> {
  const matches = new Map<string, any>();
  for (const group of groups) {
    if (!group.columns.every(column => Object.hasOwn(row, column) && row[column] !== null && row[column] !== undefined)) {
      continue;
    }
    const where = group.columns.map((column, index) => `${quoteIdentifier(column)} = $${index + 1}`).join(' AND ');
    const result = await pg.query(
      `SELECT * FROM ${quoteIdentifier(group.schema)}.${quoteIdentifier(table)} WHERE ${where}`,
      group.columns.map(column => row[column])
    );
    for (const candidate of result.rows) matches.set(rowFingerprint(candidate), candidate);
  }
  if (Object.hasOwn(row, 'id') && row.id !== null && row.id !== undefined) {
    const result = await pg.query(`SELECT * FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)} WHERE ${quoteIdentifier('id')} = $1`, [row.id]);
    for (const candidate of result.rows) matches.set(rowFingerprint(candidate), candidate);
  }
  return Array.from(matches.values());
}

async function verifyTableRows(
  pg: PgClientLike,
  table: string,
  schema: string,
  rows: Record<string, any>[]
): Promise<boolean> {
  const targetTable = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
  const countResult = await pg.query(`SELECT count(*)::int AS count FROM ${targetTable}`);
  if (Number(countResult.rows[0]?.count ?? 0) !== rows.length) return false;
  if (rows.length === 0) return true;
  const columns = Object.keys(rows[0]);
  const targetResult = await pg.query(`SELECT * FROM ${targetTable}`);
  if (targetResult.rows.length !== rows.length) return false;

  const unmatchedTargets = [...targetResult.rows];
  for (const sourceRow of rows) {
    const matchIndex = unmatchedTargets.findIndex(targetRow => rowsMatch(sourceRow, targetRow, columns));
    if (matchIndex === -1) return false;
    unmatchedTargets.splice(matchIndex, 1);
  }
  return unmatchedTargets.length === 0;
}

export async function runMigration(options: MigrationOptions): Promise<MigrationResult> {
  const {
    isDryRun,
    sqlitePath = path.join(process.cwd(), 'old-code/tectonic-inbox.db'),
    pgUrl = process.env.DATABASE_URL || 'postgresql://tectobox:tectobox_dev@localhost:5432/tectobox',
    tables = TABLES,
    exitOnError = true
  } = options;

  const handleFatal = (message: string, err?: unknown): never => {
    const sanitizedMsg = sanitizeMessage(message);
    const sanitizedErr = err ? sanitizeMessage(err) : '';
    console.error(`[migration] FATAL: ${sanitizedMsg}`, sanitizedErr);
    if (exitOnError) {
      process.exit(1);
    }
    throw new Error(sanitizedMsg);
  };

  console.log(`[migration] SQLite source: ${sqlitePath}`);
  console.log(`[migration] Target PostgreSQL: ${sanitizeUrl(pgUrl)}`);
  if (isDryRun) {
    console.log('[migration] MODE: DRY RUN (read-only verification, zero target writes)');
  }

  let sqlite: DatabaseSync;
  let closeSqlite = false;
  if (options.sqlite) {
    sqlite = options.sqlite;
  } else {
    try {
      // Ensure SQLite source is opened in strict read-only mode
      sqlite = new DatabaseSync(sqlitePath, { open: true, readOnly: true });
      closeSqlite = true;
    } catch (err) {
      handleFatal(`Could not open source SQLite DB at ${sqlitePath}:`, err);
    }
  }

  let pg: PgClientLike;
  let closePg = false;
  if (options.pgClient) {
    pg = options.pgClient;
  } else {
    const client = new Client({ connectionString: pgUrl });
    try {
      await client.connect();
      pg = client;
      closePg = true;
    } catch (err) {
      handleFatal(`Could not connect to PostgreSQL:`, err);
    }
  }

  try {
    let completedTables = new Set<string>();

    if (!isDryRun) {
      await pg.query(`
        CREATE TABLE IF NOT EXISTS _migration_checkpoints (
          table_name VARCHAR(100) PRIMARY KEY,
          rows_migrated INTEGER NOT NULL,
          completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);

      const checkpointRes = await pg.query('SELECT table_name, rows_migrated, completed_at FROM _migration_checkpoints WHERE completed_at IS NOT NULL');
      completedTables = new Set(
        checkpointRes.rows
          .filter(r => r.table_name && r.rows_migrated !== null && r.rows_migrated !== undefined && r.completed_at)
          .map(r => r.table_name)
      );
    }

    const migrationStats: Record<string, TableMigrationStats> = {};
    let totalInserted = 0;
    let totalIdentical = 0;
    let totalConflicting = 0;
    let totalSkipped = 0;
    let totalFailed = 0;
    let totalOrphans = 0;
    let tablesMigrated = 0;

    for (const table of tables) {
      // Query SQLite table schema
      let sqliteCols: any[] = [];
      try {
        sqliteCols = sqlite.prepare(`PRAGMA table_info(${table})`).all();
      } catch (err) {
        handleFatal(`Required table '${table}' missing or failed to query schema in SQLite`, err);
      }

      if (sqliteCols.length === 0) {
        handleFatal(`Table '${table}' does not exist or has no columns in SQLite source`);
      }

      // Query rows from SQLite
      let rows: any[] = [];
      try {
        rows = sqlite.prepare(`SELECT * FROM ${table}`).all();
      } catch (err) {
        handleFatal(`Failed to query rows from table '${table}' in SQLite`, err);
      }

      const sqliteCount = rows.length;

      // Checkpoint revalidation: if table was marked completed, verify target content matches source completely
      if (completedTables.has(table)) {
        let checkpointValid = true;
        try {
          const targetSchema = await getTargetSchema(pg, table);
          const countCheckRes = await pg.query(`SELECT count(*)::int as count FROM ${quoteIdentifier(targetSchema)}.${quoteIdentifier(table)}`);
          const targetCount = Number(countCheckRes.rows[0]?.count ?? 0);
          if (targetCount !== sqliteCount) {
            console.warn(`[checkpoint] Table '${table}' marked complete but target row count (${targetCount}) != source count (${sqliteCount}); invalidating checkpoint`);
            checkpointValid = false;
          } else {
            const targetSchema = await getTargetSchema(pg, table);
            checkpointValid = await verifyTableRows(pg, table, targetSchema, rows, []);
            if (!checkpointValid) {
              console.warn(`[checkpoint] Table '${table}' marked complete but row verification failed (row missing, ambiguous, or corrupted); invalidating checkpoint`);
            }
          }
        } catch (checkErr) {
          console.warn(`[checkpoint] Table '${table}' checkpoint revalidation query failed:`, checkErr);
          checkpointValid = false;
        }

        if (checkpointValid) {
          console.log(`[checkpoint] Skipping table ${table} (already migrated and verified in previous checkpoint)`);
          totalSkipped++;
          continue;
        } else {
          // Checkpoint invalid or stale: remove from completed checkpoints and proceed to re-migrate
          await pg.query('DELETE FROM _migration_checkpoints WHERE table_name = $1', [table]);
          completedTables.delete(table);
        }
      }

      // 1. Resolve the target table schema before querying or writing it.
      let targetSchema: string;
      try {
        targetSchema = await getTargetSchema(pg, table);
      } catch (err) {
        handleFatal(`Target PostgreSQL table '${table}' does not exist!`, err);
      }

      // 2. Target columns & data types check
      const targetColsRes = await pg.query(
        `SELECT column_name, data_type, udt_name, is_nullable, column_default FROM information_schema.columns WHERE table_name = $1 AND table_schema = $2`,
        [table, targetSchema]
      );
      const targetCols = new Map<string, { dataType: string; isNullable: string; columnDefault: any }>();
      for (const col of targetColsRes.rows) {
        targetCols.set(col.column_name, {
          dataType: col.data_type,
          isNullable: col.is_nullable,
          columnDefault: col.column_default
        });
      }

      // Validate column presence & types (always runs even if rows.length === 0)
      for (const info of sqliteCols) {
        const colName = info.name;
        const colType = info.type;
        const targetCol = targetCols.get(colName);
        if (!targetCol) {
          handleFatal(`Source column '${table}.${colName}' has no corresponding column in PostgreSQL schema!`);
        }
        if (colType && targetCol.dataType) {
          if (!isTypeCompatible(colType, targetCol.dataType)) {
            handleFatal(`Column '${table}.${colName}' type mismatch: SQLite type '${colType}' is incompatible with PostgreSQL type '${targetCol.dataType}'!`);
          }
        }
      }

      // 3. Constraints check: NOT NULL columns in PostgreSQL without default must be provided by source
      for (const [colName, colMeta] of targetCols.entries()) {
        if (colMeta.isNullable === 'NO' && colMeta.columnDefault === null) {
          const existsInSqlite = sqliteCols.some(i => i.name === colName);
          if (!existsInSqlite) {
            handleFatal(`Target PostgreSQL table '${table}' has required NOT NULL column '${colName}' with no default, but it does not exist in SQLite source!`);
          }
        }
      }

      // 4. Relational integrity / orphan check: check foreign keys in SQLite for this table
      let tableOrphans = 0;
      try {
        const fkList = sqlite.prepare(`PRAGMA foreign_key_list(${table})`).all() as any[];
        for (const fk of fkList) {
          if (fk.table && fk.from && fk.to) {
            const orphanRes = sqlite.prepare(
              `SELECT count(*) as count FROM ${table} WHERE ${fk.from} IS NOT NULL AND ${fk.from} NOT IN (SELECT ${fk.to} FROM ${fk.table})`
            ).all() as any[];
            const count = Number(orphanRes[0]?.count ?? 0);
            if (count > 0) {
              tableOrphans += count;
              console.warn(`[migration] Foreign key violation: table '${table}.${fk.from}' has ${count} orphan records referencing missing '${fk.table}.${fk.to}'`);
            }
          }
        }
      } catch {
        // foreign_key_list pragma not supported or not applicable
      }

      if (tableOrphans > 0) {
        handleFatal(`Relational integrity check failed: Table '${table}' has ${tableOrphans} orphaned foreign key records in source SQLite database!`);
      }

      const constraintGroups = await getConstraintGroups(pg, table, targetSchema);

      // Count comparison check
      const pgCountRes = await pg.query(`SELECT count(*)::int as count FROM ${quoteIdentifier(targetSchema)}.${quoteIdentifier(table)}`);
      const pgCountBefore = Number(pgCountRes.rows[0]?.count ?? 0);
      console.log(`[migration] Table '${table}' count comparison: SQLite=${sqliteCount}, PostgreSQL=${pgCountBefore}`);

      if (isDryRun) {
        if (pgCountBefore > 0 && pgCountBefore !== sqliteCount) {
          handleFatal(`Dry run verification failed: Table '${table}' row-count mismatch (SQLite=${sqliteCount}, PostgreSQL=${pgCountBefore})! Target already has disparate rows.`);
        }
        if (pgCountBefore > 0 && !(await verifyTableRows(pg, table, targetSchema, rows))) {
          handleFatal(`Dry run verification failed: Table '${table}' contains rows that differ from the SQLite source.`);
        }
        console.log(`[migration] Table '${table}': DRY RUN verified (read-only, zero target writes)`);
        migrationStats[table] = {
          sqliteCount,
          pgCountBefore,
          pgCountAfter: pgCountBefore,
          inserted: 0,
          identical: 0,
          conflicting: 0,
          skipped: 0,
          failed: 0,
          orphans: tableOrphans
        };
        tablesMigrated++;
        continue;
      }

      // Live migration with strict conflict verification
      let inserted = 0;
      let identical = 0;
      let conflicting = 0;
      let failed = 0;

      if (rows.length > 0) {
        const columns = Object.keys(rows[0]);
        const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
        const quotedColumns = columns.map(quoteIdentifier).join(', ');
        const query = `INSERT INTO ${quoteIdentifier(targetSchema)}.${quoteIdentifier(table)} (${quotedColumns}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;

        await pg.query('BEGIN');

        for (const row of rows) {
          const values = columns.map(col => {
            const val = row[col];
            if (val === '' && col.endsWith('_at')) return null;
            if (col.endsWith('_json') && typeof val === 'string') {
              try { return JSON.parse(val); } catch { return val; }
            }
            if (['active', 'revoked', 'dm_sent', 'enabled', 'ai_paused', 'suspended', 'wc_require_intro', 'needs_human'].includes(col)) {
              return val === 1 || val === 'true';
            }
            return val;
          });

          try {
            const res = await pg.query(query, values);
            if ((res.rowCount ?? 0) > 0) {
              inserted++;
            } else {
              const candidates = await findRowsByConstraints(pg, table, targetSchema, row, constraintGroups);
              if (candidates.length === 1 && isRowIdentical(row, candidates[0], columns)) {
                identical++;
              } else {
                conflicting++;
                console.warn(`[migration] Conflict in table '${table}': source row has no single identical target match`);
              }
            }
          } catch (rowErr) {
            failed++;
            console.error(`[migration] Row insert failed in table '${table}':`, sanitizeMessage(rowErr));
            await pg.query('ROLLBACK');
            throw rowErr;
          }
        }

        if (conflicting > 0) {
          await pg.query('ROLLBACK');
          handleFatal(`Conflict in table '${table}': detected ${conflicting} conflicting rows with differing persisted values! Table transaction rolled back.`);
        }

        const pgCountAfterRes = await pg.query(`SELECT count(*)::int as count FROM ${quoteIdentifier(targetSchema)}.${quoteIdentifier(table)}`);
        const pgCountAfter = Number(pgCountAfterRes.rows[0]?.count ?? 0);
        if (pgCountAfter !== sqliteCount) {
          await pg.query('ROLLBACK');
          handleFatal(`Reconciliation failed for table '${table}': source row count ${sqliteCount} differs from target row count ${pgCountAfter}; table transaction rolled back.`);
        }
        if (!(await verifyTableRows(pg, table, targetSchema, rows))) {
          await pg.query('ROLLBACK');
          handleFatal(`Reconciliation failed for table '${table}': target rows do not exactly match the SQLite source; table transaction rolled back.`);
        }

        // Checkpoint is recorded only inside the transaction after full reconciliation
        await pg.query(`
          INSERT INTO _migration_checkpoints (table_name, rows_migrated, completed_at)
          VALUES ($1, $2, NOW())
          ON CONFLICT (table_name) DO UPDATE SET rows_migrated = EXCLUDED.rows_migrated, completed_at = NOW()
        `, [table, inserted]);

        await pg.query('COMMIT');
        console.log(`  -> Table '${table}': ${inserted} inserted, ${identical} identical, 0 conflicting (PostgreSQL total: ${pgCountAfter})`);

        migrationStats[table] = {
          sqliteCount,
          pgCountBefore,
          pgCountAfter,
          inserted,
          identical,
          conflicting: 0,
          skipped: 0,
          failed,
          orphans: tableOrphans
        };
      } else {
        await pg.query('BEGIN');
        const pgCountAfterRes = await pg.query(`SELECT count(*)::int as count FROM ${quoteIdentifier(targetSchema)}.${quoteIdentifier(table)}`);
        const pgCountAfter = Number(pgCountAfterRes.rows[0]?.count ?? 0);
        if (pgCountAfter !== 0 || !(await verifyTableRows(pg, table, targetSchema, rows))) {
          await pg.query('ROLLBACK');
          handleFatal(`Reconciliation failed for empty source table '${table}': target contains ${pgCountAfter} rows; table transaction rolled back.`);
        }
        await pg.query(`
          INSERT INTO _migration_checkpoints (table_name, rows_migrated, completed_at)
          VALUES ($1, 0, NOW())
          ON CONFLICT (table_name) DO UPDATE SET rows_migrated = 0, completed_at = NOW()
        `, [table]);
        await pg.query('COMMIT');

        migrationStats[table] = {
          sqliteCount,
          pgCountBefore,
          pgCountAfter: pgCountBefore,
          inserted: 0,
          identical: 0,
          conflicting: 0,
          skipped: 0,
          failed: 0,
          orphans: tableOrphans
        };
      }

      totalInserted += inserted;
      totalIdentical += identical;
      totalConflicting += conflicting;
      totalFailed += failed;
      totalOrphans += tableOrphans;
      tablesMigrated++;
    }

    if (!isDryRun) {
      // Reconcile sequence values for tables with serial auto-increment
      for (const table of tables) {
        try {
          await pg.query(`SELECT setval('${table}_id_seq', COALESCE((SELECT MAX(id)+1 FROM ${table}), 1), false)`);
        } catch {
          // Ignore tables without an id_seq
        }
      }
    }

    if (totalConflicting > 0) {
      handleFatal(`Migration completed with ${totalConflicting} conflicting records across migrated tables!`);
    }

    console.log(`\n[migration] SUCCESS: All ${tables.length} tables verified & reconciled. Total inserted: ${totalInserted}, identical: ${totalIdentical}, conflicting: ${totalConflicting}`);

    return {
      tablesChecked: tables.length,
      tablesMigrated,
      totalInserted,
      totalIdentical,
      totalConflicting,
      totalSkipped,
      totalFailed,
      totalOrphans,
      stats: migrationStats
    };
  } catch (err: any) {
    if (!isDryRun && pg) await pg.query('ROLLBACK').catch(() => {});
    if (exitOnError) {
      process.exit(1);
    }
    throw err;
  } finally {
    if (closeSqlite) sqlite.close();
    if (closePg && pg.end) await pg.end();
  }
}

async function migrate() {
  const options = parseCliArgs(process.argv.slice(2));
  try {
    await runMigration(options);
  } catch (err) {
    console.error('[migration] Fatal unhandled error:', sanitizeMessage(err));
    process.exit(1);
  }
}

if (process.argv[1] && process.argv[1].endsWith('migrate-sqlite-to-postgres.ts')) {
  migrate().catch((err) => {
    console.error('Fatal unhandled error:', sanitizeMessage(err));
    process.exit(1);
  });
}
