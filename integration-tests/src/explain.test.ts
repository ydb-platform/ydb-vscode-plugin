import { describe, it, expect, afterAll } from 'vitest';
import { executeQuery, getQueryService, closeDriver } from './setup.js';

describe('YDB Explain', () => {
    afterAll(async () => {
        try { await executeQuery('DROP TABLE it_explain_table'); } catch { /* ignored */ }
        await closeDriver();
    });

    async function createTable() {
        await executeQuery(`
            CREATE TABLE it_explain_table (
                id Int32 NOT NULL,
                value Utf8,
                PRIMARY KEY (id)
            )
        `).catch(() => {});
    }

    it('should return a query plan', async () => {
        await createTable();

        const qs = await getQueryService();
        const result = await qs.explainQuery('SELECT * FROM it_explain_table WHERE id = 1');

        expect(result.plan).toBeDefined();
        expect(result.plan.name).toBeTruthy();
    });

    it('should return raw plan JSON', async () => {
        await createTable();

        const qs = await getQueryService();
        const result = await qs.explainQuery('SELECT * FROM it_explain_table');

        expect(result.rawJson).toBeTruthy();
        expect(() => JSON.parse(result.rawJson!)).not.toThrow();
    });
});
