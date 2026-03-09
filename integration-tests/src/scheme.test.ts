import { describe, it, expect, afterAll } from 'vitest';
import { getSchemeService, getDatabase, closeDriver } from './setup.js';
import { SchemeEntryType } from '../../src/models/types.js';

describe('YDB Scheme Service', () => {
    afterAll(async () => {
        await closeDriver();
    });

    it('should list root directory', async () => {
        const scheme = await getSchemeService();
        const entries = await scheme.listDirectory(getDatabase());
        expect(entries.length).toBeGreaterThanOrEqual(0);
        // listDirectory should return SchemeEntry objects with name and type
        for (const entry of entries) {
            expect(entry.name).toBeTruthy();
            expect(typeof entry.type).toBe('number');
        }
    });

    it('should describe the database path itself', async () => {
        const scheme = await getSchemeService();
        const entry = await scheme.describePath(getDatabase());
        expect(entry.type).toBe(SchemeEntryType.DIRECTORY);
    });
});
