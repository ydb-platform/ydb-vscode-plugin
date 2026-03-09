import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { executeQuery, getQueryService, getSchemeService, getDatabase, closeDriver } from './setup.js';
import { SchemeEntryType } from '../../src/models/types.js';

describe('YDB View', () => {
    beforeAll(async () => {
        await executeQuery(`
            CREATE TABLE it_view_src (
                id Int32 NOT NULL,
                data Utf8,
                PRIMARY KEY (id)
            )
        `);
        await executeQuery(`
            CREATE VIEW it_test_view WITH (security_invoker = TRUE) AS
            SELECT * FROM \`${getDatabase()}/it_view_src\`
        `);
    });

    afterAll(async () => {
        try { await executeQuery('DROP VIEW it_test_view'); } catch { /* ignored */ }
        try { await executeQuery('DROP TABLE it_view_src'); } catch { /* ignored */ }
        await closeDriver();
    });

    it('should exist via describePath with type VIEW', async () => {
        const scheme = await getSchemeService();
        const entry = await scheme.describePath(`${getDatabase()}/it_test_view`);
        expect(entry.type).toBe(SchemeEntryType.VIEW);
    });

    it('should return query text via describeView', async () => {
        const qs = await getQueryService();
        const queryText = await qs.describeView(`${getDatabase()}/it_test_view`);
        expect(queryText).toBeTruthy();
        expect(queryText).toContain('it_view_src');
    });
});
