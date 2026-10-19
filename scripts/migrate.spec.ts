import { describe, it } from 'node:test';
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import {
  parseCliArgs,
  sanitizeUrl,
  sanitizeMessage,
  isTypeCompatible,
  areValuesEqual,
  isRowIdentical,
  groupConstraints,
  runMigration,
  type PgClientLike,
  type PgQueryResult
} from './migrate-sqlite-to-postgres.ts';

describe('SQLite to Postgres Migration CLI Parser', () => {
  it('parses --dry-run option correctly', () => {
    const opts = parseCliArgs(['--dry-run']);
    assert.strictEqual(opts.isDryRun, true);
  });

  it('parses --sqlite-path flag correctly', () => {
    const opts = parseCliArgs(['--sqlite-path', '/custom/path/db.sqlite']);
    assert.strictEqual(opts.sqlitePath, '/custom/path/db.sqlite');
  });

  it('parses --sqlite-path= inline flag correctly', () => {
    const opts = parseCliArgs(['--sqlite-path=/inline/path/db.sqlite']);
    assert.strictEqual(opts.sqlitePath, '/inline/path/db.sqlite');
  });

  it('parses --database-url inline flag correctly', () => {
    const opts = parseCliArgs(['--database-url=postgresql://custom:5432/testdb']);
    assert.strictEqual(opts.pgUrl, 'postgresql://custom:5432/testdb');
  });
});

describe('URL and DSN Connection String Sanitization', () => {
  it('sanitizes password and all query parameters in PostgreSQL URL', () => {
    const raw = 'postgresql://user:super_secret_pw@localhost:5432/tectobox?sslmode=require&token=secret_token_123';
    const sanitized = sanitizeUrl(raw);
    assert.strictEqual(sanitized.includes('super_secret_pw'), false);
    assert.strictEqual(sanitized.includes('secret_token_123'), false);
    assert.strictEqual(sanitized, 'postgresql://user:***@localhost:5432/tectobox?sslmode=***&token=***');
  });

  it('sanitizes query parameters when password is not present in URL', () => {
    const raw = 'postgresql://localhost:5432/tectobox?auth_token=super_secret';
    const sanitized = sanitizeUrl(raw);
    assert.strictEqual(sanitized.includes('super_secret'), false);
    assert.strictEqual(sanitized, 'postgresql://localhost:5432/tectobox?auth_token=***');
  });

  it('sanitizes key-value DSN connection strings', () => {
    const dsn = 'host=localhost port=5432 user=tectobox password=my_db_secret dbname=tectobox';
    const sanitized = sanitizeUrl(dsn);
    assert.strictEqual(sanitized.includes('my_db_secret'), false);
    assert.strictEqual(sanitized.includes('password=***'), true);
  });

  it('handles empty or malformed strings gracefully', () => {
    assert.strictEqual(sanitizeUrl(''), '');
    assert.strictEqual(sanitizeUrl('invalid-dsn?secret=123'), 'invalid-dsn?secret=***');
  });

  it('sanitizes credentials and secrets in log messages and error objects', () => {
    const rawLog = 'Failed to connect to postgresql://tectobox:super_secret_pass@db.internal:5432/tectobox?token=abc';
    const sanitized = sanitizeMessage(rawLog);
    assert.strictEqual(sanitized.includes('super_secret_pass'), false);
    assert.strictEqual(sanitized.includes('token=abc'), false);
    assert.strictEqual(sanitized.includes('***'), true);

    const err = new Error('Connection failed: password=my_secret_token');
    assert.strictEqual(sanitizeMessage(err).includes('my_secret_token'), false);
    assert.strictEqual(sanitizeMessage(err).includes('password=***'), true);
  });
});

