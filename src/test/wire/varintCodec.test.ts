import { describe, it, expect } from 'vitest';
import { encodeVarint, decodeVarintAt } from '../../utils/protobufReader';

describe('varint codec', () => {
    it('encodes and decodes 0', () => {
        const buf = encodeVarint(0);
        expect(buf).toEqual(Buffer.from([0x00]));
        const decoded = decodeVarintAt(buf, 0);
        expect(decoded).toBeDefined();
        expect(decoded!.value).toBe(0);
    });

    it('encodes and decodes small values (1-127)', () => {
        for (const val of [1, 42, 127]) {
            const buf = encodeVarint(val);
            expect(buf.length).toBe(1);
            const decoded = decodeVarintAt(buf, 0);
            expect(decoded!.value).toBe(val);
        }
    });

    it('roundtrips values 0..300', () => {
        for (let val = 0; val <= 300; val++) {
            const buf = encodeVarint(val);
            const decoded = decodeVarintAt(buf, 0);
            expect(decoded).toBeDefined();
            expect(decoded!.value).toBe(val);
        }
    });

    it('roundtrips powers of 2', () => {
        for (let exp = 0; exp < 28; exp++) {
            const val = 1 << exp;
            const buf = encodeVarint(val);
            const decoded = decodeVarintAt(buf, 0);
            expect(decoded!.value).toBe(val);
        }
    });

    it('handles multi-byte encoding (128+)', () => {
        const buf = encodeVarint(300);
        expect(buf.length).toBe(2); // 300 requires 2 bytes
        const decoded = decodeVarintAt(buf, 0);
        expect(decoded!.value).toBe(300);
    });

    it('returns undefined for empty buffer', () => {
        expect(decodeVarintAt(Buffer.alloc(0), 0)).toBeUndefined();
    });

    it('decodes at offset', () => {
        // Prefix with some bytes, then encode a varint
        const prefix = Buffer.from([0xff, 0xff]);
        const varint = encodeVarint(42);
        const buf = Buffer.concat([prefix, varint]);
        const decoded = decodeVarintAt(buf, 2);
        expect(decoded!.value).toBe(42);
        expect(decoded!.nextOffset).toBe(3);
    });

    it('uses minimum bytes needed', () => {
        expect(encodeVarint(0).length).toBe(1);
        expect(encodeVarint(127).length).toBe(1);
        expect(encodeVarint(128).length).toBe(2);
        expect(encodeVarint(16383).length).toBe(2);
        expect(encodeVarint(16384).length).toBe(3);
    });
});
