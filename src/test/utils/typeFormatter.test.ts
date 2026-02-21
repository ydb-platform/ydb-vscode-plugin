import { describe, it, expect } from 'vitest';
import { formatType } from '../../utils/typeFormatter';
import { Type_PrimitiveTypeId } from '@ydbjs/api/value';

function makeType(typeCase: string, value: unknown): { type: { case: string; value: unknown } } {
    return { type: { case: typeCase, value } } as never;
}

describe('formatType', () => {
    it('returns Unknown for null', () => {
        expect(formatType(null)).toBe('Unknown');
    });

    it('returns Unknown for undefined', () => {
        expect(formatType(undefined)).toBe('Unknown');
    });

    it('returns Unknown for empty type', () => {
        expect(formatType({} as never)).toBe('Unknown');
    });

    it('formats BOOL primitive type', () => {
        expect(formatType(makeType('typeId', Type_PrimitiveTypeId.BOOL) as never)).toBe('BOOL');
    });

    it('formats INT32 primitive type', () => {
        expect(formatType(makeType('typeId', Type_PrimitiveTypeId.INT32) as never)).toBe('INT32');
    });

    it('formats UTF8 primitive type', () => {
        expect(formatType(makeType('typeId', Type_PrimitiveTypeId.UTF8) as never)).toBe('UTF8');
    });

    it('formats TIMESTAMP primitive type', () => {
        expect(formatType(makeType('typeId', Type_PrimitiveTypeId.TIMESTAMP) as never)).toBe('TIMESTAMP');
    });

    it('formats UINT64 primitive type', () => {
        expect(formatType(makeType('typeId', Type_PrimitiveTypeId.UINT64) as never)).toBe('UINT64');
    });

    it('formats Optional type', () => {
        const inner = makeType('typeId', Type_PrimitiveTypeId.INT32);
        const optType = makeType('optionalType', { item: inner });
        expect(formatType(optType as never)).toBe('Optional<INT32>');
    });

    it('formats List type', () => {
        const inner = makeType('typeId', Type_PrimitiveTypeId.UTF8);
        const listType = makeType('listType', { item: inner });
        expect(formatType(listType as never)).toBe('List<UTF8>');
    });

    it('formats Dict type', () => {
        const key = makeType('typeId', Type_PrimitiveTypeId.UTF8);
        const payload = makeType('typeId', Type_PrimitiveTypeId.INT32);
        const dictType = makeType('dictType', { key, payload });
        expect(formatType(dictType as never)).toBe('Dict<UTF8, INT32>');
    });

    it('formats Struct type', () => {
        const field1Type = makeType('typeId', Type_PrimitiveTypeId.UTF8);
        const field2Type = makeType('typeId', Type_PrimitiveTypeId.INT64);
        const structType = makeType('structType', {
            members: [
                { name: 'name', type: field1Type },
                { name: 'age', type: field2Type },
            ],
        });
        expect(formatType(structType as never)).toBe('Struct<name: UTF8, age: INT64>');
    });

    it('formats Tuple type', () => {
        const elem1 = makeType('typeId', Type_PrimitiveTypeId.INT32);
        const elem2 = makeType('typeId', Type_PrimitiveTypeId.UTF8);
        const tupleType = makeType('tupleType', { elements: [elem1, elem2] });
        expect(formatType(tupleType as never)).toBe('Tuple<INT32, UTF8>');
    });

    it('formats Decimal type', () => {
        const decimalType = makeType('decimalType', { precision: 22, scale: 9 });
        expect(formatType(decimalType as never)).toBe('Decimal(22, 9)');
    });

    it('formats nested Optional<List<Struct>>', () => {
        const fieldType = makeType('typeId', Type_PrimitiveTypeId.UTF8);
        const structType = makeType('structType', { members: [{ name: 'f', type: fieldType }] });
        const listType = makeType('listType', { item: structType });
        const optType = makeType('optionalType', { item: listType });
        expect(formatType(optType as never)).toBe('Optional<List<Struct<f: UTF8>>>');
    });

    it('returns Unknown for unknown case', () => {
        const unknown = makeType('unknownCase', {});
        expect(formatType(unknown as never)).toBe('Unknown');
    });

    it('handles unknown typeId with fallback', () => {
        const unknown = makeType('typeId', 99999);
        expect(formatType(unknown as never)).toBe('Type(99999)');
    });
});
