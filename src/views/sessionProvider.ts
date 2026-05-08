import * as vscode from 'vscode';
import { ConnectionManager } from '../services/connectionManager';
import { QueryService } from '../services/queryService';

class SessionItem extends vscode.TreeItem {
    constructor(
        label: string,
        description: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly sessionData?: Record<string, unknown>,
    ) {
        super(label, collapsibleState);
        this.description = description;
        this.contextValue = sessionData ? 'session' : 'session-property';
    }
}

export class SessionProvider implements vscode.TreeDataProvider<SessionItem>, vscode.Disposable {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<SessionItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private hideIdle = false;
    private autoRefreshTimer: ReturnType<typeof setInterval> | undefined;
    private readonly configListener: vscode.Disposable;

    constructor(private connectionManager: ConnectionManager) {
        this.applyAutoRefreshConfig();
        this.configListener = vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('ydb.sessionsRefreshIntervalSeconds')) {
                this.applyAutoRefreshConfig();
            }
        });
    }

    private applyAutoRefreshConfig(): void {
        if (this.autoRefreshTimer !== undefined) {
            clearInterval(this.autoRefreshTimer);
            this.autoRefreshTimer = undefined;
        }
        const seconds = vscode.workspace
            .getConfiguration('ydb')
            .get<number>('sessionsRefreshIntervalSeconds', 10);
        if (seconds > 0) {
            this.autoRefreshTimer = setInterval(() => this.refresh(), seconds * 1000);
        }
    }

    dispose(): void {
        if (this.autoRefreshTimer !== undefined) {
            clearInterval(this.autoRefreshTimer);
            this.autoRefreshTimer = undefined;
        }
        this.configListener.dispose();
        this._onDidChangeTreeData.dispose();
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    toggleHideIdle(): void {
        this.hideIdle = !this.hideIdle;
        this.refresh();
    }

    getTreeItem(element: SessionItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: SessionItem): Promise<SessionItem[]> {
        if (element?.sessionData) {
            return this.getSessionProperties(element.sessionData);
        }

        const profile = this.connectionManager.getActiveProfile();
        if (!profile) {
            return [new SessionItem('No connection', '', vscode.TreeItemCollapsibleState.None)];
        }

        try {
            const driver = await this.connectionManager.getDriver();
            const queryService = new QueryService(driver);
            const result = await queryService.executeQuery(
                'SELECT * FROM `.sys/query_sessions`'
            );

            let sessions = result.rows;

            if (this.hideIdle) {
                sessions = sessions.filter(s => {
                    const state = String(s['State'] ?? s['state'] ?? '');
                    return state.toLowerCase() !== 'idle';
                });
            }

            if (sessions.length === 0) {
                return [new SessionItem(
                    this.hideIdle ? 'No active sessions' : 'No sessions',
                    '',
                    vscode.TreeItemCollapsibleState.None,
                )];
            }

            return sessions.map(session => {
                const sessionId = String(session['SessionId'] ?? session['session_id'] ?? 'unknown');
                const state = String(session['State'] ?? session['state'] ?? '');
                const user = String(session['User'] ?? session['user'] ?? '');

                return new SessionItem(
                    `${sessionId.substring(0, 12)}...`,
                    `${state} | ${user}`,
                    vscode.TreeItemCollapsibleState.Collapsed,
                    session,
                );
            });
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            return [new SessionItem(`Error: ${message}`, '', vscode.TreeItemCollapsibleState.None)];
        }
    }

    private getSessionProperties(data: Record<string, unknown>): SessionItem[] {
        return Object.entries(data).map(([key, value]) => {
            const displayValue = value === null || value === undefined ? 'NULL' : String(value);
            return new SessionItem(key, displayValue, vscode.TreeItemCollapsibleState.None);
        });
    }
}
