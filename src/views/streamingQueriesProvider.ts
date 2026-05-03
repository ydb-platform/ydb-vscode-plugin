import * as vscode from 'vscode';
import { ConnectionManager } from '../services/connectionManager';
import { QueryService } from '../services/queryService';
import { StreamingQuery } from '../models/types';
import { isStreamingQueryErrorStatus, buildStreamingQueryTooltip } from '../utils/streamingQueryStatus';

type TreeNode = StreamingQueryItem | StreamingQueryFolderItem;

export class StreamingQueryItem extends vscode.TreeItem {
    constructor(
        public readonly query: StreamingQuery,
    ) {
        super(query.name, vscode.TreeItemCollapsibleState.None);
        this.description = query.status;
        this.tooltip = buildStreamingQueryTooltip(query);
        const hasError = isStreamingQueryErrorStatus(query.status);
        this.contextValue = hasError
            ? 'streaming-query-error'
            : query.status === 'RUNNING'
                ? 'streaming-query-running'
                : 'streaming-query-stopped';
        if (hasError) {
            this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('problemsErrorIcon.foreground'));
        } else if (query.status === 'RUNNING') {
            this.iconPath = new vscode.ThemeIcon('play-circle');
        } else {
            this.iconPath = new vscode.ThemeIcon('debug-stop');
        }
    }
}

export class StreamingQueryFolderItem extends vscode.TreeItem {
    public readonly children: TreeNode[] = [];

    constructor(
        public readonly folderName: string,
    ) {
        super(folderName, vscode.TreeItemCollapsibleState.Collapsed);
        this.contextValue = 'streaming-query-folder';
        this.iconPath = new vscode.ThemeIcon('folder');
    }
}

export class StreamingQueriesProvider implements vscode.TreeDataProvider<TreeNode> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private rootNodes: TreeNode[] = [];

    constructor(private connectionManager: ConnectionManager) {}

    refresh(): void {
        this.rootNodes = [];
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: TreeNode): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: TreeNode): Promise<TreeNode[]> {
        if (element instanceof StreamingQueryFolderItem) {
            return element.children;
        }

        if (element) {
            return [];
        }

        const profile = this.connectionManager.getActiveProfile();
        if (!profile) {
            return [];
        }

        if (this.rootNodes.length > 0) {
            return this.rootNodes;
        }

        try {
            const driver = await this.connectionManager.getDriver();
            const queryService = new QueryService(driver);
            const queries = await queryService.loadStreamingQueries(profile.database);

            if (queries.length === 0) {
                return [];
            }

            this.rootNodes = this.buildTree(queries);
            return this.rootNodes;
        } catch {
            return [];
        }
    }

    private buildTree(queries: StreamingQuery[]): TreeNode[] {
        const root: Map<string, TreeNode> = new Map();
        const folders: Map<string, StreamingQueryFolderItem> = new Map();

        const getOrCreateFolder = (pathParts: string[]): StreamingQueryFolderItem => {
            const key = pathParts.join('/');
            let folder = folders.get(key);
            if (folder) {
                return folder;
            }

            folder = new StreamingQueryFolderItem(pathParts[pathParts.length - 1]);
            folders.set(key, folder);

            if (pathParts.length === 1) {
                root.set(key, folder);
            } else {
                const parent = getOrCreateFolder(pathParts.slice(0, -1));
                parent.children.push(folder);
            }

            return folder;
        };

        for (const query of queries) {
            const parts = query.fullPath.split('/');
            const item = new StreamingQueryItem(query);

            if (parts.length === 1) {
                root.set(query.fullPath, item);
            } else {
                const parentFolder = getOrCreateFolder(parts.slice(0, -1));
                parentFolder.children.push(item);
            }
        }

        return Array.from(root.values());
    }
}
