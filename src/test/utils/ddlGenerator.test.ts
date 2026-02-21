import { describe, it, expect } from 'vitest';
import { generateTableDDL, generateViewDDL, generateTransferDDL, generateExternalTableDDL, generateStreamingQueryDDL } from '../../utils/ddlGenerator';

describe('generateTableDDL', () => {
    it('generates DDL with columns, NOT NULL, and PRIMARY KEY', () => {
        const ddl = generateTableDDL('my_table', {
            columns: [
                { name: 'id', type: 'Uint64', notNull: true },
                { name: 'name', type: 'Utf8', notNull: false },
            ],
            primaryKeys: ['id'],
            partitionBy: [],
            isColumnTable: false,
        });
        expect(ddl).toContain('CREATE TABLE `my_table`');
        expect(ddl).toContain('`id` Uint64 NOT NULL');
        expect(ddl).toContain('`name` Utf8,');
        expect(ddl).not.toContain('`name` Utf8 NOT NULL');
        expect(ddl).toContain('PRIMARY KEY (`id`)');
    });

    it('adds NOT NULL for primary key columns even if notNull is false', () => {
        const ddl = generateTableDDL('t', {
            columns: [
                { name: 'id', type: 'Uint64', notNull: false },
            ],
            primaryKeys: ['id'],
            partitionBy: [],
            isColumnTable: false,
        });
        expect(ddl).toContain('`id` Uint64 NOT NULL');
    });

    it('generates column table DDL with PARTITION BY HASH and WITH STORE = COLUMN', () => {
        const ddl = generateTableDDL('partitioned', {
            columns: [
                { name: 'ts', type: 'Timestamp', notNull: true },
                { name: 'val', type: 'Int32', notNull: false },
            ],
            primaryKeys: ['ts'],
            partitionBy: ['ts'],
            isColumnTable: true,
        });
        expect(ddl).toContain('PARTITION BY HASH(`ts`)');
        expect(ddl).toContain('WITH (STORE = COLUMN)');
        expect(ddl).not.toContain('PARTITION_BY');
    });

    it('generates column table DDL with STORE = COLUMN even without partition keys', () => {
        const ddl = generateTableDDL('col_table', {
            columns: [
                { name: 'id', type: 'Uint64', notNull: true },
            ],
            primaryKeys: ['id'],
            partitionBy: [],
            isColumnTable: true,
        });
        expect(ddl).toContain('WITH (STORE = COLUMN)');
        expect(ddl).not.toContain('PARTITION BY HASH');
    });

    it('does not add PARTITION BY HASH for row tables', () => {
        const ddl = generateTableDDL('row_table', {
            columns: [
                { name: 'id', type: 'Uint64', notNull: true },
            ],
            primaryKeys: ['id'],
            partitionBy: ['id'],
            isColumnTable: false,
        });
        expect(ddl).not.toContain('PARTITION BY HASH');
        expect(ddl).not.toContain('WITH (STORE = COLUMN)');
    });

    it('escapes backticks in path', () => {
        const ddl = generateTableDDL('path/to/table', {
            columns: [{ name: 'id', type: 'Int32', notNull: true }],
            primaryKeys: ['id'],
            partitionBy: [],
            isColumnTable: false,
        });
        expect(ddl).toContain('`path/to/table`');
    });

    it('returns empty string for no columns', () => {
        const ddl = generateTableDDL('empty', {
            columns: [],
            primaryKeys: [],
            partitionBy: [],
            isColumnTable: false,
        });
        expect(ddl).toBe('');
    });

    it('handles multiple primary keys', () => {
        const ddl = generateTableDDL('composite_pk', {
            columns: [
                { name: 'a', type: 'Int32', notNull: true },
                { name: 'b', type: 'Int32', notNull: true },
                { name: 'c', type: 'Utf8', notNull: false },
            ],
            primaryKeys: ['a', 'b'],
            partitionBy: [],
            isColumnTable: false,
        });
        expect(ddl).toContain('PRIMARY KEY (`a`, `b`)');
        expect(ddl).toContain('`a` Int32 NOT NULL');
        expect(ddl).toContain('`b` Int32 NOT NULL');
        expect(ddl).not.toContain('`c` Utf8 NOT NULL');
    });
});

