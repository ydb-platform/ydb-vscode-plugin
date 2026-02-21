import { describe, it, expect } from 'vitest';
import { parsePlanRoot, parsePlanNode } from '../../utils/planParser';

describe('parsePlanRoot', () => {
    it('unwraps Plan wrapper', () => {
        const input = {
            Plan: { 'Node Type': 'TableFullScan', Tables: ['my_table'] },
        };
        const result = parsePlanRoot(input);
        expect(result.name).toBe('TableFullScan');
        expect(result.tableName).toBe('my_table');
    });

    it('handles direct plan object', () => {
        const input = { 'Node Type': 'Merge', Tables: ['t1', 't2'] };
        const result = parsePlanRoot(input);
        expect(result.name).toBe('Merge');
        expect(result.tableName).toBe('t1, t2');
    });

    it('does not unwrap Plan if it is an array', () => {
        const input = { Plan: [1, 2, 3], 'Node Type': 'Root' };
        const result = parsePlanRoot(input);
        expect(result.name).toBe('Root');
    });
});

describe('parsePlanNode', () => {
    it('extracts Node Type', () => {
        expect(parsePlanNode({ 'Node Type': 'Filter' }).name).toBe('Filter');
    });

    it('falls back to PlanNodeType', () => {
        expect(parsePlanNode({ 'PlanNodeType': 'Sort' }).name).toBe('Sort');
    });

    it('falls back to name field', () => {
        expect(parsePlanNode({ name: 'Custom' }).name).toBe('Custom');
    });

    it('defaults to Unknown', () => {
        expect(parsePlanNode({}).name).toBe('Unknown');
    });

    it('extracts Tables array', () => {
        const node = parsePlanNode({ 'Node Type': 'Scan', Tables: ['users', 'orders'] });
        expect(node.tableName).toBe('users, orders');
    });

    it('extracts single Table string', () => {
        const node = parsePlanNode({ 'Node Type': 'Scan', Table: 'users' });
        expect(node.tableName).toBe('users');
    });

    it('extracts Operators', () => {
        const node = parsePlanNode({
            'Node Type': 'Stage',
            Operators: [{ Name: 'Filter' }, { Name: 'Map' }],
        });
        expect(node.operators).toBe('Filter, Map');
    });

    it('parses Plans recursively', () => {
        const input = {
            'Node Type': 'Root',
            Plans: [
                { 'Node Type': 'Child1' },
                { 'Node Type': 'Child2', Plans: [{ 'Node Type': 'Grandchild' }] },
            ],
        };
        const node = parsePlanRoot(input);
        expect(node.children).toHaveLength(2);
        expect(node.children[0].name).toBe('Child1');
        expect(node.children[1].children).toHaveLength(1);
        expect(node.children[1].children[0].name).toBe('Grandchild');
    });

    it('flattens Stats into properties with prefix', () => {
        const node = parsePlanNode({
            'Node Type': 'Scan',
            Stats: { TotalTasks: 4, TotalBytes: 1024 },
        });
        expect(node.properties['Stats.TotalTasks']).toBe('4');
        expect(node.properties['Stats.TotalBytes']).toBe('1024');
    });

    it('handles deeply nested plans (5+ levels)', () => {
        let current: Record<string, unknown> = { 'Node Type': 'Leaf' };
        for (let i = 4; i >= 0; i--) {
            current = { 'Node Type': `Level${i}`, Plans: [current] };
        }
        const root = parsePlanRoot(current);
        let node = root;
        for (let i = 0; i < 5; i++) {
            expect(node.name).toBe(`Level${i}`);
            expect(node.children).toHaveLength(1);
            node = node.children[0];
        }
        expect(node.name).toBe('Leaf');
    });

    it('handles empty plan', () => {
        const node = parsePlanRoot({});
        expect(node.name).toBe('Unknown');
        expect(node.children).toHaveLength(0);
    });

    it('serializes object properties as JSON', () => {
        const node = parsePlanNode({
            'Node Type': 'Test',
            SomeObject: { key: 'value' },
        });
        expect(node.properties['SomeObject']).toBe('{"key":"value"}');
    });

    it('extracts operatorDetails with metrics from Operators', () => {
        const node = parsePlanNode({
            'Node Type': 'Source',
            Operators: [
                { Name: 'customers', 'E-Cost': '105144', 'E-Rows': '27098.96907', 'E-Size': '216791.7526', Path: '/jaffle_shop/customers/', Inputs: [] },
            ],
        });
        expect(node.operatorDetails).toBeDefined();
        expect(node.operatorDetails).toHaveLength(1);
        expect(node.operatorDetails![0].name).toBe('customers');
        expect(node.operatorDetails![0].properties['E-Cost']).toBe('105144');
        expect(node.operatorDetails![0].properties['E-Rows']).toBe('27098.96907');
        expect(node.operatorDetails![0].properties['E-Size']).toBe('216791.7526');
        expect(node.operatorDetails![0].properties['Path']).toBe('/jaffle_shop/customers/');
    });

    it('operatorDetails excludes Name and Inputs keys', () => {
        const node = parsePlanNode({
            'Node Type': 'Source',
            Operators: [{ Name: 'op1', Inputs: [], 'E-Cost': '100' }],
        });
        expect(node.operatorDetails![0].properties).not.toHaveProperty('Name');
        expect(node.operatorDetails![0].properties).not.toHaveProperty('Inputs');
        expect(node.operatorDetails![0].properties['E-Cost']).toBe('100');
    });

    it('extracts A-Cpu and A-Rows from profiled plan operators', () => {
        const node = parsePlanNode({
            'Node Type': 'TableFullScan',
            Operators: [{
                Name: 'TableFullScan',
                'A-Cpu': 12500,
                'A-Rows': 50000,
                'E-Cost': '105144',
                'E-Rows': '27098',
                'E-Size': '216791',
            }],
        });
        expect(node.operatorDetails).toHaveLength(1);
        expect(node.operatorDetails![0].properties['A-Cpu']).toBe('12500');
        expect(node.operatorDetails![0].properties['A-Rows']).toBe('50000');
        expect(node.operatorDetails![0].properties['E-Cost']).toBe('105144');
        expect(node.operatorDetails![0].properties['E-Rows']).toBe('27098');
    });

    it('parses real YDB plan with operatorDetails metrics', () => {
        const realPlan = {
            'Plan': {
                'Plans': [{
                    'PlanNodeId': 5,
                    'Plans': [{
                        'PlanNodeId': 4,
                        'Plans': [{
                            'PlanNodeId': 3,
                            'Plans': [{
                                'PlanNodeId': 2,
                                'Plans': [{
                                    'PlanNodeId': 1,
                                    'Operators': [{
                                        'E-Size': '216791.7526',
                                        'Name': 'customers',
                                        'E-Rows': '27098.96907',
                                        'E-Cost': '105144',
                                    }],
                                    'Node Type': 'Source',
                                }],
                                'Node Type': 'Stage',
                            }],
                            'Node Type': 'UnionAll',
                        }],
                        'Node Type': 'Collect',
                    }],
                    'Node Type': 'ResultSet',
                }],
                'Node Type': 'Query',
            },
        };
        const root = parsePlanRoot(realPlan);
        // Traverse to the Source node
        let source = root;
        while (source.children.length > 0) {
            source = source.children[0];
        }
        expect(source.name).toBe('Source');
        expect(source.operatorDetails).toHaveLength(1);
        expect(source.operatorDetails![0].properties['E-Cost']).toBe('105144');
        expect(source.operatorDetails![0].properties['E-Rows']).toBe('27098.96907');
        expect(source.operatorDetails![0].properties['E-Size']).toBe('216791.7526');
    });
});
