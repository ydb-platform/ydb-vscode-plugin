import { PlanNode, PlanOperator } from '../models/types.js';

export function parsePlanRoot(obj: Record<string, unknown>): PlanNode {
    if (obj['Plan'] && typeof obj['Plan'] === 'object' && !Array.isArray(obj['Plan'])) {
        return parsePlanNode(obj['Plan'] as Record<string, unknown>);
    }
    return parsePlanNode(obj);
}

export function parsePlanNode(obj: Record<string, unknown>): PlanNode {
    const name = (obj['Node Type'] as string)
        ?? (obj['PlanNodeType'] as string)
        ?? (obj['name'] as string)
        ?? 'Unknown';

    let tableName: string | undefined;
    if (Array.isArray(obj['Tables'])) {
        tableName = (obj['Tables'] as string[]).join(', ');
    } else if (typeof obj['Table'] === 'string') {
        tableName = obj['Table'] as string;
    }

    let operators: string | undefined;
    let operatorDetails: PlanOperator[] | undefined;
    if (Array.isArray(obj['Operators'])) {
        const ops = obj['Operators'] as Record<string, unknown>[];
        const opNames = ops.map(op => op['Name'] as string).filter(Boolean);
        if (opNames.length > 0) {
            operators = opNames.join(', ');
        }
        operatorDetails = ops.map(op => {
            const opProps: Record<string, string> = {};
            for (const [k, v] of Object.entries(op)) {
                if (k === 'Name' || k === 'Inputs') { continue; }
                opProps[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
            }
            return { name: (op['Name'] as string) ?? 'Unknown', properties: opProps };
        });
    }

    const children: PlanNode[] = [];
    const properties: Record<string, string> = {};

    for (const [key, value] of Object.entries(obj)) {
        if (key === 'Plans' && Array.isArray(value)) {
            for (const child of value) {
                children.push(parsePlanNode(child as Record<string, unknown>));
            }
        } else if (key === 'Operators') {
            continue;
        } else if (key === 'Stats' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
            for (const [sk, sv] of Object.entries(value as Record<string, unknown>)) {
                properties[`Stats.${sk}`] = typeof sv === 'object' ? JSON.stringify(sv) : String(sv);
            }
        } else {
            properties[key] = typeof value === 'object' ? JSON.stringify(value) : String(value);
        }
    }

    return { name, tableName, operators, operatorDetails, properties, children };
}
