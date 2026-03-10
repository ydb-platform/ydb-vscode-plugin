import { describe, it, expect, afterAll } from 'vitest';
import { executeQuery, getQueryService, getDatabase, ensureS3Bucket, closeDriver } from './setup.js';

describe('YDB External Table', () => {
    afterAll(async () => {
        try { await executeQuery('DROP EXTERNAL TABLE it_ext_table'); } catch { /* ignored */ }
        try { await executeQuery('DROP EXTERNAL DATA SOURCE it_ext_ds'); } catch { /* ignored */ }
        await closeDriver();
    });

    async function createExternalTable() {
        const s3Location = await ensureS3Bucket();
        await executeQuery(`
            CREATE EXTERNAL DATA SOURCE it_ext_ds WITH (
                SOURCE_TYPE="ObjectStorage",
                LOCATION="${s3Location}",
                AUTH_METHOD="NONE"
            )
        `).catch(() => {});
        await executeQuery(`
            CREATE EXTERNAL TABLE it_ext_table (
                key Utf8 NOT NULL,
                value Utf8
            ) WITH (
                DATA_SOURCE="it_ext_ds",
                LOCATION="test_folder/",
                FORMAT="csv_with_names"
            )
        `).catch(() => {});
    }

    it('should be describable via describeExternalTable', async () => {
        await createExternalTable();

        const qs = await getQueryService();
        const info = await qs.describeExternalTable(`${getDatabase()}/it_ext_table`);
        expect(info).toBeDefined();
    });

    it('should have correct column metadata', async () => {
        await createExternalTable();

        const qs = await getQueryService();
        const info = await qs.describeExternalTable(`${getDatabase()}/it_ext_table`);
        const colNames = info.columns.map(c => c.name);
        expect(colNames).toContain('key');
        expect(colNames).toContain('value');
    });
});
