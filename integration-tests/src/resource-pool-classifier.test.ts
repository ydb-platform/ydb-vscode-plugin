import { describe, it, expect, afterAll } from 'vitest';
import { executeQuery, closeDriver } from './setup.js';

describe('YDB Resource Pool Classifier', () => {
    afterAll(async () => {
        try { await executeQuery('DROP RESOURCE POOL CLASSIFIER it_test_classifier'); } catch { /* ignored */ }
        try { await executeQuery('DROP RESOURCE POOL it_clf_pool'); } catch { /* ignored */ }
        await closeDriver();
    });

    it('should appear in .sys/resource_pool_classifiers with correct properties', async () => {
        await executeQuery('CREATE RESOURCE POOL it_clf_pool WITH (CONCURRENT_QUERY_LIMIT=1)');
        // MEMBER_NAME filter prevents this catch-all classifier from intercepting
        // queries from other test files if cleanup fails.
        await executeQuery(`
            CREATE RESOURCE POOL CLASSIFIER it_test_classifier WITH (
                RANK=1000,
                MEMBER_NAME="it_test_member_nonexistent",
                RESOURCE_POOL="it_clf_pool"
            )
        `);

        const result = await executeQuery(
            "SELECT * FROM `.sys/resource_pool_classifiers` WHERE Name = 'it_test_classifier'",
        );

        expect(result.rows).toHaveLength(1);
        const row = result.rows[0];
        expect(row['Name']).toBe('it_test_classifier');
        expect(row['Rank']).toBe(1000);
        expect(row['ResourcePool']).toBe('it_clf_pool');
    });
});
