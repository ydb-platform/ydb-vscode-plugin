import { Type_PrimitiveTypeId } from '@ydbjs/api/value';
import type { Type } from '@ydbjs/api/value';

export function formatType(type: Type | null | undefined): string {
    if (!type) {return 'Unknown';}

    const t = type.type;
    if (!t) {return 'Unknown';}

    switch (t.case) {
        case 'typeId':
            return Type_PrimitiveTypeId[t.value] ?? `Type(${t.value})`;
        case 'optionalType':
            return `Optional<${formatType(t.value.item)}>`;
        case 'listType':
            return `List<${formatType(t.value.item)}>`;
        case 'dictType':
            return `Dict<${formatType(t.value.key)}, ${formatType(t.value.payload)}>`;
        case 'structType': {
            const fields = (t.value.members ?? []).map(m => `${m.name}: ${formatType(m.type)}`).join(', ');
            return `Struct<${fields}>`;
        }
        case 'tupleType': {
            const elems = (t.value.elements ?? []).map(e => formatType(e)).join(', ');
            return `Tuple<${elems}>`;
        }
        case 'decimalType':
            return `Decimal(${t.value.precision}, ${t.value.scale})`;
        default:
            return 'Unknown';
    }
}
