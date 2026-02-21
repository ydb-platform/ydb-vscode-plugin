import { describe, it, expect } from 'vitest';
import {
    encodeVarint,
    decodeVarintAt,
    readProtobufField,
    readProtobufVarint,
    readProtobufString,
    readAllProtobufFields,
} from '../../utils/protobufReader';

function buildField(fieldNumber: number, wireType: number, data: Buffer): Buffer {
    const tag = (fieldNumber << 3) | wireType;
    const parts = [encodeVarint(tag)];
    if (wireType === 2) {
        parts.push(encodeVarint(data.length));
    }
    parts.push(data);
    return Buffer.concat(parts);
}

describe('readProtobufField (detailed)', () => {
    it('reads first occurrence of repeated field', () => {
        const msg = Buffer.concat([
            buildField(1, 2, Buffer.from('first')),
            buildField(1, 2, Buffer.from('second')),
        ]);
        const result = readProtobufField(msg, 1);
        expect(result!.toString('utf-8')).toBe('first');
    });

    it('skips varint fields correctly', () => {
        const msg = Buffer.concat([
            buildField(1, 0, encodeVarint(999)),
            buildField(2, 0, encodeVarint(42)),
            buildField(3, 2, Buffer.from('target')),
        ]);
        expect(readProtobufField(msg, 3)!.toString('utf-8')).toBe('target');
    });

    it('handles message with only varint fields', () => {
        const msg = Buffer.concat([
            buildField(1, 0, encodeVarint(1)),
            buildField(2, 0, encodeVarint(2)),
        ]);
        expect(readProtobufField(msg, 3)).toBeUndefined();
    });

    it('handles empty buffer', () => {
        expect(readProtobufField(Buffer.alloc(0), 1)).toBeUndefined();
    });

    it('skips 32-bit fixed fields', () => {
        const fixed32 = Buffer.alloc(4);
        fixed32.writeUInt32LE(12345, 0);
        const msg = Buffer.concat([
            buildField(1, 5, fixed32),
            buildField(2, 2, Buffer.from('after-fixed32')),
        ]);
        expect(readProtobufField(msg, 2)!.toString('utf-8')).toBe('after-fixed32');
    });

    it('skips 64-bit fixed fields', () => {
        const fixed64 = Buffer.alloc(8);
        fixed64.writeDoubleLE(3.14, 0);
        const msg = Buffer.concat([
            buildField(1, 1, fixed64),
            buildField(2, 2, Buffer.from('after-fixed64')),
        ]);
        expect(readProtobufField(msg, 2)!.toString('utf-8')).toBe('after-fixed64');
    });
});

describe('readProtobufVarint (detailed)', () => {
    it('reads varint at various positions', () => {
        const msg = Buffer.concat([
            buildField(1, 0, encodeVarint(100)),
            buildField(2, 0, encodeVarint(200)),
            buildField(3, 0, encodeVarint(300)),
        ]);
        expect(readProtobufVarint(msg, 1)).toBe(100);
        expect(readProtobufVarint(msg, 2)).toBe(200);
        expect(readProtobufVarint(msg, 3)).toBe(300);
    });

    it('returns undefined for string field requested as varint', () => {
        const msg = buildField(1, 2, Buffer.from('not-a-varint'));
        expect(readProtobufVarint(msg, 1)).toBeUndefined();
    });

    it('reads varint value 0', () => {
        const msg = buildField(1, 0, encodeVarint(0));
        expect(readProtobufVarint(msg, 1)).toBe(0);
    });

    it('reads large varint value', () => {
        const msg = buildField(1, 0, encodeVarint(400000));
        expect(readProtobufVarint(msg, 1)).toBe(400000);
    });

    it('skips length-delimited to find varint', () => {
        const msg = Buffer.concat([
            buildField(1, 2, Buffer.from('skip me')),
            buildField(2, 0, encodeVarint(42)),
        ]);
        expect(readProtobufVarint(msg, 2)).toBe(42);
    });
});

describe('readProtobufString (detailed)', () => {
    it('reads UTF-8 string', () => {
        const msg = buildField(1, 2, Buffer.from('hello'));
        expect(readProtobufString(msg, 1)).toBe('hello');
    });

    it('reads empty string', () => {
        const msg = buildField(1, 2, Buffer.from(''));
        expect(readProtobufString(msg, 1)).toBe('');
    });

    it('reads unicode: CJK characters', () => {
        const msg = buildField(1, 2, Buffer.from('你好'));
        expect(readProtobufString(msg, 1)).toBe('你好');
    });

    it('reads unicode: emoji', () => {
        const msg = buildField(1, 2, Buffer.from('🎉'));
        expect(readProtobufString(msg, 1)).toBe('🎉');
    });

    it('reads unicode: cyrillic', () => {
        const msg = buildField(1, 2, Buffer.from('Привет'));
        expect(readProtobufString(msg, 1)).toBe('Привет');
    });

    it('returns undefined for missing field', () => {
        const msg = buildField(1, 2, Buffer.from('data'));
        expect(readProtobufString(msg, 99)).toBeUndefined();
    });

    it('returns undefined on empty buffer', () => {
        expect(readProtobufString(Buffer.alloc(0), 1)).toBeUndefined();
    });
});

describe('readAllProtobufFields (detailed)', () => {
    it('reads multiple repeated fields', () => {
        const msg = Buffer.concat([
            buildField(4, 2, Buffer.from('a')),
            buildField(4, 2, Buffer.from('b')),
            buildField(4, 2, Buffer.from('c')),
        ]);
        const results = readAllProtobufFields(msg, 4);
        expect(results).toHaveLength(3);
        expect(results.map(r => r.toString('utf-8'))).toEqual(['a', 'b', 'c']);
    });

    it('returns empty array when no matches', () => {
        const msg = buildField(1, 2, Buffer.from('wrong'));
        expect(readAllProtobufFields(msg, 99)).toEqual([]);
    });

    it('filters only matching field numbers', () => {
        const msg = Buffer.concat([
            buildField(1, 2, Buffer.from('field1')),
            buildField(4, 2, Buffer.from('match1')),
            buildField(2, 2, Buffer.from('field2')),
            buildField(4, 2, Buffer.from('match2')),
        ]);
        const results = readAllProtobufFields(msg, 4);
        expect(results).toHaveLength(2);
        expect(results[0].toString('utf-8')).toBe('match1');
        expect(results[1].toString('utf-8')).toBe('match2');
    });

    it('handles empty buffer', () => {
        expect(readAllProtobufFields(Buffer.alloc(0), 1)).toEqual([]);
    });
});

describe('encodeVarint/decodeVarintAt edge cases', () => {
    it('encodes max safe uint32', () => {
        const maxU32 = 0xFFFFFFFF >>> 0;
        const buf = encodeVarint(maxU32);
        const decoded = decodeVarintAt(buf, 0);
        expect(decoded).toBeDefined();
        expect(decoded!.value).toBe(maxU32);
    });

    it('decodeVarintAt returns correct nextOffset', () => {
        const buf = encodeVarint(128); // 2 bytes
        const decoded = decodeVarintAt(buf, 0);
        expect(decoded!.nextOffset).toBe(2);
    });

    it('decodeVarintAt handles offset beyond buffer', () => {
        const buf = Buffer.from([0x01]);
        expect(decodeVarintAt(buf, 5)).toBeUndefined();
    });

    it('decodeVarintAt with truncated multi-byte varint', () => {
        // 0x80 indicates continuation but no next byte
        const buf = Buffer.from([0x80]);
        expect(decodeVarintAt(buf, 0)).toBeUndefined();
    });
});
