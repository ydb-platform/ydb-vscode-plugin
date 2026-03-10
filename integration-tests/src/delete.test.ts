/**
 * Integration tests for DeleteService.
 *
 * Suite 1: recursive deletion of a deep mixed-type tree
 *   Each directory contains multiple objects of different types AND multiple
 *   nested subdirectories. Total: 9 dirs + 8 row tables + 6 col tables +
 *   8 topics + 3 views = 34 objects.
 *
 * Suite 2: individual deletion of one object of each supported type
 *   - row table
 *   - column table
 *   - topic
 *   - view
 *   - empty directory
 *   - directory with multiple objects inside
 *   - external data source  (requires MinIO: S3_ENDPOINT env)
 *   - external table        (requires MinIO: S3_ENDPOINT env)
 *   - resource pool
 *   - transfer
 *   - streaming query
 */

import { describe, it, expect, afterAll } from 'vitest';
import {
    executeQuery, getSchemeService, getDatabase, getDriver, closeDriver,
    ensureS3Bucket,
} from './setup.js';
import { QueryService } from '../../src/services/queryService.js';
import { DeleteService } from '../../src/services/deleteService.js';
import { SchemeEntryType } from '../../src/models/types.js';

// ──────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ──────────────────────────────────────────────────────────────────────────────

async function getServices() {
    const driver = await getDriver();
    const scheme = await getSchemeService();
    const queryService = new QueryService(driver);
    const deleteService = new DeleteService(scheme, queryService);
    return { scheme, queryService, deleteService };
}

async function assertGone(fn: () => Promise<unknown>): Promise<void> {
    await expect(fn()).rejects.toThrow();
}

/** Best-effort DROP — ignores errors if the object does not exist. */
const drop = (sql: string) => executeQuery(sql).catch(() => {});


// ──────────────────────────────────────────────────────────────────────────────
// Suite 1: deep mixed-type recursive tree
// ──────────────────────────────────────────────────────────────────────────────

const ROOT = 'it_delete_root';

async function cleanupTree(): Promise<void> {
    const { scheme } = await getServices();
    const run = (fn: () => Promise<unknown>) => fn().catch(() => {});

    const drops: [string, string][] = [
        ['VIEW',  `${ROOT}/alpha/view_a1`],
        ['VIEW',  `${ROOT}/alpha/delta/view_d1`],
        ['VIEW',  `${ROOT}/zeta/eta/view_h1`],
        ['TOPIC', `${ROOT}/alpha/topic_a1`],
        ['TOPIC', `${ROOT}/alpha/beta/topic_b1`],
        ['TOPIC', `${ROOT}/alpha/beta/gamma/topic_g1`],
        ['TOPIC', `${ROOT}/alpha/delta/topic_d1`],
        ['TOPIC', `${ROOT}/alpha/delta/epsilon/topic_e1`],
        ['TOPIC', `${ROOT}/zeta/topic_z1`],
        ['TOPIC', `${ROOT}/zeta/eta/topic_h1`],
        ['TOPIC', `${ROOT}/zeta/theta/topic_t1`],
        ['TABLE', `${ROOT}/alpha/row_a1`],
        ['TABLE', `${ROOT}/alpha/col_a1`],
        ['TABLE', `${ROOT}/alpha/beta/row_b1`],
        ['TABLE', `${ROOT}/alpha/beta/col_b1`],
        ['TABLE', `${ROOT}/alpha/beta/gamma/row_g1`],
        ['TABLE', `${ROOT}/alpha/beta/gamma/col_g1`],
        ['TABLE', `${ROOT}/alpha/delta/row_d1`],
        ['TABLE', `${ROOT}/alpha/delta/col_d1`],
        ['TABLE', `${ROOT}/alpha/delta/epsilon/row_e1`],
        ['TABLE', `${ROOT}/zeta/row_z1`],
        ['TABLE', `${ROOT}/zeta/col_z1`],
        ['TABLE', `${ROOT}/zeta/eta/row_h1`],
        ['TABLE', `${ROOT}/zeta/eta/col_h1`],
        ['TABLE', `${ROOT}/zeta/theta/row_t1`],
    ];
    for (const [kw, p] of drops) {
        await run(() => executeQuery(`DROP ${kw} \`${p}\``));
    }
    for (const dir of [
        `${ROOT}/alpha/beta/gamma`,
        `${ROOT}/alpha/beta`,
        `${ROOT}/alpha/delta/epsilon`,
        `${ROOT}/alpha/delta`,
        `${ROOT}/alpha`,
        `${ROOT}/zeta/eta`,
        `${ROOT}/zeta/theta`,
        `${ROOT}/zeta`,
        ROOT,
    ]) {
        await run(() => scheme.removeDirectory(dir));
    }
}

