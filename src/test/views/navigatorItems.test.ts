import { describe, it, expect } from 'vitest';
import { NavigatorItem, getContextValue, isExpandable } from '../../views/navigatorItems';
import { SchemeEntryType } from '../../models/types';
import { TreeItemCollapsibleState } from 'vscode';

describe('getContextValue', () => {
    const cases: [SchemeEntryType, string][] = [
        [SchemeEntryType.DIRECTORY, 'folder'],
        [SchemeEntryType.TABLE, 'table'],
        [SchemeEntryType.COLUMN_STORE, 'column-store'],
        [SchemeEntryType.COLUMN_TABLE, 'column-store'],
        [SchemeEntryType.PERS_QUEUE_GROUP, 'topic'],
        [SchemeEntryType.TOPIC, 'topic'],
        [SchemeEntryType.EXTERNAL_DATA_SOURCE, 'external-datasource'],
        [SchemeEntryType.EXTERNAL_TABLE, 'external-table'],
        [SchemeEntryType.RESOURCE_POOL, 'resource-pool'],
        [SchemeEntryType.COORDINATION_NODE, 'coordination-node'],
        [SchemeEntryType.VIEW, 'view'],
        [SchemeEntryType.TRANSFER, 'transfer'],
    ];

    for (const [entryType, expected] of cases) {
        it(`maps ${SchemeEntryType[entryType]} to "${expected}"`, () => {
            expect(getContextValue(entryType)).toBe(expected);
        });
    }

    it('maps unknown type to "unknown"', () => {
        expect(getContextValue(999 as SchemeEntryType)).toBe('unknown');
    });
});

describe('isExpandable', () => {
    it('DIRECTORY is expandable', () => {
        expect(isExpandable(SchemeEntryType.DIRECTORY)).toBe(true);
    });

    const nonExpandableTypes = [
        SchemeEntryType.TABLE,
        SchemeEntryType.TOPIC,
        SchemeEntryType.VIEW,
        SchemeEntryType.EXTERNAL_TABLE,
        SchemeEntryType.EXTERNAL_DATA_SOURCE,
        SchemeEntryType.RESOURCE_POOL,
        SchemeEntryType.TRANSFER,
        SchemeEntryType.COORDINATION_NODE,
        SchemeEntryType.COLUMN_STORE,
        SchemeEntryType.COLUMN_TABLE,
    ];

    for (const entryType of nonExpandableTypes) {
        it(`${SchemeEntryType[entryType]} is NOT expandable`, () => {
            expect(isExpandable(entryType)).toBe(false);
        });
    }
});

describe('NavigatorItem', () => {
    it('constructs with basic properties', () => {
        const item = new NavigatorItem(
            'my_table',
            'path/to/my_table',
            SchemeEntryType.TABLE,
            TreeItemCollapsibleState.None,
            'table',
        );
        expect(item.label).toBe('my_table');
        expect(item.fullPath).toBe('path/to/my_table');
        expect(item.entryType).toBe(SchemeEntryType.TABLE);
        expect(item.contextValue).toBe('table');
        expect(item.tooltip).toBe('path/to/my_table');
    });

    it('generates id without rootSection', () => {
        const item = new NavigatorItem(
            'test',
            'test_path',
            SchemeEntryType.TABLE,
            TreeItemCollapsibleState.None,
            'table',
        );
        expect(item.id).toBe('table:test_path');
    });

    it('generates id with rootSection', () => {
        const item = new NavigatorItem(
            'test',
            'test_path',
            SchemeEntryType.TABLE,
            TreeItemCollapsibleState.None,
            'table',
            'root-tables',
        );
        expect(item.id).toBe('root-tables/table:test_path');
    });

    it('has icon set', () => {
        const item = new NavigatorItem(
            'folder',
            'path',
            SchemeEntryType.DIRECTORY,
            TreeItemCollapsibleState.Collapsed,
            'folder',
        );
        expect(item.iconPath).toBeDefined();
    });
});
