import { describe, it, expect } from 'vitest';
import { SchemeEntryType } from '../../models/types';
import type { SchemeEntry } from '../../models/types';

describe('SchemeEntry model', () => {
    it('maps numeric entry type correctly', () => {
        const entry: SchemeEntry = {
            name: 'my_table',
            type: SchemeEntryType.TABLE,
        };
        expect(entry.type).toBe(2);
        expect(entry.name).toBe('my_table');
    });

    it('supports permissions', () => {
        const entry: SchemeEntry = {
            name: 'test',
            type: SchemeEntryType.DIRECTORY,
            owner: 'root',
            permissions: [{ subject: 'alice', permissionNames: ['ydb.tables.read'] }],
            effectivePermissions: [{ subject: 'bob', permissionNames: ['ydb.tables.read', 'ydb.tables.modify'] }],
        };
        expect(entry.permissions).toHaveLength(1);
        expect(entry.effectivePermissions).toHaveLength(1);
        expect(entry.effectivePermissions![0].permissionNames).toHaveLength(2);
    });

    it('has optional fields', () => {
        const entry: SchemeEntry = {
            name: 'minimal',
            type: SchemeEntryType.TABLE,
        };
        expect(entry.owner).toBeUndefined();
        expect(entry.permissions).toBeUndefined();
        expect(entry.effectivePermissions).toBeUndefined();
    });
});

describe('SchemeEntryType numeric mapping', () => {
    it('all entry types map to expected values', () => {
        const mapping: [string, number][] = [
            ['DIRECTORY', 1],
            ['TABLE', 2],
            ['PERS_QUEUE_GROUP', 3],
            ['DATABASE', 4],
            ['COORDINATION_NODE', 7],
            ['COLUMN_STORE', 12],
            ['COLUMN_TABLE', 13],
            ['SEQUENCE', 15],
            ['REPLICATION', 16],
            ['TOPIC', 17],
            ['EXTERNAL_TABLE', 18],
            ['EXTERNAL_DATA_SOURCE', 19],
            ['VIEW', 20],
            ['RESOURCE_POOL', 21],
            ['TRANSFER', 23],
        ];
        for (const [name, value] of mapping) {
            expect(SchemeEntryType[name as keyof typeof SchemeEntryType]).toBe(value);
        }
    });
});
