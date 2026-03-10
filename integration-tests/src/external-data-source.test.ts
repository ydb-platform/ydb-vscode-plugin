import { describe, it, expect, afterAll } from 'vitest';
import { executeQuery, getQueryService, getDatabase, ensureS3Bucket, closeDriver } from './setup.js';

describe('YDB External Data Source', () => {
    afterAll(async () => {
        try { await executeQuery('DROP EXTERNAL DATA SOURCE it_test_ds'); } catch { /* ignored */ }
        await closeDriver();
    });

    it('should be describable via describeExternalDataSource', async () => {
        const s3Location = await ensureS3Bucket();
        await executeQuery(`
            CREATE EXTERNAL DATA SOURCE it_test_ds WITH (
                SOURCE_TYPE="ObjectStorage",
                LOCATION="${s3Location}",
                AUTH_METHOD="NONE"
            )
        `);

        const qs = await getQueryService();
        const info = await qs.describeExternalDataSource(`${getDatabase()}/it_test_ds`);

        expect(info).toBeDefined();
        expect(info.sourceType).toBe('ObjectStorage');
        expect(info.location).toBeDefined();
        expect(info.location).toContain('test-bucket');
    });
});
