import { describe, it, expect } from 'vitest';
import { parseType, splitTypeArgs, decodeValueByType, isBase64StringType } from '../../utils/typeDecoder';

const dec = (s: string) => 'DECODED:' + s;

describe('splitTypeArgs', () => {
    it('splits two simple args', () => {
        expect(splitTypeArgs('String, Int32')).toEqual(['String', 'Int32']);
    });

    it('handles nested angle brackets', () => {
        expect(splitTypeArgs('Dict<String, Int32>, String')).toEqual(['Dict<String, Int32>', 'String']);
    });

    it('does not split inside parentheses (Decimal)', () => {
        expect(splitTypeArgs('Decimal(3, 5), String')).toEqual(['Decimal(3, 5)', 'String']);
    });

    it('handles single arg', () => {
        expect(splitTypeArgs('String')).toEqual(['String']);
    });

    it('handles deeply nested', () => {
        expect(splitTypeArgs('Dict<String, List<String>>, Utf8')).toEqual(['Dict<String, List<String>>', 'Utf8']);
    });
});

describe('parseType', () => {
    it('parses primitive String', () => {
        expect(parseType('String')).toEqual({ kind: 'primitive', name: 'STRING' });
    });

    it('parses primitive Utf8', () => {
        expect(parseType('Utf8')).toEqual({ kind: 'primitive', name: 'UTF8' });
    });

    it('parses primitive Int32', () => {
        expect(parseType('Int32')).toEqual({ kind: 'primitive', name: 'INT32' });
    });

    it('parses Optional<String>', () => {
        expect(parseType('Optional<String>')).toEqual({
            kind: 'optional',
            item: { kind: 'primitive', name: 'STRING' },
        });
    });

    it('parses Optional<Utf8>', () => {
        expect(parseType('Optional<Utf8>')).toEqual({
            kind: 'optional',
            item: { kind: 'primitive', name: 'UTF8' },
        });
    });

    it('parses List<String>', () => {
        expect(parseType('List<String>')).toEqual({
            kind: 'list',
            item: { kind: 'primitive', name: 'STRING' },
        });
    });

    it('parses Dict<String, String>', () => {
        expect(parseType('Dict<String, String>')).toEqual({
            kind: 'dict',
            key: { kind: 'primitive', name: 'STRING' },
            value: { kind: 'primitive', name: 'STRING' },
        });
    });

    it('parses Dict<Utf8, Int32>', () => {
        expect(parseType('Dict<Utf8, Int32>')).toEqual({
            kind: 'dict',
            key: { kind: 'primitive', name: 'UTF8' },
            value: { kind: 'primitive', name: 'INT32' },
        });
    });

    it('parses Struct with String and Int32 fields', () => {
        expect(parseType('Struct<name: String, age: Int32>')).toEqual({
            kind: 'struct',
            members: [
                { name: 'name', type: { kind: 'primitive', name: 'STRING' } },
                { name: 'age', type: { kind: 'primitive', name: 'INT32' } },
            ],
        });
    });

    it('parses Tuple<String, Utf8>', () => {
        expect(parseType('Tuple<String, Utf8>')).toEqual({
            kind: 'tuple',
            elements: [
                { kind: 'primitive', name: 'STRING' },
                { kind: 'primitive', name: 'UTF8' },
            ],
        });
    });

    it('parses nested Dict<String, List<String>>', () => {
        expect(parseType('Dict<String, List<String>>')).toEqual({
            kind: 'dict',
            key: { kind: 'primitive', name: 'STRING' },
            value: { kind: 'list', item: { kind: 'primitive', name: 'STRING' } },
        });
    });

    it('parses Optional<Dict<String, String>>', () => {
        expect(parseType('Optional<Dict<String, String>>')).toEqual({
            kind: 'optional',
            item: {
                kind: 'dict',
                key: { kind: 'primitive', name: 'STRING' },
                value: { kind: 'primitive', name: 'STRING' },
            },
        });
    });

    it('parses Struct with nested type', () => {
        expect(parseType('Struct<tags: List<String>, score: Double>')).toEqual({
            kind: 'struct',
            members: [
                { name: 'tags', type: { kind: 'list', item: { kind: 'primitive', name: 'STRING' } } },
                { name: 'score', type: { kind: 'primitive', name: 'DOUBLE' } },
            ],
        });
    });

    it('handles Decimal(p, s) as primitive', () => {
        const result = parseType('Decimal(22, 9)');
        expect(result.kind).toBe('primitive');
    });
});

describe('isBase64StringType', () => {
    it('returns true for STRING primitive', () => {
        expect(isBase64StringType(parseType('String'))).toBe(true);
    });

    it('returns true for YSON primitive', () => {
        expect(isBase64StringType(parseType('Yson'))).toBe(true);
    });

    it('returns false for UTF8', () => {
        expect(isBase64StringType(parseType('Utf8'))).toBe(false);
    });

    it('returns false for Int32', () => {
        expect(isBase64StringType(parseType('Int32'))).toBe(false);
    });

    it('returns false for Optional', () => {
        expect(isBase64StringType(parseType('Optional<String>'))).toBe(false);
    });
});

