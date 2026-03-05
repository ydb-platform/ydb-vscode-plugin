import { describe, it, expect } from 'vitest';
import { extractValue } from '../../utils/valueExtractor';

function makeValue(valueCase: string, val: unknown): { value: { case: string; value: unknown }; items?: unknown[]; pairs?: unknown[] } {
    return { value: { case: valueCase, value: val } } as never;
}

describe('extractValue', () => {
    it('returns null for null', () => {
        expect(extractValue(null)).toBeNull();
    });

    it('returns null for undefined', () => {
        expect(extractValue(undefined)).toBeNull();
    });

    it('extracts bool value', () => {
        expect(extractValue(makeValue('boolValue', true) as never)).toBe(true);
        expect(extractValue(makeValue('boolValue', false) as never)).toBe(false);
    });

    it('extracts int32 value', () => {
        expect(extractValue(makeValue('int32Value', 42) as never)).toBe(42);
    });

    it('extracts uint32 value', () => {
        expect(extractValue(makeValue('uint32Value', 100) as never)).toBe(100);
    });

    it('extracts int64 value as number', () => {
        expect(extractValue(makeValue('int64Value', BigInt(123456)) as never)).toBe(123456);
    });

    it('extracts uint64 value as number', () => {
        expect(extractValue(makeValue('uint64Value', BigInt(999)) as never)).toBe(999);
    });

    it('extracts float value', () => {
        expect(extractValue(makeValue('floatValue', 3.14) as never)).toBeCloseTo(3.14);
    });

    it('extracts double value', () => {
        expect(extractValue(makeValue('doubleValue', 2.718281828) as never)).toBeCloseTo(2.718281828);
    });

    it('extracts bytes value as base64', () => {
        const bytes = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
        const result = extractValue(makeValue('bytesValue', bytes) as never);
        expect(result).toBe(Buffer.from('Hello').toString('base64'));
    });

    it('extracts text value', () => {
        expect(extractValue(makeValue('textValue', 'hello world') as never)).toBe('hello world');
    });

    it('extracts nullFlag value', () => {
        expect(extractValue(makeValue('nullFlagValue', 0) as never)).toBeNull();
    });

    it('extracts nested value', () => {
        const inner = makeValue('textValue', 'nested');
        expect(extractValue(makeValue('nestedValue', inner) as never)).toBe('nested');
    });

    it('extracts items (list/tuple)', () => {
        const value = {
            value: { case: undefined, value: undefined },
            items: [
                makeValue('int32Value', 1),
                makeValue('int32Value', 2),
                makeValue('int32Value', 3),
            ],
        } as never;
        expect(extractValue(value)).toEqual([1, 2, 3]);
    });

    it('extracts pairs (dict/struct)', () => {
        // items is empty array (falsy for length check), so we need to adjust
        const adjustedValue = {
            value: { case: undefined, value: undefined },
            items: undefined,
            pairs: [
                { key: makeValue('textValue', 'a'), payload: makeValue('int32Value', 1) },
                { key: makeValue('textValue', 'b'), payload: makeValue('int32Value', 2) },
            ],
        } as never;
        expect(extractValue(adjustedValue)).toEqual({ a: 1, b: 2 });
    });

    it('returns string for empty value object', () => {
        const value = { value: { case: undefined, value: undefined } } as never;
        const result = extractValue(value);
        expect(typeof result).toBe('string');
    });
});
