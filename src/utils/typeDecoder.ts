export interface TypeNode {
    kind: 'primitive' | 'optional' | 'list' | 'dict' | 'struct' | 'tuple' | 'unknown';
    name?: string;
    item?: TypeNode;
    key?: TypeNode;
    value?: TypeNode;
    members?: Array<{ name: string; type: TypeNode }>;
    elements?: TypeNode[];
}

export function splitTypeArgs(s: string): string[] {
    let depth = 0;
    let parenDepth = 0;
    let start = 0;
    const parts: string[] = [];
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === '<') depth++;
        else if (ch === '>') depth--;
        else if (ch === '(') parenDepth++;
        else if (ch === ')') parenDepth--;
        else if (ch === ',' && depth === 0 && parenDepth === 0) {
            parts.push(s.substring(start, i).trim());
            start = i + 1;
        }
    }
    parts.push(s.substring(start).trim());
    return parts;
}

export function parseType(typeStr: string): TypeNode {
    typeStr = typeStr.trim();
    const idx = typeStr.indexOf('<');
    if (idx === -1) {
        return { kind: 'primitive', name: typeStr.toUpperCase() };
    }
    const outer = typeStr.substring(0, idx).trim().toUpperCase();
    const inner = typeStr.substring(idx + 1, typeStr.length - 1);

    if (outer === 'OPTIONAL') {
        return { kind: 'optional', item: parseType(inner) };
    } else if (outer === 'LIST') {
        return { kind: 'list', item: parseType(inner) };
    } else if (outer === 'DICT') {
        const parts = splitTypeArgs(inner);
        return { kind: 'dict', key: parseType(parts[0]), value: parseType(parts[1]) };
    } else if (outer === 'TUPLE') {
        const parts = splitTypeArgs(inner);
        return { kind: 'tuple', elements: parts.map(parseType) };
    } else if (outer === 'STRUCT') {
        const parts = splitTypeArgs(inner);
        const members = parts.map(p => {
            const colonIdx = p.indexOf(':');
            return {
                name: p.substring(0, colonIdx).trim(),
                type: parseType(p.substring(colonIdx + 1).trim()),
            };
        });
        return { kind: 'struct', members };
    }
    return { kind: 'unknown' };
}

export function isBase64StringType(typeNode: TypeNode): boolean {
    return typeNode.kind === 'primitive' && (typeNode.name === 'STRING' || typeNode.name === 'YSON');
}

export function decodeValueByType(
    value: unknown,
    typeNode: TypeNode,
    decodeFn: (s: string) => string,
): unknown {
    if (value === null || value === undefined) return value;

    switch (typeNode.kind) {
        case 'primitive':
            if (isBase64StringType(typeNode) && typeof value === 'string') {
                return decodeFn(value);
            }
            return value;
        case 'optional': {
            const item = typeNode.item;
            if (!item) return value;
            return decodeValueByType(value, item, decodeFn);
        }
        case 'list': {
            const item = typeNode.item;
            if (Array.isArray(value) && item) {
                return value.map(v => decodeValueByType(v, item, decodeFn));
            }
            return value;
        }
        case 'dict': {
            const keyType = typeNode.key;
            const valType = typeNode.value;
            if (typeof value === 'object' && !Array.isArray(value) && keyType && valType) {
                const result: Record<string, unknown> = {};
                for (const k of Object.keys(value as object)) {
                    const decodedKey = isBase64StringType(keyType) ? decodeFn(k) : k;
                    result[decodedKey] = decodeValueByType(
                        (value as Record<string, unknown>)[k],
                        valType,
                        decodeFn,
                    );
                }
                return result;
            }
            return value;
        }
        case 'struct': {
            const members = typeNode.members;
            if (typeof value === 'object' && !Array.isArray(value) && members) {
                const result: Record<string, unknown> = {};
                for (const m of members) {
                    result[m.name] = decodeValueByType(
                        (value as Record<string, unknown>)[m.name],
                        m.type,
                        decodeFn,
                    );
                }
                return result;
            }
            return value;
        }
        case 'tuple': {
            const elements = typeNode.elements;
            if (Array.isArray(value) && elements) {
                return value.map((v, i) => decodeValueByType(v, elements[i], decodeFn));
            }
            return value;
        }
        default:
            return value;
    }
}
