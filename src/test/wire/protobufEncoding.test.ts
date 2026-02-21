import { describe, it, expect } from 'vitest';
import { encodeVarint, readProtobufString, readProtobufField } from '../../utils/protobufReader';

/**
 * Helper: encode a string as protobuf field 2, wire type 2 (length-delimited)
 */
function encodeField2String(str: string): Buffer {
    const pathBytes = Buffer.from(str, 'utf-8');
    const tagByte = 0x12; // field 2, wire type 2
    const varintBytes = encodeVarint(pathBytes.length);
    return Buffer.concat([Buffer.from([tagByte]), varintBytes, pathBytes]);
}

describe('protobuf encoding', () => {
    it('encodes DescribeView-like request (path in field 2)', () => {
        const buf = encodeField2String('/mydb/my_view');
        expect(buf).toBeDefined();
        expect(buf.length).toBeGreaterThan(0);

        // Verify we can read back the path
        const decoded = readProtobufString(buf, 2);
        expect(decoded).toBe('/mydb/my_view');
    });

    it('handles empty path', () => {
        const buf = encodeField2String('');
        const decoded = readProtobufString(buf, 2);
        expect(decoded).toBe('');
    });

    it('handles long path (>127 bytes, multi-byte varint)', () => {
        const longPath = '/database/' + 'a'.repeat(200);
        const buf = encodeField2String(longPath);
        const decoded = readProtobufString(buf, 2);
        expect(decoded).toBe(longPath);
    });

    it('handles UTF-8 (cyrillic)', () => {
        const path = '/база/данных/таблица';
        const buf = encodeField2String(path);
        const decoded = readProtobufString(buf, 2);
        expect(decoded).toBe(path);
    });

    it('roundtrip: encode → readProtobufField → string', () => {
        const path = '/mydb/test_table';
        const buf = encodeField2String(path);
        const field = readProtobufField(buf, 2);
        expect(field).toBeDefined();
        expect(field!.toString('utf-8')).toBe(path);
    });
});
