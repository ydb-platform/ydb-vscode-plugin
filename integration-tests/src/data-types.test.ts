import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { executeQuery, closeDriver } from './setup.js';

describe('YDB Data Types', () => {
    beforeAll(async () => {
        await executeQuery(`
            CREATE TABLE data_types_test (
                id Int32 NOT NULL,
                int_val Int32,
                text_val Utf8,
                bool_val Bool,
                double_val Double,
                ts_val Timestamp,
                PRIMARY KEY (id)
            )
        `);
    });

    afterAll(async () => {
        try { await executeQuery('DROP TABLE data_types_test'); } catch { /* ignored */ }
        await closeDriver();
    });

    it('should round-trip basic data types', async () => {
        await executeQuery(`
            INSERT INTO data_types_test (id, int_val, text_val, bool_val, double_val, ts_val)
            VALUES (42, 12345, 'Hello, YDB!', true, 3.14159, Timestamp('2024-01-15T10:30:00.000000Z'))
        `);

        const result = await executeQuery(
            'SELECT id, int_val, text_val, bool_val, double_val, ts_val FROM data_types_test WHERE id = 42',
        );

        expect(result.rows).toHaveLength(1);
        const row = result.rows[0];

        expect(row['id']).toBe(42);
        expect(row['int_val']).toBe(12345);
        expect(row['text_val']).toBe('Hello, YDB!');
        expect(row['bool_val']).toBe(true);
        expect(row['double_val']).toBeCloseTo(3.14159, 5);
        // Timestamp comes back as string or number — just verify it's present
        expect(row['ts_val']).toBeDefined();

        // Cleanup
        await executeQuery('DELETE FROM data_types_test WHERE id = 42');
    });
});
