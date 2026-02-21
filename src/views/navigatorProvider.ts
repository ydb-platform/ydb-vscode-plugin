import * as vscode from 'vscode';
import { ConnectionManager } from '../services/connectionManager';
import { SchemeService } from '../services/schemeService';
import { QueryService } from '../services/queryService';
import { SchemeEntryType } from '../models/types';
import { NavigatorItem, getContextValue, isExpandable } from './navigatorItems';

interface RootFolder {
    label: string;
    contextValue: string;
    path: string;
    filter?: (type: SchemeEntryType) => boolean;
    isSystem?: boolean;
    isStreamingQueries?: boolean;
    isResourcePools?: boolean;
}

const HIDDEN_PATHS = ['.metadata', '.tmp'];
const ALLOWED_SYSTEM_VIEWS = ['query_sessions', 'top_queries_by_duration_one_minute', 'top_queries_by_duration_one_hour'];

const ROOT_CACHE_KEY = '__root__';

let emptyPlaceholderCounter = 0;

function makeEmptyPlaceholder(): NavigatorItem {
    const item = new NavigatorItem(
        '<empty>',
        `__empty_${emptyPlaceholderCounter++}`,
        'root-folder',
        vscode.TreeItemCollapsibleState.None,
        'empty-placeholder',
    );
    item.iconPath = undefined;
    item.tooltip = undefined;
    return item;
}

