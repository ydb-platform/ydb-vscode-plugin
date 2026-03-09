import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { executeQuery, getQueryService, getDatabase, closeDriver } from './setup.js';

describe('YDB Transfer', () => {
    beforeAll(async () => {
        await executeQuery(`
            CREATE TABLE it_transfer_dst (
                partition Uint32 NOT NULL,
                offset Uint64 NOT NULL,
                message Utf8,
                PRIMARY KEY (partition, offset)
            )
        `);
        await executeQuery('CREATE TOPIC it_transfer_src');
        await executeQuery(`
            CREATE TRANSFER it_test_transfer
            FROM it_transfer_src TO it_transfer_dst
            USING ($msg) -> { return [<|
                partition: $msg._partition,
                offset: $msg._offset,
                message: CAST($msg._data AS Utf8)
            |>]; }
        `);
    });

    afterAll(async () => {
        try { await executeQuery('DROP TRANSFER it_test_transfer'); } catch { /* ignored */ }
        try { await executeQuery('DROP TOPIC it_transfer_src'); } catch { /* ignored */ }
        try { await executeQuery('DROP TABLE it_transfer_dst'); } catch { /* ignored */ }
        await closeDriver();
    });

    it('should be describable via describeTransfer', async () => {
        const qs = await getQueryService();
        const info = await qs.describeTransfer(`${getDatabase()}/it_test_transfer`);

        expect(info).toBeDefined();
        expect(info.sourcePath).toBeDefined();
        expect(info.sourcePath).toContain('it_transfer_src');
        expect(info.destinationPath).toBeDefined();
        expect(info.destinationPath).toContain('it_transfer_dst');
    });
});
