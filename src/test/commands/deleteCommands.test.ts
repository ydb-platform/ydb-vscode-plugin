import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { DeleteService } from '../../services/deleteService';
import { SchemeEntryType } from '../../models/types';
import type { SchemeEntry } from '../../models/types';

const deleteCommandsPath = path.resolve(__dirname, '../../commands/deleteCommands.ts');
const sourceCode = fs.readFileSync(deleteCommandsPath, 'utf-8');

const extensionPath = path.resolve(__dirname, '../../extension.ts');
const extensionSource = fs.readFileSync(extensionPath, 'utf-8');

const packageJsonPath = path.resolve(__dirname, '../../../package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));

// ==================== Source structure ====================

describe('deleteCommands source structure', () => {
    it('registers ydb.deleteObject command', () => {
        expect(sourceCode).toContain("'ydb.deleteObject'");
    });

    it('shows confirmation dialog before deletion', () => {
        expect(sourceCode).toContain('showWarningMessage');
        expect(sourceCode).toContain('modal: true');
    });

    it('calls deleteService.deleteRecursive', () => {
        expect(sourceCode).toContain('deleteRecursive');
    });

    it('refreshes navigator after deletion', () => {
        expect(sourceCode).toContain('navigatorProvider.refresh');
    });

    it('shows error message on failure', () => {
        expect(sourceCode).toContain('showErrorMessage');
    });

    it('shows progress notification', () => {
        expect(sourceCode).toContain('withProgress');
    });
});

// ==================== extension.ts wiring ====================

describe('deleteCommands registration in extension.ts', () => {
    it('imports registerDeleteCommands', () => {
        expect(extensionSource).toContain("import { registerDeleteCommands } from './commands/deleteCommands'");
    });

    it('calls registerDeleteCommands', () => {
        expect(extensionSource).toContain('registerDeleteCommands(context, connectionManager, navigatorProvider)');
    });
});

// ==================== package.json ====================

describe('deleteCommands declared in package.json', () => {
    const commands: Array<{ command: string }> = packageJson.contributes.commands;
    const commandIds = commands.map((c) => c.command);

    it('declares ydb.deleteObject command', () => {
        expect(commandIds).toContain('ydb.deleteObject');
    });
});

describe('deleteCommands context menu entries in package.json', () => {
    const menuItems: Array<{ command: string; when: string }> =
        packageJson.contributes.menus['view/item/context'];

    const deleteEntry = menuItems.find((item) => item.command === 'ydb.deleteObject');

    it('has a context menu entry for ydb.deleteObject', () => {
        expect(deleteEntry).toBeDefined();
    });

    it('is shown in ydbNavigator view', () => {
        expect(deleteEntry?.when).toContain('view == ydbNavigator');
    });

    const deletableTypes = [
        'folder',
        'table',
        'column-store',
        'topic',
        'view',
        'external-table',
        'external-datasource',
        'resource-pool',
        'transfer',
        'coordination-node',
        'streaming-query-running',
        'streaming-query-stopped',
    ];

    for (const type of deletableTypes) {
        it(`context menu condition includes ${type}`, () => {
            expect(deleteEntry?.when).toContain(type);
        });
    }
});

// ==================== DeleteService unit tests ====================

function makeSchemeService(entries: SchemeEntry[] = []) {
    return {
        listDirectory: vi.fn().mockResolvedValue(entries),
        removeDirectory: vi.fn().mockResolvedValue(undefined),
    };
}

function makeQueryService() {
    return {
        executeQuery: vi.fn().mockResolvedValue(undefined),
    };
}

describe('DeleteService.deleteRecursive — leaf objects', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    const cases: Array<{ contextValue: string; type: SchemeEntryType; expectedSql: string }> = [
        { contextValue: 'table', type: SchemeEntryType.TABLE, expectedSql: 'DROP TABLE' },
        { contextValue: 'column-store', type: SchemeEntryType.COLUMN_STORE, expectedSql: 'DROP TABLE' },
        { contextValue: 'topic', type: SchemeEntryType.TOPIC, expectedSql: 'DROP TOPIC' },
        { contextValue: 'view', type: SchemeEntryType.VIEW, expectedSql: 'DROP VIEW' },
        { contextValue: 'external-table', type: SchemeEntryType.EXTERNAL_TABLE, expectedSql: 'DROP EXTERNAL TABLE' },
        { contextValue: 'external-datasource', type: SchemeEntryType.EXTERNAL_DATA_SOURCE, expectedSql: 'DROP EXTERNAL DATA SOURCE' },
        { contextValue: 'transfer', type: SchemeEntryType.TRANSFER, expectedSql: 'DROP TRANSFER' },
        { contextValue: 'coordination-node', type: SchemeEntryType.COORDINATION_NODE, expectedSql: 'DROP COORDINATION NODE' },
        { contextValue: 'streaming-query-running', type: SchemeEntryType.TABLE, expectedSql: 'DROP STREAMING QUERY' },
        { contextValue: 'streaming-query-stopped', type: SchemeEntryType.TABLE, expectedSql: 'DROP STREAMING QUERY' },
    ];

    for (const { contextValue, type, expectedSql } of cases) {
        it(`executes ${expectedSql} for contextValue=${contextValue}`, async () => {
            const schemeService = makeSchemeService();
            const queryService = makeQueryService();
            const svc = new DeleteService(
                schemeService as never,
                queryService as never,
            );

            await svc.deleteRecursive('db/my_object', type, contextValue);

            expect(queryService.executeQuery).toHaveBeenCalledOnce();
            expect(queryService.executeQuery.mock.calls[0][0]).toContain(expectedSql);
        });
    }

    it('calls removeDirectory for folder', async () => {
        const schemeService = makeSchemeService();
        const queryService = makeQueryService();
        const svc = new DeleteService(schemeService as never, queryService as never);

        await svc.deleteRecursive('db/my_folder', SchemeEntryType.DIRECTORY, 'folder');

        expect(schemeService.removeDirectory).toHaveBeenCalledWith('db/my_folder');
        expect(queryService.executeQuery).not.toHaveBeenCalled();
    });

    it('uses resource pool name (not full path) for DROP RESOURCE POOL', async () => {
        const schemeService = makeSchemeService();
        const queryService = makeQueryService();
        const svc = new DeleteService(schemeService as never, queryService as never);

        await svc.deleteRecursive('db/pools/my_pool', SchemeEntryType.RESOURCE_POOL, 'resource-pool');

        expect(queryService.executeQuery).toHaveBeenCalledOnce();
        const sql: string = queryService.executeQuery.mock.calls[0][0];
        expect(sql).toContain('DROP RESOURCE POOL');
        expect(sql).toContain('my_pool');
        expect(sql).not.toContain('db/pools');
    });

    it('quotes path with backticks in DROP statements', async () => {
        const schemeService = makeSchemeService();
        const queryService = makeQueryService();
        const svc = new DeleteService(schemeService as never, queryService as never);

        await svc.deleteRecursive('db/my_table', SchemeEntryType.TABLE, 'table');

        const sql: string = queryService.executeQuery.mock.calls[0][0];
        expect(sql).toContain('`db/my_table`');
    });

    it('throws for unsupported contextValue', async () => {
        const schemeService = makeSchemeService();
        const queryService = makeQueryService();
        const svc = new DeleteService(schemeService as never, queryService as never);

        await expect(
            svc.deleteRecursive('db/obj', SchemeEntryType.TABLE, 'system-view'),
        ).rejects.toThrow('Unsupported entity type');
    });
});