describe('Data Type & Row Equality Verification', () => {
  it('correctly maps compatible SQLite and PostgreSQL data types', () => {
    assert.strictEqual(isTypeCompatible('INTEGER', 'integer'), true);
    assert.strictEqual(isTypeCompatible('INTEGER', 'bigint'), true);
    assert.strictEqual(isTypeCompatible('INTEGER', 'boolean'), true);
    assert.strictEqual(isTypeCompatible('VARCHAR(255)', 'character varying'), true);
    assert.strictEqual(isTypeCompatible('TEXT', 'text'), true);
    assert.strictEqual(isTypeCompatible('TEXT', 'jsonb'), true);
    assert.strictEqual(isTypeCompatible('DATETIME', 'timestamp with time zone'), true);
    assert.strictEqual(isTypeCompatible('BLOB', 'bytea'), true);
  });

  it('rejects incompatible SQLite and PostgreSQL data types', () => {
    assert.strictEqual(isTypeCompatible('BLOB', 'integer'), false);
    assert.strictEqual(isTypeCompatible('INTEGER', 'bytea'), false);
    assert.strictEqual(isTypeCompatible('REAL', 'integer'), false, 'Lossy float-to-integer conversion must be rejected');
    assert.strictEqual(isTypeCompatible('DOUBLE', 'bigint'), false, 'Lossy double-to-bigint conversion must be rejected');
    assert.strictEqual(isTypeCompatible('NUMERIC', 'integer'), false, 'Lossy numeric-to-integer conversion must be rejected');
  });

  it('evaluates boolean, numeric, JSON, and timestamp equality across dialects', () => {
    assert.strictEqual(areValuesEqual(1, true), true);
    assert.strictEqual(areValuesEqual(0, false), true);
    assert.strictEqual(areValuesEqual('true', true), true);
    assert.strictEqual(areValuesEqual(12.5, '12.50'), true);
    assert.strictEqual(areValuesEqual('{"a":1}', { a: 1 }), true);
    assert.strictEqual(areValuesEqual('', null), false);
    assert.strictEqual(areValuesEqual(null, undefined), true);

    const d1 = new Date('2026-01-01T00:00:00Z');
    assert.strictEqual(areValuesEqual('2026-01-01T00:00:00Z', d1), true);
  });

  it('accurately identifies identical vs conflicting rows and requires every target column', () => {
    const sourceRow = { id: 1, name: 'Alice', active: 1, metadata: '{"role":"admin"}' };
    const identicalTarget = { id: 1, name: 'Alice', active: true, metadata: { role: 'admin' } };
    const conflictingTarget = { id: 1, name: 'Alice Modified', active: true, metadata: { role: 'admin' } };

    assert.strictEqual(isRowIdentical(sourceRow, identicalTarget, Object.keys(sourceRow)), true);
    assert.strictEqual(isRowIdentical(sourceRow, conflictingTarget, Object.keys(sourceRow)), false);
    assert.strictEqual(isRowIdentical({ value: null }, {}, ['value']), false, 'Missing target columns must fail even when source is null');
    assert.strictEqual(isRowIdentical({ value: '' }, { }, ['value']), false, 'Missing target columns must fail even when source is empty');
  });

  it('groups primary and unique constraints by schema/name and ordinal column position', () => {
    const groups = groupConstraints([
      { constraint_schema: 'public', constraint_name: 'pair_unique', constraint_type: 'UNIQUE', column_name: 'second', ordinal_position: 2 },
      { constraint_schema: 'public', constraint_name: 'pair_unique', constraint_type: 'UNIQUE', column_name: 'first', ordinal_position: 1 },
      { constraint_schema: 'tenant', constraint_name: 'pair_unique', constraint_type: 'UNIQUE', column_name: 'other', ordinal_position: 1 }
    ]);
    assert.deepStrictEqual(groups.map(group => [group.schema, group.name, group.columns]), [
      ['public', 'pair_unique', ['first', 'second']],
      ['tenant', 'pair_unique', ['other']]
    ]);
  });
});

interface MockPgConfig {
  existingTables?: string[];
  columnsByTable?: Record<string, { column_name: string; data_type: string; is_nullable?: string; column_default?: any }[]>;
  existingRowsByTable?: Record<string, any[]>;
  constraintsByTable?: Record<string, { constraint_schema?: string; constraint_name?: string; constraint_type: string; column_name: string; ordinal_position?: number }[]>;
  insertOutcome?: (table: string, values: any[]) => 'inserted' | 'conflict';
  insertedRow?: (table: string, row: Record<string, any>) => Record<string, any>;
  omitInsertedRows?: boolean;
}

