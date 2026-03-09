import { describe, it, expect, afterAll } from 'vitest';
import { executeQuery, closeDriver } from './setup.js';

describe('YDB Connection', () => {
    afterAll(async () => {
        await closeDriver();
    });

    it('should execute SELECT 1', async () => {
        const result = await executeQuery('SELECT 1 AS value');
        expect(result.rows.length).toBeGreaterThanOrEqual(1);
        expect(result.rows[0]['value']).toBe(1);
    });

    it('should return column metadata', async () => {
        const result = await executeQuery('SELECT 1 AS id, "hello" AS name');
        expect(result.columns).toHaveLength(2);
        expect(result.columns.map(c => c.name)).toEqual(['id', 'name']);
    });
});
