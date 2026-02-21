import { describe, it, expect } from 'vitest';
import { SchemeEntryType } from '../../models/types';

describe('SchemeEntryType', () => {
    it('has expected values', () => {
        expect(SchemeEntryType.DIRECTORY).toBe(1);
        expect(SchemeEntryType.TABLE).toBe(2);
        expect(SchemeEntryType.TOPIC).toBe(17);
        expect(SchemeEntryType.VIEW).toBe(20);
        expect(SchemeEntryType.TRANSFER).toBe(23);
    });

    it('has unique values', () => {
        const values = Object.values(SchemeEntryType).filter(v => typeof v === 'number') as number[];
        const uniqueValues = new Set(values);
        expect(values.length).toBe(uniqueValues.size);
    });

    it('contains all expected entry types', () => {
        const expectedNames = [
            'DIRECTORY', 'TABLE', 'PERS_QUEUE_GROUP', 'DATABASE', 'RTMR_VOLUME',
            'BLOCK_STORE_VOLUME', 'COORDINATION_NODE', 'COLUMN_STORE', 'COLUMN_TABLE',
            'SEQUENCE', 'REPLICATION', 'TOPIC', 'EXTERNAL_TABLE', 'EXTERNAL_DATA_SOURCE',
            'VIEW', 'RESOURCE_POOL', 'TRANSFER',
        ];
        for (const name of expectedNames) {
            expect(SchemeEntryType[name as keyof typeof SchemeEntryType]).toBeDefined();
        }
    });
});