function createMockPgClient(config: MockPgConfig) {
  const executedQueries: { text: string; values?: any[] }[] = [];
  const writtenQueries: { text: string; values?: any[] }[] = [];
  const rowsByTable = Object.fromEntries(Object.entries(config.existingRowsByTable ?? {}).map(([table, rows]) => [table, [...rows]]));
  const transactionSnapshot = new Map<string, any[]>();

  const client: PgClientLike & {
    executedQueries: { text: string; values?: any[] }[];
    writtenQueries: { text: string; values?: any[] }[];
  } = {
    executedQueries,
    writtenQueries,
    async query(text: string, values?: any[]): Promise<PgQueryResult> {
      executedQueries.push({ text, values });

      const normalized = text.trim().toUpperCase();
      if (normalized === 'BEGIN') {
        transactionSnapshot.clear();
        for (const [table, rows] of Object.entries(rowsByTable)) transactionSnapshot.set(table, [...rows]);
        return { rows: [], rowCount: 1 };
      }
      if (normalized === 'ROLLBACK') {
        for (const [table, rows] of transactionSnapshot) rowsByTable[table] = [...rows];
        return { rows: [], rowCount: 1 };
      }
      if (normalized === 'COMMIT') {
        transactionSnapshot.clear();
        return { rows: [], rowCount: 1 };
      }

      const isWrite = normalized.startsWith('INSERT') ||
                      normalized.startsWith('UPDATE') ||
                      normalized.startsWith('DELETE') ||
                      normalized.startsWith('CREATE TABLE');
      if (isWrite) {
        writtenQueries.push({ text, values });
      }

      // 1. Table/schema presence checks
      if (text.includes('SELECT table_schema') && text.includes('information_schema.tables')) {
        const tableName = values?.[0];
        return config.existingTables && !config.existingTables.includes(tableName)
          ? { rows: [] }
          : { rows: [{ table_schema: 'public' }] };
      }
      if (text.includes('information_schema.tables')) {
        const tableName = values?.[0];
        if (config.existingTables && !config.existingTables.includes(tableName)) {
          return { rows: [] };
        }
        return { rows: [{ table_name: tableName }] };
      }

      // 2. Columns metadata check
      if (text.includes('information_schema.columns')) {
        const tableName = values?.[0];
        const cols = config.columnsByTable?.[tableName] ?? [
          { column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: "nextval('seq')" },
          { column_name: 'name', data_type: 'character varying', is_nullable: 'NO', column_default: null },
          { column_name: 'active', data_type: 'boolean', is_nullable: 'YES', column_default: null }
        ];
        return { rows: cols };
      }

      // 3. Constraints and target schema metadata
      if (text.includes('SELECT table_schema') && text.includes('information_schema.tables')) {
        return { rows: [{ table_schema: 'public' }] };
      }
      if (text.includes('information_schema.table_constraints')) {
        const tableName = values?.[0];
        const constraints = config.constraintsByTable?.[tableName] ?? [
          { constraint_schema: 'public', constraint_name: `${tableName}_pkey`, constraint_type: 'PRIMARY KEY', column_name: 'id', ordinal_position: 1 }
        ];
        return { rows: constraints.map(constraint => ({ ...constraint, constraint_schema: constraint.constraint_schema ?? 'public', constraint_name: constraint.constraint_name ?? `${tableName}_pkey`, ordinal_position: constraint.ordinal_position ?? 1 })) };
      }

      // 4. Count and row reconciliation queries
      if (/SELECT count\(\*\)::int AS count/i.test(text) || /SELECT count\(\*\)::int as count/i.test(text)) {
        const tableName = text.match(/FROM\s+(?:"?([a-zA-Z0-9_]+)"?\.)?"?([a-zA-Z0-9_]+)"?/i)?.[2] ?? '';
        return { rows: [{ count: (rowsByTable[tableName] ?? []).length }] };
      }

      if (/SELECT \* FROM/i.test(text)) {
        const tableName = text.match(/FROM\s+(?:"?([a-zA-Z0-9_]+)"?\.)?"?([a-zA-Z0-9_]+)"?/i)?.[2] ?? '';
        const tableRows = rowsByTable[tableName] ?? [];
        if (!text.includes('WHERE')) return { rows: [...tableRows] };
        const where = text.split(/WHERE/i)[1] ?? '';
        const columns = Array.from(where.matchAll(/"?([a-zA-Z0-9_]+)"?\s*=\s*\$(\d+)/g));
        const found = tableRows.find(row => columns.length > 0 && columns.every(match => row[match[1]] === values?.[Number(match[2]) - 1]));
        return { rows: found ? [found] : [] };
      }

      // 6. Checkpoints queries
      if (text.includes('SELECT table_name') && text.includes('_migration_checkpoints')) {
        const rows = config.existingCheckpoints ?? [];
        return { rows };
      }

      // 7. Insert queries
      if (normalized.startsWith('INSERT INTO')) {
        const tableNameMatch = text.match(/INSERT INTO\s+(?:"?[a-zA-Z0-9_]+"?\.)?"?([a-zA-Z0-9_]+)"?/i);
        const tableName = tableNameMatch ? tableNameMatch[1] : '';

        if (tableName === '_migration_checkpoints') {
          return { rows: [], rowCount: 1 };
        }

        const outcome = config.insertOutcome?.(tableName, values ?? []) ?? 'inserted';
        if (outcome === 'inserted') {
          const insertColumns = text.match(/INSERT INTO\s+[^\s(]+\s*\(([^)]+)\)/i)?.[1].split(',').map(column => column.trim().replaceAll('"', '')) ?? [];
          const row = Object.fromEntries(insertColumns.map((column, index) => [column, values?.[index]]));
          if (!config.omitInsertedRows) {
            const insertedRow = config.insertedRow?.(tableName, row) ?? row;
            rowsByTable[tableName] = [...(rowsByTable[tableName] ?? []), insertedRow];
          }
        }
        return { rows: [], rowCount: outcome === 'inserted' ? 1 : 0 };
      }

      return { rows: [], rowCount: 1 };
    }
  };

  return client;
}