describe('generateViewDDL', () => {
    it('generates CREATE VIEW statement', () => {
        const ddl = generateViewDDL('my_view', 'SELECT * FROM my_table');
        expect(ddl).toBe('CREATE VIEW `my_view` WITH (security_invoker = TRUE) AS\nSELECT * FROM my_table');
    });
});

describe('generateTransferDDL', () => {
    it('generates DDL without lambda', () => {
        const ddl = generateTransferDDL('my_transfer', {
            sourcePath: '/mydb/topic1',
            destinationPath: '/mydb/table1',
            state: 'Running',
        }, '/mydb');
        expect(ddl).toContain('CREATE TRANSFER `my_transfer`');
        expect(ddl).toContain('FROM `topic1` TO `table1`');
        expect(ddl).not.toContain('USING');
    });

    it('generates DDL with lambda', () => {
        const ddl = generateTransferDDL('my_transfer', {
            sourcePath: '/mydb/topic1',
            destinationPath: '/mydb/table1',
            state: 'Running',
            transformationLambda: '$transformation = ($msg) -> { return $msg; };',
        }, '/mydb');
        expect(ddl).toContain('USING $transformation_lambda');
        expect(ddl).toContain('$transformation = ($msg)');
    });

    it('strips database prefix from paths', () => {
        const ddl = generateTransferDDL('t', {
            sourcePath: '/long/database/path/topic1',
            destinationPath: '/long/database/path/table1',
            state: 'Running',
        }, '/long/database/path');
        expect(ddl).toContain('FROM `topic1`');
        expect(ddl).toContain('TO `table1`');
    });

    it('handles missing paths', () => {
        const ddl = generateTransferDDL('t', {
            state: 'Unknown',
        }, '/db');
        expect(ddl).toContain('FROM `` TO ``');
    });
});

describe('generateExternalTableDDL', () => {
    it('generates CREATE EXTERNAL TABLE with WITH params', () => {
        const ddl = generateExternalTableDDL('ext_table', {
            sourceType: 'ObjectStorage',
            dataSourcePath: '/db/my_datasource',
            location: 'path/to/data/',
            columns: [
                { name: 'id', type: 'Uint64', notNull: true },
                { name: 'name', type: 'Utf8', notNull: false },
            ],
            format: 'csv_with_names',
            compression: 'gzip',
        });
        expect(ddl).toContain('CREATE EXTERNAL TABLE `ext_table`');
        expect(ddl).toContain('`id` Uint64 NOT NULL');
        expect(ddl).toContain('`name` Utf8');
        expect(ddl).not.toContain('`name` Utf8 NOT NULL');
        expect(ddl).toContain('DATA_SOURCE="');
        expect(ddl).toContain('SOURCE_TYPE="ObjectStorage"');
        expect(ddl).toContain('LOCATION="path/to/data/"');
        expect(ddl).toContain('FORMAT="csv_with_names"');
        expect(ddl).toContain('COMPRESSION="gzip"');
    });

    it('omits missing WITH params', () => {
        const ddl = generateExternalTableDDL('ext', {
            columns: [
                { name: 'id', type: 'Uint64', notNull: true },
            ],
        });
        expect(ddl).toContain('CREATE EXTERNAL TABLE `ext`');
        expect(ddl).not.toContain('DATA_SOURCE');
        expect(ddl).not.toContain('SOURCE_TYPE');
        expect(ddl).not.toContain('FORMAT');
    });

    it('returns empty string for no columns', () => {
        const ddl = generateExternalTableDDL('ext', {
            columns: [],
        });
        expect(ddl).toBe('');
    });
});

describe('generateStreamingQueryDDL', () => {
    it('generates CREATE STREAMING QUERY with DO BEGIN/END DO', () => {
        const ddl = generateStreamingQueryDDL('my_query', {
            name: 'my_query',
            fullPath: 'my_query',
            status: 'ACTIVE',
            queryText: 'SELECT * FROM my_stream',
        });
        expect(ddl).toBe('CREATE STREAMING QUERY `my_query` AS\nDO BEGIN\nSELECT * FROM my_stream\nEND DO');
    });

    it('returns empty string for empty queryText', () => {
        const ddl = generateStreamingQueryDDL('q', {
            name: 'q',
            fullPath: 'q',
            status: 'ACTIVE',
            queryText: '',
        });
        expect(ddl).toBe('');
    });
});
