export function encodeVarint(value: number): Buffer {
    const bytes: number[] = [];
    while (value > 0x7f) {
        bytes.push((value & 0x7f) | 0x80);
        value >>>= 7;
    }
    bytes.push(value & 0x7f);
    return Buffer.from(bytes);
}

export function decodeVarintAt(buf: Buffer, offset: number): { value: number; nextOffset: number } | undefined {
    let value = 0;
    let shift = 0;
    let pos = offset;
    while (pos < buf.length) {
        const byte = buf[pos];
        value |= (byte & 0x7f) << shift;
        pos++;
        if ((byte & 0x80) === 0) {
            return { value: value >>> 0, nextOffset: pos };
        }
        shift += 7;
        if (shift >= 35) {break;}
    }
    return undefined;
}

export function readProtobufField(buf: Buffer, targetField: number): Buffer | undefined {
    let offset = 0;
    while (offset < buf.length) {
        const tag = decodeVarintAt(buf, offset);
        if (tag === undefined) {break;}
        offset = tag.nextOffset;
        const fieldNumber = tag.value >>> 3;
        const wireType = tag.value & 0x07;

        if (wireType === 2) { // length-delimited
            const len = decodeVarintAt(buf, offset);
            if (len === undefined) {break;}
            offset = len.nextOffset;
            if (fieldNumber === targetField) {
                return buf.subarray(offset, offset + len.value);
            }
            offset += len.value;
        } else if (wireType === 0) { // varint
            const val = decodeVarintAt(buf, offset);
            if (val === undefined) {break;}
            offset = val.nextOffset;
        } else if (wireType === 5) { // 32-bit
            offset += 4;
        } else if (wireType === 1) { // 64-bit
            offset += 8;
        } else {
            break;
        }
    }
    return undefined;
}

export function readAllProtobufFields(buf: Buffer, targetField: number): Buffer[] {
    const results: Buffer[] = [];
    let offset = 0;
    while (offset < buf.length) {
        const tag = decodeVarintAt(buf, offset);
        if (tag === undefined) {break;}
        offset = tag.nextOffset;
        const fieldNumber = tag.value >>> 3;
        const wireType = tag.value & 0x07;

        if (wireType === 2) {
            const len = decodeVarintAt(buf, offset);
            if (len === undefined) {break;}
            offset = len.nextOffset;
            if (fieldNumber === targetField) {
                results.push(buf.subarray(offset, offset + len.value));
            }
            offset += len.value;
        } else if (wireType === 0) {
            const val = decodeVarintAt(buf, offset);
            if (val === undefined) {break;}
            offset = val.nextOffset;
        } else if (wireType === 5) {
            offset += 4;
        } else if (wireType === 1) {
            offset += 8;
        } else {
            break;
        }
    }
    return results;
}

export function readProtobufVarint(buf: Buffer, targetField: number): number | undefined {
    let offset = 0;
    while (offset < buf.length) {
        const tag = decodeVarintAt(buf, offset);
        if (tag === undefined) {break;}
        offset = tag.nextOffset;
        const fieldNumber = tag.value >>> 3;
        const wireType = tag.value & 0x07;

        if (wireType === 0) { // varint
            const val = decodeVarintAt(buf, offset);
            if (val === undefined) {break;}
            offset = val.nextOffset;
            if (fieldNumber === targetField) {
                return val.value;
            }
        } else if (wireType === 2) { // length-delimited
            const len = decodeVarintAt(buf, offset);
            if (len === undefined) {break;}
            offset = len.nextOffset + len.value;
        } else if (wireType === 5) {
            offset += 4;
        } else if (wireType === 1) {
            offset += 8;
        } else {
            break;
        }
    }
    return undefined;
}

export function readProtobufString(buf: Buffer, targetField: number): string | undefined {
    const field = readProtobufField(buf, targetField);
    return field ? field.toString('utf-8') : undefined;
}