describe('Migration Engine Invariants & Dry Run Mode', () => {
  it('guarantees zero target writes and no checkpoint updates in dry-run mode', async () => {
    // Set up in-memory SQLite database
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(`
      CREATE TABLE clients (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        active INTEGER DEFAULT 1
      );
      INSERT INTO clients (id, name, active) VALUES (1, 'Acme Corp', 1);
      INSERT INTO clients (id, name, active) VALUES (2, 'Globex Inc', 0);
    `);

    const pgMock = createMockPgClient({
      existingTables: ['clients'],
      columnsByTable: {
        clients: [
          { column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null },
          { column_name: 'name', data_type: 'character varying', is_nullable: 'NO', column_default: null },
          { column_name: 'active', data_type: 'boolean', is_nullable: 'YES', column_default: null }
        ]
      }
    });

    const result = await runMigration({
      isDryRun: true,
      sqlite,
      pgClient: pgMock,
      tables: ['clients'],
      exitOnError: false
    });

    assert.strictEqual(result.tablesChecked, 1);
    assert.strictEqual(result.totalInserted, 0);
    assert.strictEqual(result.totalIdentical, 0);
    assert.strictEqual(result.totalConflicting, 0);

    // Verify ZERO writes occurred on the mock Postgres target
    assert.strictEqual(pgMock.writtenQueries.length, 0, 'Target PostgreSQL must receive 0 writes in dry-run mode');
    const checkpointWrites = pgMock.executedQueries.filter(q => q.text.includes('_migration_checkpoints'));
    assert.strictEqual(checkpointWrites.length, 0, 'Checkpoints must not be created or updated in dry-run mode');
  });

  it('fails dry-run when target has the same count but different row content', async () => {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(`CREATE TABLE clients (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO clients VALUES (1, 'Source');`);
    const pgMock = createMockPgClient({
      existingTables: ['clients'],
      columnsByTable: { clients: [
        { column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null },
        { column_name: 'name', data_type: 'character varying', is_nullable: 'YES', column_default: null }
      ] },
      existingRowsByTable: { clients: [{ id: 1, name: 'Different' }] }
    });

    await assert.rejects(runMigration({ isDryRun: true, sqlite, pgClient: pgMock, tables: ['clients'], exitOnError: false }), /contains rows that differ/);
    assert.strictEqual(pgMock.writtenQueries.length, 0);
  });

  it('fails dry-run mode if target table has disparate row count from source table', async () => {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(`
      CREATE TABLE clients (id INTEGER PRIMARY KEY, name TEXT);
      INSERT INTO clients (id, name) VALUES (1, 'Acme Corp');
      INSERT INTO clients (id, name) VALUES (2, 'Globex Inc');
    `);

    const pgMock = createMockPgClient({
      existingTables: ['clients'],
      columnsByTable: {
        clients: [
          { column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null },
          { column_name: 'name', data_type: 'character varying', is_nullable: 'YES', column_default: null }
        ]
      },
      // Target has 1 row while SQLite source has 2 rows
      existingRowsByTable: {
        clients: [{ id: 1, name: 'Acme Corp' }]
      }
    });

    await assert.rejects(
      async () => {
        await runMigration({
          isDryRun: true,
          sqlite,
          pgClient: pgMock,
          tables: ['clients'],
          exitOnError: false
        });
      },
      /Dry run verification failed: Table 'clients' row-count mismatch \(SQLite=2, PostgreSQL=1\)! Target already has disparate rows\./
    );
  });

  it('detects schema mismatch when target PostgreSQL table is missing', async () => {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(`CREATE TABLE clients (id INTEGER PRIMARY KEY, name TEXT);`);

    const pgMock = createMockPgClient({
      existingTables: [] // Table does not exist in target PostgreSQL
    });

    await assert.rejects(
      async () => {
        await runMigration({
          isDryRun: true,
          sqlite,
          pgClient: pgMock,
          tables: ['clients'],
          exitOnError: false
        });
      },
      /Target PostgreSQL table 'clients' does not exist!/
    );
  });

  it('detects schema mismatch when source column is missing in PostgreSQL', async () => {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(`
      CREATE TABLE clients (
        id INTEGER PRIMARY KEY,
        name TEXT,
        legacy_unmapped_field TEXT
      );
    `);

    const pgMock = createMockPgClient({
      existingTables: ['clients'],
      columnsByTable: {
        clients: [
          { column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null },
          { column_name: 'name', data_type: 'character varying', is_nullable: 'NO', column_default: null }
          // legacy_unmapped_field missing in PostgreSQL schema
        ]
      }
    });

    await assert.rejects(
      async () => {
        await runMigration({
          isDryRun: true,
          sqlite,
          pgClient: pgMock,
          tables: ['clients'],
          exitOnError: false
        });
      },
      /Source column 'clients.legacy_unmapped_field' has no corresponding column in PostgreSQL schema!/
    );
  });

  it('detects schema mismatch when column data types are incompatible', async () => {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(`
      CREATE TABLE clients (
        id INTEGER PRIMARY KEY,
        name BLOB
      );
    `);

    const pgMock = createMockPgClient({
      existingTables: ['clients'],
      columnsByTable: {
        clients: [
          { column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null },
          { column_name: 'name', data_type: 'integer', is_nullable: 'NO', column_default: null }
        ]
      }
    });

    await assert.rejects(
      async () => {
        await runMigration({
          isDryRun: true,
          sqlite,
          pgClient: pgMock,
          tables: ['clients'],
          exitOnError: false
        });
      },
      /Column 'clients.name' type mismatch: SQLite type 'BLOB' is incompatible with PostgreSQL type 'integer'!/
    );
  });

  it('rolls back and writes no checkpoint when post-insert reconciliation fails', async () => {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(`CREATE TABLE clients (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO clients VALUES (1, 'Source');`);
    const pgMock = createMockPgClient({
      existingTables: ['clients'],
      columnsByTable: { clients: [
        { column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null },
        { column_name: 'name', data_type: 'character varying', is_nullable: 'YES', column_default: null }
      ] },
      insertedRow: (_table, row) => ({ ...row, name: 'Corrupted by target trigger' })
    });

    await assert.rejects(runMigration({ isDryRun: false, sqlite, pgClient: pgMock, tables: ['clients'], exitOnError: false }), /target rows do not exactly match/);
    assert.ok(pgMock.executedQueries.some(query => query.text === 'ROLLBACK'));
    assert.strictEqual(pgMock.executedQueries.filter(query => query.text.includes('INSERT INTO _migration_checkpoints')).length, 0);
  });

  it('rolls back when inserted rows are not present in the target during final count reconciliation', async () => {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(`CREATE TABLE clients (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO clients VALUES (1, 'Source');`);
    const pgMock = createMockPgClient({
      existingTables: ['clients'],
      columnsByTable: { clients: [
        { column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null },
        { column_name: 'name', data_type: 'character varying', is_nullable: 'YES', column_default: null }
      ] },
      omitInsertedRows: true
    });

    await assert.rejects(runMigration({ isDryRun: false, sqlite, pgClient: pgMock, tables: ['clients'], exitOnError: false }), /source row count 1 differs from target row count 0/);
    assert.ok(pgMock.executedQueries.some(query => query.text === 'ROLLBACK'));
    assert.strictEqual(pgMock.executedQueries.filter(query => query.text.includes('INSERT INTO _migration_checkpoints')).length, 0);
  });

  it('fails empty-source migration when target contains rows and does not checkpoint', async () => {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(`CREATE TABLE clients (id INTEGER PRIMARY KEY, name TEXT);`);
    const pgMock = createMockPgClient({
      existingTables: ['clients'],
      columnsByTable: { clients: [
        { column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null },
        { column_name: 'name', data_type: 'character varying', is_nullable: 'YES', column_default: null }
      ] },
      existingRowsByTable: { clients: [{ id: 1, name: 'Unexpected' }] }
    });

    await assert.rejects(runMigration({ isDryRun: false, sqlite, pgClient: pgMock, tables: ['clients'], exitOnError: false }), /empty source table 'clients'/);
    assert.ok(pgMock.executedQueries.some(query => query.text === 'ROLLBACK'));
    assert.strictEqual(pgMock.executedQueries.filter(query => query.text.includes('INSERT INTO _migration_checkpoints')).length, 0);
  });

  it('accurately reconciles identical records without failing', async () => {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(`
      CREATE TABLE clients (
        id INTEGER PRIMARY KEY,
        name TEXT,
        active INTEGER
      );
      INSERT INTO clients (id, name, active) VALUES (1, 'Alice Corp', 1);
      INSERT INTO clients (id, name, active) VALUES (2, 'Bob LLC', 0);
    `);

    const pgMock = createMockPgClient({
      existingTables: ['clients'],
      columnsByTable: {
        clients: [
          { column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null },
          { column_name: 'name', data_type: 'character varying', is_nullable: 'YES', column_default: null },
          { column_name: 'active', data_type: 'boolean', is_nullable: 'YES', column_default: null }
        ]
      },
      existingRowsByTable: {
        clients: [
          // Row 2 exists with identical data
          { id: 2, name: 'Bob LLC', active: false }
        ]
      },
      insertOutcome: (_table, values) => {
        const id = values[0];
        if (id === 1) return 'inserted'; // Brand new row
        return 'conflict'; // Existing row
      }
    });

    const result = await runMigration({
      isDryRun: false,
      sqlite,
      pgClient: pgMock,
      tables: ['clients'],
      exitOnError: false
    });

    assert.strictEqual(result.totalInserted, 1, 'Exactly 1 row should be newly inserted');
    assert.strictEqual(result.totalIdentical, 1, 'Row 2 should be classified as identical');
    assert.strictEqual(result.totalConflicting, 0, 'No rows should be conflicting');
    assert.strictEqual(result.stats.clients.inserted, 1);
    assert.strictEqual(result.stats.clients.identical, 1);
    assert.strictEqual(result.stats.clients.conflicting, 0);
  });

  it('rejects a conflict matching separate primary and unique-constraint rows', async () => {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(`CREATE TABLE clients (id INTEGER PRIMARY KEY, email TEXT, handle TEXT); INSERT INTO clients VALUES (1, 'a@example.com', 'alice');`);
    const pgMock = createMockPgClient({
      existingTables: ['clients'],
      columnsByTable: { clients: [
        { column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null },
        { column_name: 'email', data_type: 'character varying', is_nullable: 'YES', column_default: null },
        { column_name: 'handle', data_type: 'character varying', is_nullable: 'YES', column_default: null }
      ] },
      constraintsByTable: { clients: [
        { constraint_name: 'clients_pkey', constraint_type: 'PRIMARY KEY', column_name: 'id', ordinal_position: 1 },
        { constraint_name: 'clients_email_key', constraint_type: 'UNIQUE', column_name: 'email', ordinal_position: 1 },
        { constraint_name: 'clients_handle_key', constraint_type: 'UNIQUE', column_name: 'handle', ordinal_position: 1 }
      ] },
      existingRowsByTable: { clients: [
        { id: 1, email: 'old@example.com', handle: 'alice-old' },
        { id: 2, email: 'a@example.com', handle: 'bob' }
      ] },
      insertOutcome: () => 'conflict'
    });

    await assert.rejects(runMigration({ isDryRun: false, sqlite, pgClient: pgMock, tables: ['clients'], exitOnError: false }), /Conflict in table 'clients'/);
    assert.ok(pgMock.executedQueries.some(query => query.text === 'ROLLBACK'));
    assert.strictEqual(pgMock.executedQueries.filter(query => query.text.includes('INSERT INTO _migration_checkpoints')).length, 0);
  });

  it('fails non-zero when conflicting records are detected during migration', async () => {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(`
      CREATE TABLE clients (
        id INTEGER PRIMARY KEY,
        name TEXT,
        active INTEGER
      );
      INSERT INTO clients (id, name, active) VALUES (1, 'Alice Corp', 1);
      INSERT INTO clients (id, name, active) VALUES (2, 'Bob LLC', 0);
    `);

    const pgMock = createMockPgClient({
      existingTables: ['clients'],
      columnsByTable: {
        clients: [
          { column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null },
          { column_name: 'name', data_type: 'character varying', is_nullable: 'YES', column_default: null },
          { column_name: 'active', data_type: 'boolean', is_nullable: 'YES', column_default: null }
        ]
      },
      existingRowsByTable: {
        clients: [
          // Row 2 exists with conflicting data (different name)
          { id: 2, name: 'Bob LLC Altered', active: false }
        ]
      },
      insertOutcome: (_table, values) => {
        const id = values[0];
        if (id === 1) return 'inserted';
        return 'conflict';
      }
    });

    await assert.rejects(
      async () => {
        await runMigration({
          isDryRun: false,
          sqlite,
          pgClient: pgMock,
          tables: ['clients'],
          exitOnError: false
        });
      },
      /Conflict in table 'clients': detected 1 conflicting rows with differing persisted values! Table transaction rolled back\./
    );

    // Verify rollback was issued and checkpoint was NOT written
    const rolledBack = pgMock.executedQueries.some(q => q.text === 'ROLLBACK');
    assert.strictEqual(rolledBack, true, 'ROLLBACK must be executed when a conflict occurs');

    const checkpointInserts = pgMock.executedQueries.filter(q => q.text.includes('INSERT INTO _migration_checkpoints'));
    assert.strictEqual(checkpointInserts.length, 0, 'No checkpoint must be inserted when table transaction fails or conflicts');
  });

  it('skips already completed checkpoints on rerun and resumes only pending tables', async () => {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(`
      CREATE TABLE clients (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE messages (id INTEGER PRIMARY KEY, text TEXT);
      INSERT INTO clients (id, name) VALUES (1, 'Acme Corp');
      INSERT INTO messages (id, text) VALUES (10, 'Hello world');
    `);

    const pgMock = createMockPgClient({
      existingTables: ['clients', 'messages'],
      columnsByTable: {
        clients: [
          { column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null },
          { column_name: 'name', data_type: 'character varying', is_nullable: 'YES', column_default: null }
        ],
        messages: [
          { column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null },
          { column_name: 'text', data_type: 'character varying', is_nullable: 'YES', column_default: null }
        ]
      },
      existingRowsByTable: {
        clients: [
          { id: 1, name: 'Acme Corp' }
        ]
      },
      existingCheckpoints: [
        // 'clients' already marked complete with valid timestamp and count, and verified rows match
        { table_name: 'clients', rows_migrated: 1, completed_at: new Date().toISOString() }
      ]
    });

    const result = await runMigration({
      isDryRun: false,
      sqlite,
      pgClient: pgMock,
      tables: ['clients', 'messages'],
      exitOnError: false
    });

    assert.strictEqual(result.totalSkipped, 1, 'Already verified checkpoint for clients must be skipped');
    assert.strictEqual(result.tablesMigrated, 1, 'Only messages table should be migrated');
    assert.strictEqual(result.totalInserted, 1, 'Only messages row should be inserted');

    // Ensure clients table was NOT re-inserted
    const clientsInserts = pgMock.executedQueries.filter(q => q.text.includes('INSERT INTO clients'));
    assert.strictEqual(clientsInserts.length, 0, 'Clients table must not be re-inserted when checkpoint is complete');

    // Ensure messages checkpoint was recorded
    const messageCheckpoint = pgMock.executedQueries.filter(
      q => q.text.includes('INSERT INTO _migration_checkpoints') && q.values?.[0] === 'messages'
    );
    assert.strictEqual(messageCheckpoint.length, 1, 'Messages checkpoint must be recorded upon completion');
  });

  it('detects and invalidates stale checkpoint if any row beyond index 50 is corrupted or missing', async () => {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(`CREATE TABLE clients (id INTEGER PRIMARY KEY, name TEXT);`);
    const insertStmt = sqlite.prepare(`INSERT INTO clients (id, name) VALUES (?, ?)`);

    const pgRows: Array<{ id: number; name: string }> = [];
    for (let i = 1; i <= 60; i++) {
      insertStmt.run(i, `Client ${i}`);
      // In PostgreSQL, row 55 has corrupted/altered name
      pgRows.push({
        id: i,
        name: i === 55 ? 'Corrupted Client Name' : `Client ${i}`
      });
    }

    const pgMock = createMockPgClient({
      existingTables: ['clients'],
      columnsByTable: {
        clients: [
          { column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null },
          { column_name: 'name', data_type: 'character varying', is_nullable: 'YES', column_default: null }
        ]
      },
      existingRowsByTable: {
        clients: pgRows
      },
      existingCheckpoints: [
        { table_name: 'clients', rows_migrated: 60, completed_at: new Date().toISOString() }
      ],
      insertOutcome: (_table, values) => {
        const id = values[0];
        // Row 55 conflicts with the altered PostgreSQL record
        return id === 55 ? 'conflict' : 'inserted';
      }
    });

    // Run migration - should detect row 55 corruption, delete checkpoint, and re-run table
    // Because row 55 has differing value, live insert/reconciliation detects conflict and rolls back
    await assert.rejects(
      async () => {
        await runMigration({
          isDryRun: false,
          sqlite,
          pgClient: pgMock,
          tables: ['clients'],
          exitOnError: false
        });
      },
      /Conflict in table 'clients'/
    );

    const deleteCheckpoint = pgMock.executedQueries.filter(q => q.text.includes('DELETE FROM _migration_checkpoints'));
    assert.strictEqual(deleteCheckpoint.length, 1, 'Stale checkpoint must be deleted when deep row verification fails');
  });

  it('exits with code 1 on fatal validation error when exitOnError is enabled', async () => {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(`CREATE TABLE clients (id INTEGER PRIMARY KEY);`);

    const pgMock = createMockPgClient({
      existingTables: [] // Force missing table error
    });

    const originalExit = process.exit;
    let exitCode: number | null = null;
    process.exit = ((code: number) => {
      exitCode = code;
      throw new Error(`PROCESS_EXIT_${code}`);
    }) as any;

    try {
      await assert.rejects(
        async () => {
          await runMigration({
            isDryRun: true,
            sqlite,
            pgClient: pgMock,
            tables: ['clients'],
            exitOnError: true
          });
        },
        /PROCESS_EXIT_1/
      );
      assert.strictEqual(exitCode, 1, 'process.exit should be called with code 1');
    } finally {
      process.exit = originalExit;
    }
  });

  it('executing CLI script directly with invalid sqlite path exits with code 1', () => {
    const scriptPath = path.join(process.cwd(), 'scripts/migrate-sqlite-to-postgres.ts');
    let exitError: any = null;

    try {
      execFileSync(
        process.execPath,
        ['--experimental-strip-types', scriptPath, '--sqlite-path=/nonexistent/path/db.sqlite'],
        { encoding: 'utf-8', stdio: 'pipe' }
      );
    } catch (err: any) {
      exitError = err;
    }

    assert.ok(exitError, 'Process must exit with non-zero exit code');
    assert.strictEqual(exitError.status, 1, 'CLI must exit with code 1 on missing sqlite database');
  });

  it('detects schema mismatch when PostgreSQL has required NOT NULL column with no default missing in SQLite', async () => {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(`CREATE TABLE clients (id INTEGER PRIMARY KEY, name TEXT);`);

    const pgMock = createMockPgClient({
      existingTables: ['clients'],
      columnsByTable: {
        clients: [
          { column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null },
          { column_name: 'name', data_type: 'character varying', is_nullable: 'YES', column_default: null },
          { column_name: 'tenant_uuid', data_type: 'character varying', is_nullable: 'NO', column_default: null }
        ]
      }
    });

    await assert.rejects(
      async () => {
        await runMigration({
          isDryRun: true,
          sqlite,
          pgClient: pgMock,
          tables: ['clients'],
          exitOnError: false
        });
      },
      /Target PostgreSQL table 'clients' has required NOT NULL column 'tenant_uuid' with no default, but it does not exist in SQLite source!/
    );
  });

  it('validates required columns and types even when source SQLite table has zero rows', async () => {
    const sqlite = new DatabaseSync(':memory:');
    // Table is defined but completely empty (0 rows)
    sqlite.exec(`CREATE TABLE clients (id INTEGER PRIMARY KEY, invalid_col BLOB);`);

    const pgMock = createMockPgClient({
      existingTables: ['clients'],
      columnsByTable: {
        clients: [
          { column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null },
          { column_name: 'invalid_col', data_type: 'integer', is_nullable: 'YES', column_default: null }
        ]
      }
    });

    await assert.rejects(
      async () => {
        await runMigration({
          isDryRun: true,
          sqlite,
          pgClient: pgMock,
          tables: ['clients'],
          exitOnError: false
        });
      },
      /Column 'clients.invalid_col' type mismatch: SQLite type 'BLOB' is incompatible with PostgreSQL type 'integer'!/
    );
  });

  it('detects foreign key orphan violations and halts migration', async () => {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE clients (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE conversations (
        id INTEGER PRIMARY KEY,
        client_id INTEGER,
        FOREIGN KEY(client_id) REFERENCES clients(id)
      );
      -- Insert an orphaned record in conversations with client_id 999 which does not exist in clients
      INSERT INTO conversations (id, client_id) VALUES (1, 999);
    `);

    const pgMock = createMockPgClient({
      existingTables: ['conversations'],
      columnsByTable: {
        conversations: [
          { column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null },
          { column_name: 'client_id', data_type: 'integer', is_nullable: 'YES', column_default: null }
        ]
      }
    });

    await assert.rejects(
      async () => {
        await runMigration({
          isDryRun: true,
          sqlite,
          pgClient: pgMock,
          tables: ['conversations'],
          exitOnError: false
        });
      },
      /Relational integrity check failed: Table 'conversations' has 1 orphaned foreign key records in source SQLite database!/
    );
  });
});