describe('DeleteService.deleteRecursive — folder with children', () => {
    it('deletes children before the parent folder', async () => {
        const children: SchemeEntry[] = [
            { name: 'tbl1', type: SchemeEntryType.TABLE },
            { name: 'tbl2', type: SchemeEntryType.TABLE },
        ];
        const schemeService = makeSchemeService(children);
        const queryService = makeQueryService();
        const svc = new DeleteService(schemeService as never, queryService as never);

        await svc.deleteRecursive('db/folder', SchemeEntryType.DIRECTORY, 'folder');

        // Two DROP TABLE calls, then removeDirectory
        expect(queryService.executeQuery).toHaveBeenCalledTimes(2);
        expect(schemeService.removeDirectory).toHaveBeenCalledWith('db/folder');

        // removeDirectory called after executeQuery calls
        const execOrder = queryService.executeQuery.mock.invocationCallOrder[0];
        const removeOrder = schemeService.removeDirectory.mock.invocationCallOrder[0];
        expect(execOrder).toBeLessThan(removeOrder);
    });

    it('reports progress callbacks', async () => {
        const children: SchemeEntry[] = [
            { name: 'tbl', type: SchemeEntryType.TABLE },
        ];
        const schemeService = makeSchemeService(children);
        const queryService = makeQueryService();
        const svc = new DeleteService(schemeService as never, queryService as never);

        const progress: Array<{ deleted: number; total: number }> = [];
        await svc.deleteRecursive('db/folder', SchemeEntryType.DIRECTORY, 'folder', (p) => {
            progress.push({ deleted: p.deleted, total: p.total });
        });

        expect(progress.length).toBeGreaterThan(0);
        const last = progress[progress.length - 1];
        expect(last.deleted).toBe(last.total);
    });
});
