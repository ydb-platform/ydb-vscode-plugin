import { describe, it, expect, afterAll } from 'vitest';
import { executeQuery, getQueryService, getSchemeService, getDatabase, closeDriver } from './setup.js';

describe('YDB Table', () => {
    afterAll(async () => {
        try { await executeQuery('DROP TABLE it_row_table'); } catch { /* ignored */ }
        try { await executeQuery('DROP TABLE it_col_table'); } catch { /* ignored */ }
        await closeDriver();
    });

    async function createTables() {
        await executeQuery(`
            CREATE TABLE it_row_table (
                id Int32 NOT NULL,
                name Utf8,
                value Double,
                PRIMARY KEY (id)
            )
        `).catch(() => {});
        await executeQuery(`
            CREATE TABLE it_col_table (
                id Int32 NOT NULL,
                val Int64,
                PRIMARY KEY (id)
            ) WITH (STORE = COLUMN)
        `).catch(() => {});
    }

    it('should enumerate row table via listDirectory', async () => {
        await createTables();

        const scheme = await getSchemeService();
        const entries = await scheme.listDirectory(getDatabase());
        const found = entries.some(e => e.name === 'it_row_table');
        expect(found).toBe(true);
    });

    it('should describe row table columns', async () => {
        await createTables();

        const qs = await getQueryService();
        const desc = await qs.describeTable(`${getDatabase()}/it_row_table`);
        expect(desc.columns).toHaveLength(3);
        const colNames = desc.columns.map(c => c.name);
        expect(colNames).toContain('id');
        expect(colNames).toContain('name');
        expect(colNames).toContain('value');
    });

    it('should query row table', async () => {
        await createTables();

        const result = await executeQuery('SELECT * FROM it_row_table LIMIT 0');
        expect(result.columns.length).toBeGreaterThanOrEqual(1);
    });

    it('should query column table', async () => {
        await createTables();

        const result = await executeQuery('SELECT * FROM it_col_table LIMIT 0');
        expect(result.columns.length).toBeGreaterThanOrEqual(1);
    });

    it('should describe column table as column store', async () => {
        await createTables();

        const scheme = await getSchemeService();
        const entry = await scheme.describePath(`${getDatabase()}/it_col_table`);
        // SchemeEntryType.COLUMN_TABLE = 13
        expect(entry.type).toBe(13);
    });
});