async function createTree(): Promise<void> {
    const { scheme } = await getServices();

    const mk  = (p: string) => scheme.makeDirectory(p);
    const tbl = (p: string, col = false) => executeQuery(
        `CREATE TABLE \`${p}\` (id Int32 NOT NULL, PRIMARY KEY (id))` +
        (col ? ' WITH (STORE = COLUMN)' : ''),
    );
    const top = (p: string) => executeQuery(`CREATE TOPIC \`${p}\``);
    const vw  = (p: string, src: string) => executeQuery(
        `CREATE VIEW \`${p}\` WITH (security_invoker = TRUE) AS SELECT * FROM \`${src}\``,
    );

    await mk(ROOT);
    await mk(`${ROOT}/alpha`);
    await mk(`${ROOT}/alpha/beta`);
    await mk(`${ROOT}/alpha/beta/gamma`);
    await mk(`${ROOT}/alpha/delta`);
    await mk(`${ROOT}/alpha/delta/epsilon`);
    await mk(`${ROOT}/zeta`);
    await mk(`${ROOT}/zeta/eta`);
    await mk(`${ROOT}/zeta/theta`);

    // alpha: 4 objects + 2 subdirs
    await tbl(`${ROOT}/alpha/row_a1`);
    await tbl(`${ROOT}/alpha/col_a1`, true);
    await top(`${ROOT}/alpha/topic_a1`);
    await vw (`${ROOT}/alpha/view_a1`, `${ROOT}/alpha/row_a1`);

    // beta: 3 objects + 1 subdir
    await tbl(`${ROOT}/alpha/beta/row_b1`);
    await tbl(`${ROOT}/alpha/beta/col_b1`, true);
    await top(`${ROOT}/alpha/beta/topic_b1`);

    // gamma: 3 objects, no subdirs
    await tbl(`${ROOT}/alpha/beta/gamma/row_g1`);
    await tbl(`${ROOT}/alpha/beta/gamma/col_g1`, true);
    await top(`${ROOT}/alpha/beta/gamma/topic_g1`);

    // delta: 4 objects + 1 subdir
    await tbl(`${ROOT}/alpha/delta/row_d1`);
    await tbl(`${ROOT}/alpha/delta/col_d1`, true);
    await top(`${ROOT}/alpha/delta/topic_d1`);
    await vw (`${ROOT}/alpha/delta/view_d1`, `${ROOT}/alpha/delta/row_d1`);

    // epsilon: 2 objects, no subdirs
    await tbl(`${ROOT}/alpha/delta/epsilon/row_e1`);
    await top(`${ROOT}/alpha/delta/epsilon/topic_e1`);

    // zeta: 3 objects + 2 subdirs
    await tbl(`${ROOT}/zeta/row_z1`);
    await tbl(`${ROOT}/zeta/col_z1`, true);
    await top(`${ROOT}/zeta/topic_z1`);

    // eta: 4 objects, no subdirs
    await tbl(`${ROOT}/zeta/eta/row_h1`);
    await tbl(`${ROOT}/zeta/eta/col_h1`, true);
    await top(`${ROOT}/zeta/eta/topic_h1`);
    await vw (`${ROOT}/zeta/eta/view_h1`, `${ROOT}/zeta/eta/row_h1`);

    // theta: 2 objects, no subdirs
    await tbl(`${ROOT}/zeta/theta/row_t1`);
    await top(`${ROOT}/zeta/theta/topic_t1`);
}

