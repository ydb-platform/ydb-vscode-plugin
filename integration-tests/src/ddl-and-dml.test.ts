import { describe, it, expect, afterAll } from 'vitest';
import { executeQuery, closeDriver } from './setup.js';

describe('YDB DDL and DML', () => {
    afterAll(async () => {
        await closeDriver();
    });

    it('should create and drop a table', async () => {
        await executeQuery(`
            CREATE TABLE ddl_test (
                id Int32 NOT NULL,
                name Utf8,
                PRIMARY KEY (id)
            )
        `);

        // Verify table exists by querying it
        const result = await executeQuery('SELECT COUNT(*) AS cnt FROM ddl_test');
        expect(result.rows).toHaveLength(1);

        await executeQuery('DROP TABLE ddl_test');

        // Verify table no longer exists
        await expect(executeQuery('SELECT COUNT(*) FROM ddl_test')).rejects.toThrow();
    });

    it('should insert, select, and delete rows', async () => {
        await executeQuery(`
            CREATE TABLE dml_test (
                id Int32 NOT NULL,
                value Utf8,
                PRIMARY KEY (id)
            )
        `);

        try {
            // Insert rows
            await executeQuery("INSERT INTO dml_test (id, value) VALUES (1, 'alpha')");
            await executeQuery("INSERT INTO dml_test (id, value) VALUES (2, 'beta')");
            await executeQuery("INSERT INTO dml_test (id, value) VALUES (3, 'gamma')");

            // Select and verify
            const result = await executeQuery('SELECT value FROM dml_test ORDER BY id');
            const values = result.rows.map(r => r['value']);
            expect(values).toEqual(['alpha', 'beta', 'gamma']);

            // Delete and verify empty
            await executeQuery('DELETE FROM dml_test');
            const afterDelete = await executeQuery('SELECT COUNT(*) AS cnt FROM dml_test');
            expect(afterDelete.rows[0]['cnt']).toBe(0);
        } finally {
            await executeQuery('DROP TABLE dml_test');
        }
    });
});
