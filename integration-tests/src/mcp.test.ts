import { describe, it, expect, afterAll } from 'vitest';
import { executeQuery, closeDriver, invokeMcpTool, MCP_CONNECTION_NAME } from './setup.js';

const COL_TABLE = 'it_mcp_col_table';
const COL_TABLE_PART = 'it_mcp_col_table_part';
const ROW_TABLE = 'it_mcp_row_table';

async function createMcpTables() {
    await executeQuery(`
        CREATE TABLE ${COL_TABLE} (
            id Int64 NOT NULL,
            name Utf8,
            score Double,
            PRIMARY KEY (id)
        ) WITH (STORE = COLUMN)
    `).catch(() => {});
    await executeQuery(`
        CREATE TABLE ${COL_TABLE_PART} (
            id Int64 NOT NULL,
            name Utf8,
            score Double,
            PRIMARY KEY (id)
        )
        PARTITION BY HASH(id)
        WITH (STORE = COLUMN)
    `).catch(() => {});
    await executeQuery(`
        CREATE TABLE ${ROW_TABLE} (
            id Int32 NOT NULL,
            name Utf8,
            val Int64,
            PRIMARY KEY (id)
        )
    `).catch(() => {});
}

describe('MCP ydb_describe_table', () => {
    afterAll(async () => {
        try { await executeQuery(`DROP TABLE ${COL_TABLE}`); } catch { /* ignored */ }
        try { await executeQuery(`DROP TABLE ${COL_TABLE_PART}`); } catch { /* ignored */ }
        try { await executeQuery(`DROP TABLE ${ROW_TABLE}`); } catch { /* ignored */ }
        await closeDriver();
    });

    // --- column table (no explicit partition_by) ---

    describe('column table', () => {
        it('isColumnTable=true', async () => {
            await createMcpTables();
            const result = await invokeMcpTool('ydb_describe_table', {
                connection: MCP_CONNECTION_NAME,
                path: COL_TABLE,
            });
            const parsed = JSON.parse(result);
            expect(parsed.isColumnTable).toBe(true);
        });

        it('returns correct columns', async () => {
            await createMcpTables();
            const result = await invokeMcpTool('ydb_describe_table', {
                connection: MCP_CONNECTION_NAME,
                path: COL_TABLE,
            });
            const parsed = JSON.parse(result);
            const colNames = parsed.columns.map((c: { name: string }) => c.name);
            expect(colNames).toContain('id');
            expect(colNames).toContain('name');
            expect(colNames).toContain('score');
        });

        it('returns correct primary key', async () => {
            await createMcpTables();
            const result = await invokeMcpTool('ydb_describe_table', {
                connection: MCP_CONNECTION_NAME,
                path: COL_TABLE,
            });
            const parsed = JSON.parse(result);
            expect(parsed.primaryKeys).toEqual(['id']);
        });

        it('partitionBy defaults to primary key for column tables', async () => {
            await createMcpTables();
            const result = await invokeMcpTool('ydb_describe_table', {
                connection: MCP_CONNECTION_NAME,
                path: COL_TABLE,
            });
            const parsed = JSON.parse(result);
            expect(parsed.partitionBy).toEqual(['id']);
        });
    });

    // --- column table with explicit PARTITION_BY ---

    describe('column table with PARTITION_BY', () => {
        it('isColumnTable=true', async () => {
            await createMcpTables();
            const result = await invokeMcpTool('ydb_describe_table', {
                connection: MCP_CONNECTION_NAME,
                path: COL_TABLE_PART,
            });
            const parsed = JSON.parse(result);
            expect(parsed.isColumnTable).toBe(true);
        });

        it('partitionBy contains the declared column', async () => {
            await createMcpTables();
            const result = await invokeMcpTool('ydb_describe_table', {
                connection: MCP_CONNECTION_NAME,
                path: COL_TABLE_PART,
            });
            const parsed = JSON.parse(result);
            expect(parsed.partitionBy).toEqual(['id']);
        });
    });

    // --- row table ---

    describe('row table', () => {
        it('isColumnTable=false', async () => {
            await createMcpTables();
            const result = await invokeMcpTool('ydb_describe_table', {
                connection: MCP_CONNECTION_NAME,
                path: ROW_TABLE,
            });
            const parsed = JSON.parse(result);
            expect(parsed.isColumnTable).toBe(false);
        });

        it('returns correct columns', async () => {
            await createMcpTables();
            const result = await invokeMcpTool('ydb_describe_table', {
                connection: MCP_CONNECTION_NAME,
                path: ROW_TABLE,
            });
            const parsed = JSON.parse(result);
            const colNames = parsed.columns.map((c: { name: string }) => c.name);
            expect(colNames).toContain('id');
            expect(colNames).toContain('name');
            expect(colNames).toContain('val');
        });

        it('returns correct primary key', async () => {
            await createMcpTables();
            const result = await invokeMcpTool('ydb_describe_table', {
                connection: MCP_CONNECTION_NAME,
                path: ROW_TABLE,
            });
            const parsed = JSON.parse(result);
            expect(parsed.primaryKeys).toEqual(['id']);
        });

        it('partitionBy is empty for a basic row table', async () => {
            await createMcpTables();
            const result = await invokeMcpTool('ydb_describe_table', {
                connection: MCP_CONNECTION_NAME,
                path: ROW_TABLE,
            });
            const parsed = JSON.parse(result);
            expect(parsed.partitionBy).toEqual([]);
        });
    });
});
