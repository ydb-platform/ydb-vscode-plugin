import * as vscode from 'vscode';
import { ConnectionManager } from '../services/connectionManager';
import { ConnectionProfile } from '../models/connectionProfile';
import { AUTH_TYPE_LABELS, getEffectiveEndpoint } from '../models/connectionProfile';

export class ConnectionItem extends vscode.TreeItem {
    constructor(
        public readonly profile: ConnectionProfile,
        public readonly connectionStatus: 'focused' | 'focused-disconnected' | 'connected' | 'disconnected',
    ) {
        super(profile.name, vscode.TreeItemCollapsibleState.None);

        this.description = `${getEffectiveEndpoint(profile)} / ${profile.database}`;

        const statusLabel =
            connectionStatus === 'focused' ? 'Focused' :
            connectionStatus === 'focused-disconnected' ? 'Focused (not connected)' :
            connectionStatus === 'connected' ? 'Connected' :
            'Disconnected';

        this.tooltip = new vscode.MarkdownString([
            `**${profile.name}** — ${statusLabel}`,
            '',
            `Endpoint: \`${getEffectiveEndpoint(profile)}\``,
            `Database: \`${profile.database}\``,
            `Auth: ${AUTH_TYPE_LABELS[profile.authType]}`,
            `TLS: ${profile.secure ? 'Yes' : 'No'}`,
        ].join('\n'));

        this.contextValue = `connection-${connectionStatus}`;

        this.command = {
            command: 'ydb.setFocusedConnection',
            title: 'Set as Focused',
            arguments: [this],
        };

        switch (connectionStatus) {
            case 'focused':
                this.iconPath = new vscode.ThemeIcon('database', new vscode.ThemeColor('charts.green'));
                break;
            case 'focused-disconnected':
                this.iconPath = new vscode.ThemeIcon('database', new vscode.ThemeColor('disabledForeground'));
                break;
            case 'connected':
                this.iconPath = new vscode.ThemeIcon('database', new vscode.ThemeColor('charts.blue'));
                break;
            case 'disconnected':
                this.iconPath = new vscode.ThemeIcon('database', new vscode.ThemeColor('disabledForeground'));
                break;
        }
    }
}

export class ConnectionsProvider implements vscode.TreeDataProvider<ConnectionItem> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<ConnectionItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private readonly connectionManager: ConnectionManager) {
        connectionManager.onDidChangeProfiles(() => this.refresh());
        connectionManager.onDidChangeConnection(() => this.refresh());
        connectionManager.onDidChangeConnectionStatus((_profileId) => this.refresh());
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: ConnectionItem): vscode.TreeItem {
        return element;
    }

    getChildren(): ConnectionItem[] {
        const profiles = this.connectionManager.getProfiles();
        const focusedId = this.connectionManager.getFocusedProfileId();

        return profiles.map(profile => {
            const isConnected = this.connectionManager.isConnected(profile.id);
            let status: 'focused' | 'focused-disconnected' | 'connected' | 'disconnected';
            if (profile.id === focusedId) {
                status = isConnected ? 'focused' : 'focused-disconnected';
            } else if (isConnected) {
                status = 'connected';
            } else {
                status = 'disconnected';
            }
            return new ConnectionItem(profile, status);
        });
    }
}