describe('decodeValueByType', () => {
    it('decodes primitive String', () => {
        expect(decodeValueByType('abc', parseType('String'), dec)).toBe('DECODED:abc');
    });

    it('decodes YSON', () => {
        expect(decodeValueByType('abc', parseType('Yson'), dec)).toBe('DECODED:abc');
    });

    it('does not decode Utf8', () => {
        expect(decodeValueByType('abc', parseType('Utf8'), dec)).toBe('abc');
    });

    it('does not decode Int32', () => {
        expect(decodeValueByType(42, parseType('Int32'), dec)).toBe(42);
    });

    it('decodes Optional<String>', () => {
        expect(decodeValueByType('abc', parseType('Optional<String>'), dec)).toBe('DECODED:abc');
    });

    it('does not decode Optional<Utf8>', () => {
        expect(decodeValueByType('abc', parseType('Optional<Utf8>'), dec)).toBe('abc');
    });

    it('handles null', () => {
        expect(decodeValueByType(null, parseType('String'), dec)).toBeNull();
    });

    it('handles undefined', () => {
        expect(decodeValueByType(undefined, parseType('String'), dec)).toBeUndefined();
    });

    it('decodes List<String> items', () => {
        expect(decodeValueByType(['a', 'b', 'c'], parseType('List<String>'), dec)).toEqual([
            'DECODED:a', 'DECODED:b', 'DECODED:c',
        ]);
    });

    it('does not decode List<Utf8> items', () => {
        expect(decodeValueByType(['a', 'b'], parseType('List<Utf8>'), dec)).toEqual(['a', 'b']);
    });

    it('decodes Dict<String, String> keys and values', () => {
        expect(decodeValueByType({ k1: 'v1', k2: 'v2' }, parseType('Dict<String, String>'), dec)).toEqual({
            'DECODED:k1': 'DECODED:v1',
            'DECODED:k2': 'DECODED:v2',
        });
    });

    it('decodes only Dict values when key is Utf8', () => {
        expect(decodeValueByType({ mykey: 'v1' }, parseType('Dict<Utf8, String>'), dec)).toEqual({
            mykey: 'DECODED:v1',
        });
    });

    it('decodes only Dict keys when value is Utf8', () => {
        expect(decodeValueByType({ mykey: 'v1' }, parseType('Dict<String, Utf8>'), dec)).toEqual({
            'DECODED:mykey': 'v1',
        });
    });

    it('does not decode Dict<Utf8, Int32>', () => {
        expect(decodeValueByType({ mykey: 42 }, parseType('Dict<Utf8, Int32>'), dec)).toEqual({
            mykey: 42,
        });
    });

    it('decodes Struct String fields, leaves others untouched', () => {
        expect(
            decodeValueByType(
                { name: 'abc', count: 42, tag: 'xyz' },
                parseType('Struct<name: String, count: Int32, tag: Utf8>'),
                dec,
            ),
        ).toEqual({ name: 'DECODED:abc', count: 42, tag: 'xyz' });
    });

    it('decodes Tuple<String, Utf8, Int32>', () => {
        expect(decodeValueByType(['a', 'b', 42], parseType('Tuple<String, Utf8, Int32>'), dec)).toEqual([
            'DECODED:a', 'b', 42,
        ]);
    });

    it('decodes nested Dict<String, List<String>>', () => {
        expect(
            decodeValueByType({ k: ['a', 'b'] }, parseType('Dict<String, List<String>>'), dec),
        ).toEqual({ 'DECODED:k': ['DECODED:a', 'DECODED:b'] });
    });

    it('decodes Optional<Struct<name: String, val: Utf8>>', () => {
        expect(
            decodeValueByType(
                { name: 'abc', val: 'xyz' },
                parseType('Optional<Struct<name: String, val: Utf8>>'),
                dec,
            ),
        ).toEqual({ name: 'DECODED:abc', val: 'xyz' });
    });

    it('decodes Struct<data: Dict<String, String>>', () => {
        expect(
            decodeValueByType(
                { data: { k: 'v' } },
                parseType('Struct<data: Dict<String, String>>'),
                dec,
            ),
        ).toEqual({ data: { 'DECODED:k': 'DECODED:v' } });
    });

    it('decodes Optional<List<String>>', () => {
        expect(
            decodeValueByType(['a', 'b'], parseType('Optional<List<String>>'), dec),
        ).toEqual(['DECODED:a', 'DECODED:b']);
    });

    it('decodes Yson inside Struct', () => {
        expect(
            decodeValueByType({ raw: 'yyy' }, parseType('Struct<raw: Yson>'), dec),
        ).toEqual({ raw: 'DECODED:yyy' });
    });

    it('passes non-string value through String primitive unchanged', () => {
        // bytes already decoded to base64 string by extractValue, but numbers stay numbers
        expect(decodeValueByType(42, parseType('String'), dec)).toBe(42);
    });

    it('handles empty List', () => {
        expect(decodeValueByType([], parseType('List<String>'), dec)).toEqual([]);
    });

    it('handles empty Dict', () => {
        expect(decodeValueByType({}, parseType('Dict<String, String>'), dec)).toEqual({});
    });

    it('handles empty Struct members', () => {
        expect(decodeValueByType({}, parseType('Struct<>'), dec)).toEqual({});
    });

    it('handles unknown type without decoding', () => {
        expect(decodeValueByType('abc', { kind: 'unknown' }, dec)).toBe('abc');
    });

    it('decodes Dict<String, Struct<name: String, n: Int32>>', () => {
        expect(
            decodeValueByType(
                { k: { name: 'v', n: 5 } },
                parseType('Dict<String, Struct<name: String, n: Int32>>'),
                dec,
            ),
        ).toEqual({ 'DECODED:k': { name: 'DECODED:v', n: 5 } });
    });

    it('decodes Tuple<Dict<String, String>, String>', () => {
        expect(
            decodeValueByType(
                [{ k: 'v' }, 'abc'],
                parseType('Tuple<Dict<String, String>, String>'),
                dec,
            ),
        ).toEqual([{ 'DECODED:k': 'DECODED:v' }, 'DECODED:abc']);
    });

    it('decodes List<Optional<String>>', () => {
        expect(
            decodeValueByType(['a', 'b'], parseType('List<Optional<String>>'), dec),
        ).toEqual(['DECODED:a', 'DECODED:b']);
    });
});