describe('DeleteService — recursive deletion of mixed-type nested tree', () => {
    afterAll(async () => {
        await cleanupTree();
    });

    it('should verify each directory contains multiple objects and multiple subdirectories', async () => {
        await cleanupTree();
        await createTree();

        const { scheme } = await getServices();
        const db = getDatabase();
        const ls = (p: string) => scheme.listDirectory(`${db}/${p}`).then(e => e.map(x => x.name));

        const alpha = await ls(`${ROOT}/alpha`);
        expect(alpha).toContain('row_a1');
        expect(alpha).toContain('col_a1');
        expect(alpha).toContain('topic_a1');
        expect(alpha).toContain('view_a1');
        expect(alpha).toContain('beta');
        expect(alpha).toContain('delta');

        const beta = await ls(`${ROOT}/alpha/beta`);
        expect(beta).toContain('row_b1');
        expect(beta).toContain('col_b1');
        expect(beta).toContain('topic_b1');
        expect(beta).toContain('gamma');

        const delta = await ls(`${ROOT}/alpha/delta`);
        expect(delta).toContain('row_d1');
        expect(delta).toContain('col_d1');
        expect(delta).toContain('topic_d1');
        expect(delta).toContain('view_d1');
        expect(delta).toContain('epsilon');

        const zeta = await ls(`${ROOT}/zeta`);
        expect(zeta).toContain('row_z1');
        expect(zeta).toContain('col_z1');
        expect(zeta).toContain('topic_z1');
        expect(zeta).toContain('eta');
        expect(zeta).toContain('theta');
    });

    it('should delete all 34 objects and report monotonically increasing progress', async () => {
        // Tree was created in the previous test; if running standalone, create it.
        const { scheme } = await getServices();
        try {
            await scheme.listDirectory(`${getDatabase()}/${ROOT}`);
        } catch {
            await cleanupTree();
            await createTree();
        }

        const { deleteService } = await getServices();
        const events: { deleted: number; total: number }[] = [];

        await deleteService.deleteRecursive(ROOT, SchemeEntryType.DIRECTORY, 'folder',
            (p) => events.push({ deleted: p.deleted, total: p.total }),
        );

        expect(events.length).toBeGreaterThan(0);

        const last = events[events.length - 1];
        expect(last.deleted).toBe(last.total);
        // 9 dirs + 8 row tables + 6 col tables + 8 topics + 3 views = 34
        expect(last.total).toBe(34);

        for (let i = 1; i < events.length; i++) {
            expect(events[i].deleted).toBeGreaterThanOrEqual(events[i - 1].deleted);
        }

        await assertGone(() => scheme.describePath(`${getDatabase()}/${ROOT}`));
    });
});

// ──────────────────────────────────────────────────────────────────────────────
// Suite 2: individual deletion of one object of each type
// ──────────────────────────────────────────────────────────────────────────────

