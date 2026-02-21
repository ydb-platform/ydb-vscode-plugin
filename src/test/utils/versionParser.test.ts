import { describe, it, expect } from 'vitest';
import { parseYdbVersion, isVersionSupported } from '../../utils/versionParser';

describe('parseYdbVersion', () => {
    it('parses stable-25-4', () => {
        const v = parseYdbVersion('stable-25-4');
        expect(v).toBeDefined();
        expect(v!.major).toBe(25);
        expect(v!.minor).toBe(4);
        expect(v!.isStable).toBe(true);
    });

    it('parses stable-26-1 with patch', () => {
        const v = parseYdbVersion('stable-26-1-8');
        expect(v).toBeDefined();
        expect(v!.major).toBe(26);
        expect(v!.minor).toBe(1);
    });

    it('decodes base64-encoded version', () => {
        const encoded = Buffer.from('stable-25-4-1-8').toString('base64');
        const v = parseYdbVersion(encoded);
        expect(v).toBeDefined();
        expect(v!.major).toBe(25);
        expect(v!.minor).toBe(4);
    });

    it('handles main/trunk/dev as non-stable', () => {
        for (const name of ['main', 'trunk', 'dev']) {
            const v = parseYdbVersion(name);
            expect(v).toBeDefined();
            expect(v!.isStable).toBe(false);
        }
    });

    it('returns undefined for empty string', () => {
        expect(parseYdbVersion('')).toBeUndefined();
    });

    it('returns undefined for whitespace-only', () => {
        expect(parseYdbVersion('   ')).toBeUndefined();
    });

    it('returns undefined for garbage', () => {
        expect(parseYdbVersion('stable-')).toBeUndefined();
    });
});

describe('isVersionSupported', () => {
    it('26.1 is supported for minVersion 26.1', () => {
        expect(isVersionSupported('stable-26-1', 26, 1)).toBe(true);
    });

    it('26.0 is NOT supported for minVersion 26.1', () => {
        expect(isVersionSupported('stable-26-0', 26, 1)).toBe(false);
    });

    it('27.0 is supported for minVersion 26.1', () => {
        expect(isVersionSupported('stable-27-0', 26, 1)).toBe(true);
    });

    it('25.4 is NOT supported for minVersion 26.1', () => {
        expect(isVersionSupported('stable-25-4', 26, 1)).toBe(false);
    });

    it('non-stable versions are always supported', () => {
        expect(isVersionSupported('main', 26, 1)).toBe(true);
        expect(isVersionSupported('trunk', 99, 99)).toBe(true);
    });

    it('returns false for empty string', () => {
        expect(isVersionSupported('', 26, 1)).toBe(false);
    });

    it('returns true for non-stable word (treated as dev build)', () => {
        // "not-a-version" starts with a letter, so it's treated as non-stable (always supported)
        expect(isVersionSupported('not-a-version', 26, 1)).toBe(true);
    });

    it('returns false for malformed stable prefix', () => {
        expect(isVersionSupported('stable-', 26, 1)).toBe(false);
    });
});
