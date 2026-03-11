import * as vscode from 'vscode';
import { ConnectionManager } from './services/connectionManager';
import { registerConnectionCommands } from './commands/connectionCommands';
import { registerQueryCommands } from './commands/queryCommands';
import { registerViewCommands } from './commands/viewCommands';
import { registerCreateCommands } from './commands/createCommands';
import { registerDeleteCommands } from './commands/deleteCommands';
import { YdbNavigatorProvider } from './views/navigatorProvider';
import { SessionProvider } from './views/sessionProvider';
import { PermissionsProvider } from './views/permissionsProvider';
import { DashboardProvider } from './views/dashboardProvider';
import { ConnectionsProvider } from './views/connectionsProvider';
import { YqlCompletionProvider } from './completionProvider';
import { makeQueryInWorkspace, registerWorkspaceListeners, saveAllWorkspaceStates } from './views/queryWorkspaceWebview';
import { previewTopic } from './commands/queryCommands';
import { NavigatorItem, getContextValue } from './views/navigatorItems';
import { SchemeEntryType } from './models/types';
import { DetailsProvider } from './views/detailsProvider';
import { SchemeService } from './services/schemeService';
import { McpService } from './services/mcpServer';
import { RagService } from './services/ragService';
import * as path from 'path';

let statusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext): void {
    const connectionManager = ConnectionManager.getInstance();
    connectionManager.initialize(context.globalState);

    // Status bar
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'ydb.switchConnection';
    updateStatusBar(connectionManager);
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    connectionManager.onDidChangeConnection(() => {
        updateStatusBar(connectionManager);
    });

    // Tree views
    const connectionsProvider = new ConnectionsProvider(connectionManager);
    const navigatorProvider = new YdbNavigatorProvider(connectionManager);
    const sessionProvider = new SessionProvider(connectionManager);
    const permissionsProvider = new PermissionsProvider();
    const dashboardProvider = new DashboardProvider(connectionManager);
    const detailsProvider = new DetailsProvider(connectionManager);

    // Double-click detection for table preview
    let lastClickedPath: string | undefined;
    let lastClickTime = 0;
    const DOUBLE_CLICK_THRESHOLD = 500;
    let programmaticReveal = false;

    context.subscriptions.push(
        vscode.commands.registerCommand('ydb.onTableClick', (item: NavigatorItem) => {
            const now = Date.now();
            if (item.fullPath === lastClickedPath && now - lastClickTime < DOUBLE_CLICK_THRESHOLD) {
                if (item.contextValue === 'topic') {
                    previewTopic(connectionManager, item.fullPath);
                } else {
                    makeQueryInWorkspace(connectionManager, item.fullPath);
                }
                lastClickedPath = undefined;
            } else {
                lastClickedPath = item.fullPath;
            }
            lastClickTime = now;
        }),
        vscode.commands.registerCommand('ydb.goToDataSource', async (item: { dataSourcePath?: string }) => {
            if (item?.dataSourcePath) {
                let dsPath = item.dataSourcePath;
                // Strip database prefix to get relative path matching navigator tree
                const db = connectionManager.getFocusedProfile()?.database;
                if (db && dsPath.startsWith(db + '/')) {
                    dsPath = dsPath.slice(db.length + 1);
                }
                const dsName = dsPath.split('/').pop() ?? dsPath;
                const fakeItem = new NavigatorItem(
                    dsName,
                    dsPath,
                    SchemeEntryType.EXTERNAL_DATA_SOURCE,
                    vscode.TreeItemCollapsibleState.None,
                    'external-datasource',
                );
                detailsProvider.navigateTo(fakeItem);
                programmaticReveal = true;
                await navigatorProvider.revealItem(fakeItem);
                programmaticReveal = false;
            }
        }),
        vscode.commands.registerCommand('ydb.detailsBack', async () => {
            const prev = detailsProvider.peekBack();
            detailsProvider.goBack();
            if (prev) {
                programmaticReveal = true;
                await navigatorProvider.revealItem(prev);
                programmaticReveal = false;
            }
        }),
        vscode.commands.registerCommand('ydb.goToReference', async (item: { referencePath?: string }) => {
            if (item?.referencePath) {
                let refPath = item.referencePath;
                const db = connectionManager.getFocusedProfile()?.database;
                if (db && refPath.startsWith(db + '/')) {
                    refPath = refPath.slice(db.length + 1);
                }
                // Strip leading slash if relative
                if (refPath.startsWith('/')) {
                    const dbPrefix = db ? (db.endsWith('/') ? db : db + '/') : '';
                    if (dbPrefix && refPath.startsWith(dbPrefix)) {
                        refPath = refPath.slice(dbPrefix.length);
                    }
                }
                const refName = refPath.split('/').pop() ?? refPath;
                // References from external data sources are typically external tables
                const fakeItem = new NavigatorItem(
                    refName,
                    refPath,
                    SchemeEntryType.EXTERNAL_TABLE,
                    vscode.TreeItemCollapsibleState.None,
                    'external-table',
                );
                detailsProvider.navigateTo(fakeItem);
                programmaticReveal = true;
                await navigatorProvider.revealItem(fakeItem);
                programmaticReveal = false;
            }
        }),
        vscode.commands.registerCommand('ydb.goToTransferTarget', async (item: { transferTargetPath?: string }) => {
            if (item?.transferTargetPath) {
                try {
                    const driver = await connectionManager.getDriver();
                    const schemeService = new SchemeService(driver);
                    const entry = await schemeService.describePath(item.transferTargetPath);

                    // Strip database prefix to get relative path for navigator
                    const db = connectionManager.getFocusedProfile()?.database;
                    let relativePath = item.transferTargetPath;
                    if (db) {
                        const dbPrefix = db.endsWith('/') ? db : db + '/';
                        if (relativePath.startsWith(dbPrefix)) {
                            relativePath = relativePath.slice(dbPrefix.length);
                        }
                    }

                    const name = relativePath.split('/').pop() ?? relativePath;
                    const contextVal = getContextValue(entry.type);
                    const fakeItem = new NavigatorItem(
                        name,
                        relativePath,
                        entry.type,
                        vscode.TreeItemCollapsibleState.None,
                        contextVal,
                    );
                    detailsProvider.navigateTo(fakeItem);
                    programmaticReveal = true;
                    await navigatorProvider.revealItem(fakeItem);
                    programmaticReveal = false;
                } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : String(err);
                    vscode.window.showErrorMessage(`Failed to navigate: ${message}`);
                }
            }
        }),
    );

    const navigatorTreeView = vscode.window.createTreeView('ydbNavigator', { treeDataProvider: navigatorProvider });
    navigatorProvider.attachTreeView(navigatorTreeView);

    navigatorTreeView.onDidChangeSelection(e => {
        if (programmaticReveal) {
            return;
        }
        const selected = e.selection[0] as NavigatorItem | undefined;
        if (selected) {
            detailsProvider.navigateTo(selected);
        } else {
            detailsProvider.setSelectedItem(undefined);
        }
    });

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('ydbConnections', connectionsProvider),
        navigatorTreeView,
        vscode.window.registerTreeDataProvider('ydbDetails', detailsProvider),
        vscode.window.registerTreeDataProvider('sessionManager', sessionProvider),
        vscode.window.registerTreeDataProvider('permissions', permissionsProvider),
        vscode.window.registerTreeDataProvider('ydbDashboard', dashboardProvider),
        vscode.commands.registerCommand('ydb.refreshDashboard', () => dashboardProvider.refresh()),
    );

    // Completion provider (used both for native .yql files and Monaco editor in workspace panel)
    const completionProvider = new YqlCompletionProvider(navigatorProvider, connectionManager);

    // Workspace listeners (editor ↔ results panel binding)
    registerWorkspaceListeners(context, connectionManager, completionProvider);

    // RAG service
    const ragCacheDir = path.join(context.globalStorageUri.fsPath, 'rag');
    const ragService = new RagService(ragCacheDir);

    // Commands
    registerConnectionCommands(context, connectionManager, navigatorProvider, sessionProvider, connectionsProvider, ragService);
    registerQueryCommands(context, connectionManager, navigatorProvider);
    registerViewCommands(context, connectionManager, permissionsProvider);
    registerCreateCommands(context);
    registerDeleteCommands(context, connectionManager, navigatorProvider);

    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider('yql', completionProvider),
    );

    // On connection change: switch navigator to cached tree, refresh others
    // Also manage RAG memory: unload from memory when switching away, enable/disable per profile setting
    let prevFocusedId: string | undefined = connectionManager.getFocusedProfileId();
    connectionManager.onDidChangeConnection((newProfile) => {
        navigatorProvider.switchProfile();
        sessionProvider.refresh();
        dashboardProvider.refresh();
        detailsProvider.clear();

        const prevProfile = prevFocusedId ? connectionManager.getProfiles().find(p => p.id === prevFocusedId) : undefined;
        if (prevProfile && prevProfile.useRag !== false) {
            ragService.unloadFromMemory();
        }
        prevFocusedId = newProfile?.id;
        if (newProfile && newProfile.useRag !== false) {
            ragService.enable();
        } else {
            ragService.disable();
        }
    });

    // On connect/disconnect: refresh navigator and dependent views
    connectionManager.onDidChangeConnectionStatus((profileId) => {
        navigatorProvider.refresh(profileId);
        sessionProvider.refresh();
        dashboardProvider.refresh();
        detailsProvider.clear();
    });

    // Embedded MCP server
    const mcpPort = vscode.workspace.getConfiguration('ydb').get<number>('mcpPort', 3333);
    const mcpService = new McpService(connectionManager, ragService);
    mcpService.start(mcpPort).catch(err => {
        vscode.window.showWarningMessage(`YDB MCP server failed to start: ${err instanceof Error ? err.message : String(err)}`);
    });
    context.subscriptions.push(mcpService);
}

function updateStatusBar(connectionManager: ConnectionManager): void {
    const profile = connectionManager.getActiveProfile();
    if (profile) {
        statusBarItem.text = `$(database) YDB: ${profile.name}`;
        statusBarItem.tooltip = `${profile.endpoint}/${profile.database}`;
    } else {
        statusBarItem.text = '$(database) YDB: No Connection';
        statusBarItem.tooltip = 'Click to select a connection';
    }
}

export async function deactivate(): Promise<void> {
    saveAllWorkspaceStates();
    await ConnectionManager.getInstance().dispose();
}