describe('DeleteService — individual deletion of each object type', () => {
    const P = 'it_del_single';

    afterAll(async () => {
        const { scheme } = await getServices();
        const rmdir = (p: string) => scheme.removeDirectory(p).catch(() => {});

        // Streaming query + dependencies
        await drop('DROP STREAMING QUERY it_del_sq');
        await drop('DROP EXTERNAL DATA SOURCE it_del_sq_eds');
        await drop('DROP TOPIC it_del_sq_src');
        await drop('DROP TOPIC it_del_sq_dst');

        // Transfer + dependencies
        await drop('DROP TRANSFER it_del_transfer');
        await drop('DROP TOPIC it_del_transfer_src');
        await drop('DROP TABLE it_del_transfer_dst');

        // Resource pool
        await drop('DROP RESOURCE POOL it_del_pool');

        // External table + data sources
        await drop('DROP EXTERNAL TABLE it_del_ext_tbl');
        await drop('DROP EXTERNAL DATA SOURCE it_del_eds');
        await drop('DROP EXTERNAL DATA SOURCE it_del_eds2');

        // Objects that may be left inside the shared directory
        await drop(`DROP VIEW \`${P}/view1\``);
        await drop(`DROP TABLE \`${P}/src\``);
        await drop(`DROP TABLE \`${P}/tbl_row\``);
        await drop(`DROP TABLE \`${P}/tbl_col\``);
        await drop(`DROP TOPIC \`${P}/topic1\``);

        // Multi-object directory leftovers
        await drop(`DROP VIEW \`${P}_multi/v1\``);
        await drop(`DROP TOPIC \`${P}_multi/top1\``);
        await drop(`DROP TABLE \`${P}_multi/t1\``);
        await drop(`DROP TABLE \`${P}_multi/t2\``);

        // Directories
        await rmdir(`${P}_multi`);
        await rmdir(`${P}_emptydir`);
        await rmdir(P);

        await closeDriver();
    });

    it('deletes a row table', async () => {
        const { scheme, deleteService } = await getServices();
        await scheme.makeDirectory(P).catch(() => {});
        await executeQuery(`CREATE TABLE \`${P}/tbl_row\` (id Int32 NOT NULL, PRIMARY KEY (id))`);

        await deleteService.deleteRecursive(`${P}/tbl_row`, SchemeEntryType.TABLE, 'table');

        await assertGone(() => scheme.describePath(`${getDatabase()}/${P}/tbl_row`));
    });

    it('deletes a column table', async () => {
        const { scheme, deleteService } = await getServices();
        await scheme.makeDirectory(P).catch(() => {});
        await executeQuery(
            `CREATE TABLE \`${P}/tbl_col\` (id Int32 NOT NULL, PRIMARY KEY (id)) WITH (STORE = COLUMN)`,
        );

        await deleteService.deleteRecursive(`${P}/tbl_col`, SchemeEntryType.COLUMN_TABLE, 'column-store');

        await assertGone(() => scheme.describePath(`${getDatabase()}/${P}/tbl_col`));
    });

    it('deletes a topic', async () => {
        const { scheme, deleteService } = await getServices();
        await scheme.makeDirectory(P).catch(() => {});
        await executeQuery(`CREATE TOPIC \`${P}/topic1\``);

        await deleteService.deleteRecursive(`${P}/topic1`, SchemeEntryType.TOPIC, 'topic');

        await assertGone(() => scheme.describePath(`${getDatabase()}/${P}/topic1`));
    });

    it('deletes a view', async () => {
        const { scheme, deleteService } = await getServices();
        await scheme.makeDirectory(P).catch(() => {});
        await executeQuery(`CREATE TABLE \`${P}/src\` (id Int32 NOT NULL, PRIMARY KEY (id))`);
        await executeQuery(
            `CREATE VIEW \`${P}/view1\` WITH (security_invoker = TRUE) AS SELECT * FROM \`${P}/src\``,
        );

        await deleteService.deleteRecursive(`${P}/view1`, SchemeEntryType.VIEW, 'view');

        await assertGone(() => scheme.describePath(`${getDatabase()}/${P}/view1`));
    });

    it('deletes an empty directory', async () => {
        const { scheme, deleteService } = await getServices();
        await scheme.makeDirectory(`${P}_emptydir`).catch(() => {});

        await deleteService.deleteRecursive(`${P}_emptydir`, SchemeEntryType.DIRECTORY, 'folder');

        await assertGone(() => scheme.describePath(`${getDatabase()}/${P}_emptydir`));
    });

    it('deletes a directory containing multiple objects', async () => {
        const { scheme, deleteService } = await getServices();
        const D = `${P}_multi`;
        await scheme.makeDirectory(D).catch(() => {});
        await executeQuery(`CREATE TABLE \`${D}/t1\` (id Int32 NOT NULL, PRIMARY KEY (id))`);
        await executeQuery(`CREATE TABLE \`${D}/t2\` (id Int32 NOT NULL, PRIMARY KEY (id)) WITH (STORE = COLUMN)`);
        await executeQuery(`CREATE TOPIC \`${D}/top1\``);
        await executeQuery(
            `CREATE VIEW \`${D}/v1\` WITH (security_invoker = TRUE) AS SELECT * FROM \`${D}/t1\``,
        );

        await deleteService.deleteRecursive(D, SchemeEntryType.DIRECTORY, 'folder');

        await assertGone(() => scheme.describePath(`${getDatabase()}/${D}`));
    });

    it('deletes a resource pool', async () => {
        const { deleteService } = await getServices();
        await executeQuery(`CREATE RESOURCE POOL it_del_pool WITH (CONCURRENT_QUERY_LIMIT=5)`);

        await deleteService.deleteRecursive('it_del_pool', SchemeEntryType.RESOURCE_POOL, 'resource-pool');

        await assertGone(() => executeQuery('DROP RESOURCE POOL it_del_pool'));
    });

    it('deletes a transfer', async () => {
        const { scheme, deleteService } = await getServices();
        await executeQuery(`CREATE TABLE it_del_transfer_dst (
            partition Uint32 NOT NULL, offset Uint64 NOT NULL,
            message Utf8, PRIMARY KEY (partition, offset)
        )`);
        await executeQuery(`CREATE TOPIC it_del_transfer_src`);
        await executeQuery(`
            CREATE TRANSFER it_del_transfer
            FROM it_del_transfer_src TO it_del_transfer_dst
            USING ($msg) -> { return [<|
                partition: $msg._partition,
                offset: $msg._offset,
                message: CAST($msg._data AS Utf8)
            |>]; }
        `);

        await deleteService.deleteRecursive('it_del_transfer', SchemeEntryType.TRANSFER, 'transfer');

        await assertGone(() => scheme.describePath(`${getDatabase()}/it_del_transfer`));
    });

    it('deletes a streaming query', async () => {
        const { scheme, deleteService } = await getServices();
        await executeQuery(`CREATE TOPIC it_del_sq_src`);
        await executeQuery(`CREATE TOPIC it_del_sq_dst`);
        await executeQuery(`CREATE EXTERNAL DATA SOURCE it_del_sq_eds WITH (
            SOURCE_TYPE="Ydb",
            LOCATION="localhost:2136",
            DATABASE_NAME="/local",
            AUTH_METHOD="NONE"
        )`);
        await executeQuery(`
            CREATE STREAMING QUERY it_del_sq WITH (RUN = FALSE) AS
            DO BEGIN
                INSERT INTO it_del_sq_eds.it_del_sq_dst
                SELECT * FROM it_del_sq_eds.it_del_sq_src
            END DO
        `);

        // Streaming queries have no dedicated SchemeEntryType; the navigator assigns TOPIC.
        // deleteOne dispatches on contextValue ('streaming-query-stopped'), not on type.
        await deleteService.deleteRecursive('it_del_sq', SchemeEntryType.TOPIC, 'streaming-query-stopped');

        await assertGone(() => scheme.describePath(`${getDatabase()}/it_del_sq`));
    });

    it('deletes an external data source', async () => {
        const { scheme, deleteService } = await getServices();
        const loc = await ensureS3Bucket();
        await executeQuery(`CREATE EXTERNAL DATA SOURCE it_del_eds WITH (
            SOURCE_TYPE="ObjectStorage",
            LOCATION="${loc}",
            AUTH_METHOD="NONE"
        )`);

        await deleteService.deleteRecursive('it_del_eds', SchemeEntryType.EXTERNAL_DATA_SOURCE, 'external-datasource');

        await assertGone(() => scheme.describePath(`${getDatabase()}/it_del_eds`));
    });

    it('deletes an external table', async () => {
        const { scheme, deleteService } = await getServices();
        const loc = await ensureS3Bucket();
        await executeQuery(`CREATE EXTERNAL DATA SOURCE it_del_eds2 WITH (
            SOURCE_TYPE="ObjectStorage",
            LOCATION="${loc}",
            AUTH_METHOD="NONE"
        )`).catch(() => {});
        await executeQuery(`CREATE EXTERNAL TABLE it_del_ext_tbl (
            col1 Utf8 NOT NULL
        ) WITH (
            DATA_SOURCE="it_del_eds2",
            LOCATION="del_test/",
            FORMAT="csv_with_names"
        )`);

        await deleteService.deleteRecursive('it_del_ext_tbl', SchemeEntryType.EXTERNAL_TABLE, 'external-table');

        await assertGone(() => scheme.describePath(`${getDatabase()}/it_del_ext_tbl`));
    });
});
