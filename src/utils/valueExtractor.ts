import type { Value } from '@ydbjs/api/value';

export function extractValue(value: Value | null | undefined): unknown {
    if (!value) {return null;}

    const v = value.value;
    if (v) {
        switch (v.case) {
            case 'boolValue': return v.value;
            case 'int32Value': return v.value;
            case 'uint32Value': return v.value;
            case 'int64Value': return Number(v.value);
            case 'uint64Value': return Number(v.value);
            case 'floatValue': return v.value;
            case 'doubleValue': return v.value;
            case 'bytesValue': return Buffer.from(v.value).toString('base64');
            case 'textValue': return v.value;
            case 'nullFlagValue': return null;
            case 'nestedValue': return extractValue(v.value);
            case undefined: break;
        }
    }

    if (value.items && value.items.length > 0) {
        return value.items.map(item => extractValue(item));
    }

    if (value.pairs && value.pairs.length > 0) {
        const obj: Record<string, unknown> = {};
        for (const pair of value.pairs) {
            const key = String(extractValue(pair.key));
            obj[key] = extractValue(pair.payload);
        }
        return obj;
    }

    return String(value);
}
