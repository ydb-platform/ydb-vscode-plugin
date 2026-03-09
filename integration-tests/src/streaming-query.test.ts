import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { executeQuery, getQueryService, getDatabase, closeDriver } from './setup.js';

describe('YDB Streaming Query', () => {
    beforeAll(async () => {
        await executeQuery('CREATE TOPIC it_sq_src');
        await executeQuery('CREATE TOPIC it_sq_dst');
        await executeQuery(`
            CREATE EXTERNAL DATA SOURCE it_sq_eds WITH (
                SOURCE_TYPE="Ydb",
                LOCATION="localhost:2136",
                DATABASE_NAME="/local",
                AUTH_METHOD="NONE"
            )
        `);
        await executeQuery(`
            CREATE STREAMING QUERY it_sq WITH (RUN = FALSE) AS DO BEGIN
                INSERT INTO it_sq_eds.it_sq_dst SELECT * FROM it_sq_eds.it_sq_src
            END DO
        `);
    });

    afterAll(async () => {
        try { await executeQuery('DROP STREAMING QUERY it_sq'); } catch { /* ignored */ }
        try { await executeQuery('DROP EXTERNAL DATA SOURCE it_sq_eds'); } catch { /* ignored */ }
        try { await executeQuery('DROP TOPIC it_sq_src'); } catch { /* ignored */ }
        try { await executeQuery('DROP TOPIC it_sq_dst'); } catch { /* ignored */ }
        await closeDriver();
    });

    it('should appear in .sys/streaming_queries', async () => {
        const qs = await getQueryService();
        const queries = await qs.loadStreamingQueries(getDatabase());

        const found = queries.find(q => q.fullPath.includes('it_sq') || q.name.includes('it_sq'));
        expect(found).toBeDefined();
        expect(found!.queryText).toContain('it_sq_src');
    });
});