export class YdbNavigatorProvider implements vscode.TreeDataProvider<NavigatorItem> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<NavigatorItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private cachedTableNames: string[] = [];

    // Per-profile cache: profileId → (parentKey → children)
    private childrenCache: Map<string, Map<string, NavigatorItem[]>> = new Map();
    private tableNamesCache: Map<string, string[]> = new Map();

    // Per-profile expanded state: profileId → Set of expanded item IDs
    private expandedState: Map<string, Set<string>> = new Map();

    // child itemId → parent NavigatorItem (for getParent / reveal support)
    private parentMap: Map<string, NavigatorItem> = new Map();

    private treeView: vscode.TreeView<NavigatorItem> | undefined;

    constructor(private connectionManager: ConnectionManager) {}

    /** Attach to a TreeView to track expand/collapse events */
    attachTreeView(treeView: vscode.TreeView<NavigatorItem>): void {
        this.treeView = treeView;
        treeView.onDidExpandElement(e => {
            const profileId = this.connectionManager.getFocusedProfileId();
            if (profileId && e.element.id) {
                if (!this.expandedState.has(profileId)) {
                    this.expandedState.set(profileId, new Set());
                }
                this.expandedState.get(profileId)!.add(e.element.id);
            }
        });
        treeView.onDidCollapseElement(e => {
            const profileId = this.connectionManager.getFocusedProfileId();
            if (profileId && e.element.id) {
                this.expandedState.get(profileId)?.delete(e.element.id);
            }
        });
    }

    /** Clear cache for given (or current) profile and reload from server */
    refresh(profileId?: string): void {
        const id = profileId ?? this.connectionManager.getFocusedProfileId();
        if (id) {
            this.childrenCache.delete(id);
            this.tableNamesCache.delete(id);
            this.expandedState.delete(id);
        }
        this.cachedTableNames = [];
        this.parentMap.clear();
        this._onDidChangeTreeData.fire();
    }

    /** Switch to another profile — use cached data if available */
    switchProfile(): void {
        // Save current table names
        const oldProfileId = this.connectionManager.getFocusedProfileId();
        // Note: focusedProfileId is already updated by the time this is called,
        // but table names were built for the previous view, so we just fire refresh
        this.cachedTableNames = [];
        this._onDidChangeTreeData.fire();
    }

    getTableNames(): string[] {
        return this.cachedTableNames;
    }

    /** Load table names from server if cache is empty. Used by completion provider. */
    async ensureTableNamesLoaded(): Promise<string[]> {
        if (this.cachedTableNames.length > 0) {
            return this.cachedTableNames;
        }
        const profile = this.connectionManager.getActiveProfile();
        if (!profile) {
            return [];
        }
        try {
            const driver = await this.connectionManager.getDriver();
            const schemeService = new SchemeService(driver);
            await this.loadTableNamesRecursive(schemeService, '');
            const profileId = profile.id;
            this.tableNamesCache.set(profileId, [...this.cachedTableNames]);
        } catch {
            // Graceful degradation — return whatever we have
        }
        return this.cachedTableNames;
    }

    private async loadTableNamesRecursive(schemeService: SchemeService, path: string, depth = 0): Promise<void> {
        if (depth > 5) { return; } // Limit recursion depth
        try {
            const entries = await schemeService.listDirectory(path);
            for (const entry of entries) {
                if (HIDDEN_PATHS.includes(entry.name) || entry.name.startsWith('.')) {
                    continue;
                }
                const fullPath = path ? `${path}/${entry.name}` : entry.name;
                if (entry.type === SchemeEntryType.TABLE ||
                    entry.type === SchemeEntryType.COLUMN_TABLE ||
                    entry.type === SchemeEntryType.COLUMN_STORE ||
                    entry.type === SchemeEntryType.VIEW ||
                    entry.type === SchemeEntryType.EXTERNAL_TABLE ||
                    entry.type === SchemeEntryType.TOPIC) {
                    this.cachedTableNames.push(fullPath);
                } else if (entry.type === SchemeEntryType.DIRECTORY) {
                    await this.loadTableNamesRecursive(schemeService, fullPath, depth + 1);
                }
            }
        } catch {
            // skip inaccessible directories
        }
    }

    getParent(element: NavigatorItem): NavigatorItem | undefined {
        if (!element.id) {
            return undefined;
        }
        return this.parentMap.get(element.id);
    }

    async revealItem(item: NavigatorItem): Promise<void> {
        if (!this.treeView) {
            return;
        }
        const profileId = this.connectionManager.getFocusedProfileId();
        if (!profileId) {
            return;
        }

        // First, try to find the item in existing cache
        const cache = this.childrenCache.get(profileId);
        if (cache) {
            for (const children of cache.values()) {
                const found = children.find(c => c.fullPath === item.fullPath && c.contextValue === item.contextValue);
                if (found) {
                    try {
                        await this.treeView.reveal(found, { select: true, focus: false });
                    } catch {
                        // item may not be visible yet
                    }
                    return;
                }
            }
        }

        // Item not in cache — walk down from the matching root folder,
        // loading children at each level to find the target item.
        const rootSectionMap: Record<string, string> = {
            'table': 'root-tables',
            'column-store': 'root-tables',
            'external-datasource': 'root-external-datasources',
            'external-table': 'root-external-tables',
            'topic': 'root-topics',
            'view': 'root-views',
            'transfer': 'root-transfers',
        };
        const rootSection = rootSectionMap[item.contextValue];
        if (!rootSection) {
            return;
        }

        // Ensure root folders are loaded
        const roots = await this.getChildren(undefined);
        const rootItem = roots.find(r => r.contextValue === rootSection);
        if (!rootItem) {
            return;
        }

        // Walk down the path segments
        const targetPath = item.fullPath;
        const rootPath = rootItem.fullPath; // e.g. '' or '.sys'
        let relativePath = targetPath;
        if (rootPath && targetPath.startsWith(rootPath + '/')) {
            relativePath = targetPath.slice(rootPath.length + 1);
        }
        const segments = relativePath.split('/');

        let current: NavigatorItem = rootItem;
        for (let i = 0; i < segments.length; i++) {
            const children = await this.getChildren(current);
            const isLast = i === segments.length - 1;
            const partialPath = rootPath
                ? rootPath + '/' + segments.slice(0, i + 1).join('/')
                : segments.slice(0, i + 1).join('/');

            if (isLast) {
                const found = children.find(c => c.fullPath === targetPath && c.contextValue === item.contextValue);
                if (found) {
                    try {
                        await this.treeView.reveal(found, { select: true, focus: false });
                    } catch {
                        // item may not be visible yet
                    }
                }
            } else {
                const folder = children.find(c => c.fullPath === partialPath && c.contextValue === 'folder');
                if (!folder) {
                    return; // path segment not found
                }
                current = folder;
            }
        }
    }

    getTreeItem(element: NavigatorItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: NavigatorItem): Promise<NavigatorItem[]> {
        const profile = this.connectionManager.getActiveProfile();
        if (!profile) {
            return [new NavigatorItem(
                'No connection. Click to add.',
                '',
                'root-folder',
                vscode.TreeItemCollapsibleState.None,
                'no-connection',
            )];
        }

        const profileId = profile.id;

        // Show root folders only after successful connection
        if (!element && !this.connectionManager.isConnected(profileId)) {
            return [new NavigatorItem(
                'Not connected. Right-click to connect.',
                '',
                'root-folder',
                vscode.TreeItemCollapsibleState.None,
                'not-connected',
            )];
        }

        const parentKey = element ? (element.id ?? element.fullPath) : ROOT_CACHE_KEY;

        // Check cache
        const profileCache = this.childrenCache.get(profileId);
        if (profileCache?.has(parentKey)) {
            // Restore table names from cache
            if (!element) {
                this.cachedTableNames = this.tableNamesCache.get(profileId) ?? [];
            }
            const cached = profileCache.get(parentKey)!;
            // Restore expanded/collapsed state from tracked state
            const expanded = this.expandedState.get(profileId);
            for (const item of cached) {
                if (item.collapsibleState !== vscode.TreeItemCollapsibleState.None) {
                    item.collapsibleState = expanded?.has(item.id!)
                        ? vscode.TreeItemCollapsibleState.Expanded
                        : vscode.TreeItemCollapsibleState.Collapsed;
                }
            }
            return cached;
        }

        try {
            let items: NavigatorItem[];
            if (!element) {
                items = this.getRootFolders(profile.database);
            } else if ((element as NavigatorItem & { isStreamingQueries?: boolean }).isStreamingQueries) {
                items = await this.getStreamingQueryEntries(profile.database);
            } else if ((element as NavigatorItem & { isResourcePools?: boolean }).isResourcePools) {
                items = await this.getResourcePoolEntries();
            } else {
                const driver = await this.connectionManager.getDriver();
                const schemeService = new SchemeService(driver);
                items = await this.getChildEntries(schemeService, element);
            }

            // Show placeholder when an expandable node has no children
            if (element && items.length === 0) {
                items = [makeEmptyPlaceholder()];
            }

            // Store in cache
            if (!this.childrenCache.has(profileId)) {
                this.childrenCache.set(profileId, new Map());
            }
            this.childrenCache.get(profileId)!.set(parentKey, items);

            // Track parent for each child (needed for getParent / reveal)
            if (element) {
                for (const child of items) {
                    if (child.id) {
                        this.parentMap.set(child.id, element);
                    }
                }
            }

            // Cache table names snapshot
            this.tableNamesCache.set(profileId, [...this.cachedTableNames]);

            return items;
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Navigator error: ${message}`);
            return [];
        }
    }

    private getRootFolders(_database: string): NavigatorItem[] {
        // SchemeService prepends the database path for relative paths,
        // so we use relative paths here (empty string = database root)
        const roots: RootFolder[] = [
            {
                label: 'Tables',
                contextValue: 'root-tables',
                path: '',
                filter: (t) => t === SchemeEntryType.TABLE || t === SchemeEntryType.COLUMN_TABLE ||
                               t === SchemeEntryType.COLUMN_STORE || t === SchemeEntryType.DIRECTORY,
            },
            {
                label: 'System Views',
                contextValue: 'root-system-views',
                path: '.sys',
                isSystem: true,
            },
            {
                label: 'Views',
                contextValue: 'root-views',
                path: '',
                filter: (t) => t === SchemeEntryType.VIEW || t === SchemeEntryType.DIRECTORY,
            },
            {
                label: 'Topics',
                contextValue: 'root-topics',
                path: '',
                filter: (t) => t === SchemeEntryType.TOPIC || t === SchemeEntryType.PERS_QUEUE_GROUP ||
                               t === SchemeEntryType.DIRECTORY,
            },
            {
                label: 'External Data Sources',
                contextValue: 'root-external-datasources',
                path: '',
                filter: (t) => t === SchemeEntryType.EXTERNAL_DATA_SOURCE || t === SchemeEntryType.DIRECTORY,
            },
            {
                label: 'External Tables',
                contextValue: 'root-external-tables',
                path: '',
                filter: (t) => t === SchemeEntryType.EXTERNAL_TABLE || t === SchemeEntryType.DIRECTORY,
            },
            {
                label: 'Resource Pools',
                contextValue: 'root-resource-pools',
                path: '',
                isResourcePools: true,
            },
            {
                label: 'Transfers',
                contextValue: 'root-transfers',
                path: '',
                filter: (t) => t === SchemeEntryType.TRANSFER || t === SchemeEntryType.DIRECTORY,
            },
            {
                label: 'Streaming Queries',
                contextValue: 'root-streaming-queries',
                path: '',
                isStreamingQueries: true,
            },
        ];

        const profileId = this.connectionManager.getFocusedProfileId();
        const expanded = profileId ? this.expandedState.get(profileId) : undefined;

        return roots.map(r => {
            const itemId = `${r.contextValue}:${r.path}`;
            const state = expanded?.has(itemId)
                ? vscode.TreeItemCollapsibleState.Expanded
                : vscode.TreeItemCollapsibleState.Collapsed;
            const item = new NavigatorItem(
                r.label,
                r.path,
                'root-folder',
                state,
                r.contextValue,
            );
            const ext = item as NavigatorItem & { rootFilter?: (t: SchemeEntryType) => boolean; isSystemRoot?: boolean; isStreamingQueries?: boolean; isResourcePools?: boolean; rootSection?: string };
            ext.rootFilter = r.filter;
            ext.isSystemRoot = r.isSystem;
            ext.isStreamingQueries = r.isStreamingQueries;
            ext.isResourcePools = r.isResourcePools;
            ext.rootSection = r.contextValue;
            return item;
        });
    }

    private async hasMatchingChildrenRecursive(
        schemeService: SchemeService,
        path: string,
        filter: (type: SchemeEntryType) => boolean,
    ): Promise<boolean> {
        let entries;
        try {
            entries = await schemeService.listDirectory(path);
        } catch {
            return false;
        }
        for (const entry of entries) {
            if (entry.type !== SchemeEntryType.DIRECTORY && filter(entry.type)) {
                return true;
            }
            if (entry.type === SchemeEntryType.DIRECTORY && !entry.name.startsWith('.')) {
                const childPath = path ? `${path}/${entry.name}` : entry.name;
                if (await this.hasMatchingChildrenRecursive(schemeService, childPath, filter)) {
                    return true;
                }
            }
        }
        return false;
    }

    private async getStreamingQueryEntries(database: string): Promise<NavigatorItem[]> {
        try {
            const driver = await this.connectionManager.getDriver();
            const queryService = new QueryService(driver);
            const queries = await queryService.loadStreamingQueries(database);

            if (queries.length === 0) {
                return [];
            }

            const rootSection = 'root-streaming-queries';
            const items: NavigatorItem[] = [];
            const folders: Map<string, NavigatorItem> = new Map();

            const getOrCreateFolder = (pathParts: string[]): NavigatorItem => {
                const key = pathParts.join('/');
                let folder = folders.get(key);
                if (folder) {
                    return folder;
                }
                folder = new NavigatorItem(
                    pathParts[pathParts.length - 1],
                    key,
                    SchemeEntryType.DIRECTORY,
                    vscode.TreeItemCollapsibleState.Collapsed,
                    'folder',
                    rootSection,
                );
                folders.set(key, folder);
                return folder;
            };

            // Build flat list — folders handled by navigator cache
            for (const query of queries) {
                const parts = query.fullPath.split('/');
                const name = parts[parts.length - 1];
                const contextVal = query.status === 'RUNNING' ? 'streaming-query-running' : 'streaming-query-stopped';
                const item = new NavigatorItem(
                    name,
                    query.fullPath,
                    SchemeEntryType.TOPIC,
                    vscode.TreeItemCollapsibleState.None,
                    contextVal,
                    rootSection,
                );
                item.description = query.status;
                item.iconPath = query.status === 'RUNNING'
                    ? new vscode.ThemeIcon('play-circle')
                    : new vscode.ThemeIcon('debug-stop');

                if (parts.length === 1) {
                    items.push(item);
                } else {
                    // For simplicity, show flat list under streaming queries root
                    item.description = `${query.fullPath} — ${query.status}`;
                    items.push(item);
                }
            }

            return items;
        } catch {
            return [];
        }
    }

    private async getResourcePoolEntries(): Promise<NavigatorItem[]> {
        try {
            const driver = await this.connectionManager.getDriver();
            const queryService = new QueryService(driver);
            const pools = await queryService.loadResourcePools();

            return pools.map(pool => {
                const item = new NavigatorItem(
                    pool.name,
                    pool.name,
                    SchemeEntryType.RESOURCE_POOL,
                    vscode.TreeItemCollapsibleState.None,
                    'resource-pool',
                    'root-resource-pools',
                );
                const limits: string[] = [];
                if (pool.concurrentQueryLimit !== -1) { limits.push(`queries: ${pool.concurrentQueryLimit}`); }
                if (pool.queueSize !== -1) { limits.push(`queue: ${pool.queueSize}`); }
                if (pool.totalCpuLimitPercentPerNode !== -1) { limits.push(`cpu: ${pool.totalCpuLimitPercentPerNode}%`); }
                item.description = limits.length > 0 ? limits.join(', ') : undefined;
                item.tooltip = [
                    `Name: ${pool.name}`,
                    `ConcurrentQueryLimit: ${pool.concurrentQueryLimit}`,
                    `QueueSize: ${pool.queueSize}`,
                    `DatabaseLoadCpuThreshold: ${pool.databaseLoadCpuThreshold}`,
                    `ResourceWeight: ${pool.resourceWeight}`,
                    `TotalCpuLimitPercentPerNode: ${pool.totalCpuLimitPercentPerNode}`,
                    `QueryCpuLimitPercentPerNode: ${pool.queryCpuLimitPercentPerNode}`,
                    `QueryMemoryLimitPercentPerNode: ${pool.queryMemoryLimitPercentPerNode}`,
                ].join('\n');
                return item;
            });
        } catch {
            return [];
        }
    }

    private async getChildEntries(schemeService: SchemeService, parent: NavigatorItem): Promise<NavigatorItem[]> {
        const parentAny = parent as NavigatorItem & { rootFilter?: (t: SchemeEntryType) => boolean; isSystemRoot?: boolean; rootSection?: string };
        const rootSection = parentAny.rootSection;
        const profileId = this.connectionManager.getFocusedProfileId();
        const expanded = profileId ? this.expandedState.get(profileId) : undefined;
        let entries;
        try {
            entries = await schemeService.listDirectory(parent.fullPath);
        } catch (err: unknown) {
            // System paths like .sys or .metadata may not exist — silently return empty
            if (parentAny.isSystemRoot) {
                return [];
            }
            const message = err instanceof Error ? err.message : String(err);
            console.error(`SchemeError listing path "${parent.fullPath}":`, message);
            // Try describePath to check if path exists at all
            try {
                const desc = await schemeService.describePath(parent.fullPath);
                console.log(`describePath "${parent.fullPath}" OK: type=${desc.type}, name=${desc.name}`);
            } catch (descErr: unknown) {
                console.error(`describePath "${parent.fullPath}" also failed:`, descErr instanceof Error ? descErr.message : String(descErr));
            }
            throw err;
        }
        const items: NavigatorItem[] = [];

        for (const entry of entries) {
            // Hide system paths at root level
            if (!parentAny.isSystemRoot && HIDDEN_PATHS.includes(entry.name)) {
                continue;
            }
            // Only show allowed system views
            if (parent.contextValue === 'root-system-views' && !ALLOWED_SYSTEM_VIEWS.includes(entry.name)) {
                continue;
            }
            // Skip .sys from regular Tables listing — it's shown separately
            if (parent.contextValue === 'root-tables' && entry.name === '.sys') {
                continue;
            }

            // Apply root-level type filter
            if (parentAny.rootFilter && !parentAny.rootFilter(entry.type)) {
                continue;
            }

            const fullPath = parent.fullPath ? `${parent.fullPath}/${entry.name}` : entry.name;

            // Skip directories that have no matching children for the current section filter
            if (parentAny.rootFilter && entry.type === SchemeEntryType.DIRECTORY) {
                if (entry.name.startsWith('.')) {
                    continue;
                }
                const leafFilter = (t: SchemeEntryType) => t !== SchemeEntryType.DIRECTORY && parentAny.rootFilter!(t);
                if (!await this.hasMatchingChildrenRecursive(schemeService, fullPath, leafFilter)) {
                    continue;
                }
            }

            const contextVal = parent.contextValue === 'root-system-views' ? 'system-view' : getContextValue(entry.type);
            const expandable = isExpandable(entry.type);

            const itemId = rootSection
                ? `${rootSection}/${contextVal}:${fullPath}`
                : `${contextVal}:${fullPath}`;
            const collapseState = expandable
                ? (expanded?.has(itemId) ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed)
                : vscode.TreeItemCollapsibleState.None;
            const item = new NavigatorItem(
                entry.name,
                fullPath,
                entry.type,
                collapseState,
                contextVal,
                rootSection,
            );

            // Open system view contents on click
            if (contextVal === 'system-view') {
                item.command = {
                    command: 'ydb.selectSystemView',
                    title: 'Select System View',
                    arguments: [item],
                };
            }

            // Propagate filter and rootSection for subdirectories
            if (expandable) {
                const itemExt = item as NavigatorItem & { rootFilter?: (t: SchemeEntryType) => boolean; rootSection?: string };
                if (parentAny.rootFilter) {
                    itemExt.rootFilter = parentAny.rootFilter;
                }
                itemExt.rootSection = rootSection;
            }

            if (contextVal === 'table' || contextVal === 'column-store' || contextVal === 'view' || contextVal === 'external-table' || contextVal === 'topic') {
                item.command = {
                    command: 'ydb.onTableClick',
                    title: 'Preview Table',
                    arguments: [item],
                };
                this.cachedTableNames.push(fullPath);
            }

            items.push(item);
        }

        return items.sort((a, b) => {
            // Folders first
            if (a.contextValue === 'folder' && b.contextValue !== 'folder') {return -1;}
            if (a.contextValue !== 'folder' && b.contextValue === 'folder') {return 1;}
            return a.label.localeCompare(b.label);
        });
    }
}
