import * as vscode from 'vscode';
import { ConnectionManager } from '../services/connectionManager.js';
import { SchemeService } from '../services/schemeService.js';
import { QueryService } from '../services/queryService.js';
import { DeleteService } from '../services/deleteService.js';
import { YdbNavigatorProvider } from '../views/navigatorProvider.js';
import { NavigatorItem } from '../views/navigatorItems.js';
import { SchemeEntryType } from '../models/types.js';

export function registerDeleteCommands(
    context: vscode.ExtensionContext,
    connectionManager: ConnectionManager,
    navigatorProvider: YdbNavigatorProvider,
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('ydb.deleteObject', (item?: NavigatorItem) =>
            deleteObject(item, connectionManager, navigatorProvider),
        ),
    );
}

async function deleteObject(
    item: NavigatorItem | undefined,
    connectionManager: ConnectionManager,
    navigatorProvider: YdbNavigatorProvider,
): Promise<void> {
    if (!item) { return; }

    const confirm = await vscode.window.showWarningMessage(
        `Please confirm deletion of ${item.fullPath}`,
        { modal: true },
        'Delete',
    );
    if (confirm !== 'Delete') { return; }

    const shortName = item.fullPath.split('/').pop() ?? item.fullPath;

    try {
        const driver = await connectionManager.getDriver();
        const schemeService = new SchemeService(driver);
        const queryService = new QueryService(driver);
        const deleteService = new DeleteService(schemeService, queryService);

        const entryType = item.entryType === 'root-folder'
            ? SchemeEntryType.DIRECTORY
            : item.entryType as SchemeEntryType;

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Deleting ${shortName}`,
                cancellable: false,
            },
            async (progress) => {
                let prevDeleted = 0;
                await deleteService.deleteRecursive(
                    item.fullPath,
                    entryType,
                    item.contextValue,
                    (p) => {
                        if (p.total <= 1) { return; }
                        const increment = p.total > 0 ? ((p.deleted - prevDeleted) / p.total) * 100 : 0;
                        prevDeleted = p.deleted;
                        const currentName = p.currentPath ? (p.currentPath.split('/').pop() ?? p.currentPath) : '';
                        progress.report({
                            message: `${p.deleted}/${p.total}${currentName ? `: ${currentName}` : ''}`,
                            increment,
                        });
                    },
                );
            },
        );

        vscode.window.showInformationMessage(`Deleted ${item.fullPath}.`);
        navigatorProvider.refresh();
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Failed to delete ${item.fullPath}: ${message}`);
    }
}
