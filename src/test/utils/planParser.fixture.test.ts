import { describe, it, expect } from 'vitest';
import { parsePlanRoot } from '../../utils/planParser';
import complexPlan from '../fixtures/protobuf/queryPlanComplex.json';

describe('parsePlanRoot with complex fixture', () => {
    it('parses the complex plan fixture', () => {
        const root = parsePlanRoot(complexPlan as Record<string, unknown>);
        expect(root.name).toBe('Query');
        expect(root.children).toHaveLength(1);
    });

    it('has correct nesting structure', () => {
        const root = parsePlanRoot(complexPlan as Record<string, unknown>);
        const resultSet = root.children[0];
        expect(resultSet.name).toBe('ResultSet');

        const limit = resultSet.children[0];
        expect(limit.name).toBe('Limit');
        expect(limit.operators).toBe('Limit');

        const scan = limit.children[0];
        expect(scan.name).toBe('TableFullScan');
        expect(scan.tableName).toBe('users');
        expect(scan.operators).toBe('TableFullScan');
    });

    it('extracts stats from leaf nodes', () => {
        const root = parsePlanRoot(complexPlan as Record<string, unknown>);
        const scan = root.children[0].children[0].children[0];
        expect(scan.properties['Stats.TotalTasks']).toBe('1');
        expect(scan.properties['Stats.TotalBytes']).toBe('2048');
        expect(scan.properties['Stats.TotalRows']).toBe('100');
    });

    it('preserves all plan levels', () => {
        const root = parsePlanRoot(complexPlan as Record<string, unknown>);
        // Root → ResultSet → Limit → TableFullScan (4 levels)
        let node = root;
        const names: string[] = [node.name];
        while (node.children.length > 0) {
            node = node.children[0];
            names.push(node.name);
        }
        expect(names).toEqual(['Query', 'ResultSet', 'Limit', 'TableFullScan']);
    });
});
