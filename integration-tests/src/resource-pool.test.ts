import { describe, it, expect, afterAll } from 'vitest';
import { executeQuery, getQueryService, closeDriver } from './setup.js';

describe('YDB Resource Pool', () => {
    afterAll(async () => {
        try { await executeQuery('DROP RESOURCE POOL it_test_pool'); } catch { /* ignored */ }
        await closeDriver();
    });

    it('should appear in .sys/resource_pools with correct properties', async () => {
        await executeQuery(`
            CREATE RESOURCE POOL it_test_pool WITH (
                CONCURRENT_QUERY_LIMIT=5,
                QUEUE_SIZE=10,
                DATABASE_LOAD_CPU_THRESHOLD=80
            )
        `);

        const qs = await getQueryService();
        const pool = await qs.loadResourcePoolByName('it_test_pool');

        expect(pool).toBeDefined();
        expect(pool!.name).toBe('it_test_pool');
        expect(pool!.concurrentQueryLimit).toBe(5);
        expect(pool!.queueSize).toBe(10);
        expect(pool!.databaseLoadCpuThreshold).toBe(80);
    });
});
