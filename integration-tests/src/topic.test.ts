import { describe, it, expect, afterAll } from 'vitest';
import { executeQuery, getSchemeService, getDatabase, closeDriver } from './setup.js';
import { SchemeEntryType } from '../../src/models/types.js';

describe('YDB Topic', () => {
    afterAll(async () => {
        try { await executeQuery('DROP TOPIC it_test_topic'); } catch { /* ignored */ }
        await closeDriver();
    });

    it('should exist via describePath with type TOPIC', async () => {
        await executeQuery(`
            CREATE TOPIC it_test_topic (
                CONSUMER it_consumer WITH (important = true)
            ) WITH (
                min_active_partitions = 2,
                retention_period = Interval('P1D')
            )
        `);

        const scheme = await getSchemeService();
        const entry = await scheme.describePath(`${getDatabase()}/it_test_topic`);
        expect(entry.type).toBe(SchemeEntryType.TOPIC);
    });
});
