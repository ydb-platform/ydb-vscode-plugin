import * as vscode from 'vscode';
import { ConnectionManager } from '../services/connectionManager';
import { CancellationError } from '../services/queryService';
import { YdbNavigatorProvider } from '../views/navigatorProvider';
import { SessionProvider } from '../views/sessionProvider';
import { ConnectionsProvider, ConnectionItem } from '../views/connectionsProvider';
import { showConnectionForm } from '../views/connectionFormWebview';
import { RagService } from '../services/ragService';

const DOUBLE_CLICK_DELAY_MS = 400;
let _lastClickedProfileId: string | undefined;
let _lastClickTime = 0;

export function _resetDoubleClickState(): void {
    _lastClickedProfileId = undefined;
    _lastClickTime = 0;
}

export function registerConnectionCommands(
    context: vscode.ExtensionContext,
    connectionManager: ConnectionManager,
    navigatorProvider: YdbNavigatorProvider,
    sessionProvider: SessionProvider,
    connectionsProvider: ConnectionsProvider,
    ragService?: RagService,
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('ydb.addConnection', () => addConnection(connectionManager, ragService)),
        vscode.commands.registerCommand('ydb.removeConnection', () => removeConnection(connectionManager)),
        vscode.commands.registerCommand('ydb.switchConnection', () => switchConnection(connectionManager)),
        vscode.commands.registerCommand('ydb.testConnection', () => testConnectionCommand(connectionManager)),
        vscode.commands.registerCommand('ydb.refreshNavigator', () => navigatorProvider.refresh()),
        vscode.commands.registerCommand('ydb.refreshSessions', () => sessionProvider.refresh()),

        // New connection management commands
        vscode.commands.registerCommand('ydb.connectProfile', (item?: ConnectionItem) => connectProfile(connectionManager, item)),
        vscode.commands.registerCommand('ydb.disconnectProfile', (item?: ConnectionItem) => disconnectProfile(connectionManager, item)),
        vscode.commands.registerCommand('ydb.editConnection', (item?: ConnectionItem) => editConnection(connectionManager, item, ragService)),
        vscode.commands.registerCommand('ydb.deleteConnection', (item?: ConnectionItem) => deleteConnection(connectionManager, item)),
        vscode.commands.registerCommand('ydb.setFocusedConnection', (item?: ConnectionItem) => setFocusedConnection(connectionManager, item)),
        vscode.commands.registerCommand('ydb.refreshConnections', () => connectionsProvider.refresh()),
    );
}

function addConnection(connectionManager: ConnectionManager, ragService?: RagService): void {
    showConnectionForm(connectionManager, undefined, ragService);
}

async function removeConnection(connectionManager: ConnectionManager): Promise<void> {
    const profiles = connectionManager.getProfiles();
    if (profiles.length === 0) {
        vscode.window.showInformationMessage('No connections to remove.');
        return;
    }

    const pick = await vscode.window.showQuickPick(
        profiles.map(p => ({ label: p.name, description: `${p.endpoint}/${p.database}`, id: p.id })),
        { placeHolder: 'Select connection to remove' },
    );
    if (!pick) {return;}

    await connectionManager.removeProfile(pick.id);
    vscode.window.showInformationMessage(`Connection "${pick.label}" removed.`);
}

async function switchConnection(connectionManager: ConnectionManager): Promise<void> {
    const profiles = connectionManager.getProfiles();
    if (profiles.length === 0) {
        const action = await vscode.window.showInformationMessage(
            'No connections configured.',
            'Add Connection',
        );
        if (action === 'Add Connection') {
            vscode.commands.executeCommand('ydb.addConnection');
        }
        return;
    }

    const activeId = connectionManager.getActiveProfile()?.id;
    const pick = await vscode.window.showQuickPick(
        profiles.map(p => ({
            label: p.name,
            description: `${p.endpoint}/${p.database}`,
            detail: p.id === activeId ? '$(check) Active' : undefined,
            id: p.id,
        })),
        { placeHolder: 'Select active connection' },
    );
    if (!pick) {return;}

    await connectionManager.setActiveProfile(pick.id);
    vscode.window.showInformationMessage(`Switched to "${pick.label}".`);
}

async function testConnectionCommand(connectionManager: ConnectionManager): Promise<void> {
    const profile = connectionManager.getActiveProfile();
    if (!profile) {
        vscode.window.showWarningMessage('No active connection to test.');
        return;
    }

    try {
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Testing connection to ${profile.name}...`, cancellable: true },
            async (_progress, token) => {
                await connectionManager.testConnection(profile, token);
                vscode.window.showInformationMessage(`Connection to "${profile.name}" successful.`);
            },
        );
    } catch (err: unknown) {
        if (err instanceof CancellationError) { return; }
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Connection to "${profile.name}" failed: ${message}`);
    }
}

async function connectProfile(connectionManager: ConnectionManager, item?: ConnectionItem): Promise<void> {
    if (!item) { return; }

    try {
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Connecting to ${item.profile.name}...`, cancellable: true },
            async (_progress, token) => {
                await connectionManager.connectProfile(item.profile.id, token);
            },
        );
        vscode.window.showInformationMessage(`Connected to "${item.profile.name}".`);
    } catch (err: unknown) {
        if (err instanceof CancellationError) { return; }
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Failed to connect: ${message}`);
    }
}

async function disconnectProfile(connectionManager: ConnectionManager, item?: ConnectionItem): Promise<void> {
    if (!item) { return; }

    await connectionManager.disconnectProfile(item.profile.id);
    vscode.window.showInformationMessage(`Disconnected from "${item.profile.name}".`);
}

function editConnection(connectionManager: ConnectionManager, item?: ConnectionItem, ragService?: RagService): void {
    if (!item) { return; }
    showConnectionForm(connectionManager, item.profile, ragService);
}

async function deleteConnection(connectionManager: ConnectionManager, item?: ConnectionItem): Promise<void> {
    if (!item) { return; }

    const confirm = await vscode.window.showWarningMessage(
        `Delete connection "${item.profile.name}"?`,
        { modal: true },
        'Delete',
    );
    if (confirm !== 'Delete') { return; }

    await connectionManager.removeProfile(item.profile.id);
    vscode.window.showInformationMessage(`Connection "${item.profile.name}" deleted.`);
}

async function setFocusedConnection(connectionManager: ConnectionManager, item?: ConnectionItem): Promise<void> {
    if (!item) { return; }

    const now = Date.now();
    const isDoubleClick = item.profile.id === _lastClickedProfileId && (now - _lastClickTime) < DOUBLE_CLICK_DELAY_MS;
    _lastClickedProfileId = item.profile.id;
    _lastClickTime = now;

    if (isDoubleClick && !connectionManager.isConnected(item.profile.id)) {
        await connectProfile(connectionManager, item);
        return;
    }

    try {
        await connectionManager.setFocusedProfile(item.profile.id);
    } catch (err: unknown) {
        if (err instanceof CancellationError) { return; }
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Failed to set focused connection: ${message}`);
    }
}
