import * as vscode from 'vscode';
import { ConnectionManager } from '../services/connectionManager';
import { QueryService } from '../services/queryService';
import { NavigatorItem } from './navigatorItems';
import { SchemeEntryType, TableDescription } from '../models/types';

class DetailItem extends vscode.TreeItem {
    public dataSourcePath?: string;
    public referencePath?: string;
    public transferTargetPath?: string;

    constructor(
        label: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly section?: string,
        public readonly children?: DetailItem[],
    ) {
        super(label, collapsibleState);
    }
}

export class DetailsProvider implements vscode.TreeDataProvider<DetailItem> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<DetailItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private selectedItem: NavigatorItem | undefined;
    private cachedDescription: Map<string, TableDescription> = new Map();
    private currentItems: DetailItem[] = [];
    private loading = false;
    private history: NavigatorItem[] = [];
    private static readonly MAX_HISTORY = 50;

    constructor(private connectionManager: ConnectionManager) {}

    getSelectedItem(): NavigatorItem | undefined {
        return this.selectedItem;
    }

    setSelectedItem(item: NavigatorItem | undefined): void {
        this.selectedItem = item;
        this.loadDetails();
    }

    /** Navigate to item, pushing current selection onto back-history */
    navigateTo(item: NavigatorItem): void {
        if (this.selectedItem) {
            this.history.push(this.selectedItem);
            if (this.history.length > DetailsProvider.MAX_HISTORY) {
                this.history.shift();
            }
        }
        this.updateBackContext();
        this.setSelectedItem(item);
    }

    /** Go back to previous item */
    goBack(): void {
        const prev = this.history.pop();
        this.updateBackContext();
        if (prev) {
            this.setSelectedItem(prev);
        }
    }

    hasBack(): boolean {
        return this.history.length > 0;
    }

    peekBack(): NavigatorItem | undefined {
        return this.history.length > 0 ? this.history[this.history.length - 1] : undefined;
    }

    private updateBackContext(): void {
        vscode.commands.executeCommand('setContext', 'ydb.detailsHasBack', this.history.length > 0);
    }

    clear(): void {
        this.selectedItem = undefined;
        this.cachedDescription.clear();
        this.currentItems = [];
        this.history = [];
        this.updateBackContext();
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: DetailItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: DetailItem): Promise<DetailItem[]> {
        if (element) {
            return element.children ?? [];
        }
        return this.currentItems;
    }

    private async loadDetails(): Promise<void> {
        const item = this.selectedItem;
        if (!item || item.entryType === 'root-folder' || item.entryType === SchemeEntryType.DIRECTORY) {
            this.currentItems = [];
            this._onDidChangeTreeData.fire();
            return;
        }

        const isTable = item.entryType === SchemeEntryType.TABLE
            || item.entryType === SchemeEntryType.COLUMN_TABLE
            || item.entryType === SchemeEntryType.COLUMN_STORE;

        const isExternalDataSource = item.entryType === SchemeEntryType.EXTERNAL_DATA_SOURCE;
        const isExternalTable = item.entryType === SchemeEntryType.EXTERNAL_TABLE;
        const isTransfer = item.entryType === SchemeEntryType.TRANSFER;
        const isResourcePool = item.entryType === SchemeEntryType.RESOURCE_POOL;

        if (!isTable && !isExternalDataSource && !isExternalTable && !isTransfer && !isResourcePool) {
            const headerItem = new DetailItem(item.label as string, vscode.TreeItemCollapsibleState.None);
            headerItem.contextValue = `detail-${item.contextValue}`;
            this.currentItems = [headerItem];
            const typeItem = new DetailItem(`Type: ${item.contextValue}`, vscode.TreeItemCollapsibleState.None);
            typeItem.iconPath = new vscode.ThemeIcon('symbol-type-parameter');
            this.currentItems.push(typeItem);
            this._onDidChangeTreeData.fire();
            return;
        }

        if (isExternalDataSource) {
            await this.loadExternalDataSourceDetails(item);
            return;
        }

        if (isExternalTable) {
            await this.loadExternalTableDetails(item);
            return;
        }

        if (isTransfer) {
            await this.loadTransferDetails(item);
            return;
        }

        if (isResourcePool) {
            await this.loadResourcePoolDetails(item);
            return;
        }

        // Show loading
        if (this.loading) {
            return;
        }
        this.loading = true;

        try {
            let description = this.cachedDescription.get(item.fullPath);
            if (!description) {
                const driver = await this.connectionManager.getDriver();
                const queryService = new QueryService(driver);
                const db = driver.database.endsWith('/') ? driver.database.slice(0, -1) : driver.database;
                const tablePath = item.fullPath.startsWith('/')
                    ? item.fullPath
                    : db + '/' + item.fullPath;
                description = await queryService.describeTable(tablePath);
                this.cachedDescription.set(item.fullPath, description);
            }

            if (this.selectedItem !== item) {
                return;
            }

            this.currentItems = this.buildTableItems(description, item.contextValue);
            this._onDidChangeTreeData.fire();
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.currentItems = [
                new DetailItem(`Error: ${msg}`, vscode.TreeItemCollapsibleState.None),
            ];
            this._onDidChangeTreeData.fire();
        } finally {
            this.loading = false;
        }
    }

    private async loadExternalDataSourceDetails(item: NavigatorItem): Promise<void> {
        if (this.loading) {
            return;
        }
        this.loading = true;

        try {
            const driver = await this.connectionManager.getDriver();
            const queryService = new QueryService(driver);
            const db = driver.database.endsWith('/') ? driver.database.slice(0, -1) : driver.database;
            const fullPath = item.fullPath.startsWith('/')
                ? item.fullPath
                : db + '/' + item.fullPath;
            const desc = await queryService.describeExternalDataSource(fullPath);

            if (this.selectedItem !== item) {
                return;
            }

            const items: DetailItem[] = [];

            const headerItem = new DetailItem(item.label as string, vscode.TreeItemCollapsibleState.None);
            headerItem.contextValue = `detail-${item.contextValue}`;
            headerItem.iconPath = new vscode.ThemeIcon('plug');
            items.push(headerItem);

            if (desc.sourceType) {
                const sourceTypeItem = new DetailItem(`Source Type: ${desc.sourceType}`, vscode.TreeItemCollapsibleState.None);
                sourceTypeItem.iconPath = new vscode.ThemeIcon('symbol-type-parameter');
                items.push(sourceTypeItem);
            }

            if (desc.location) {
                const locationItem = new DetailItem(`Location: ${desc.location}`, vscode.TreeItemCollapsibleState.None);
                locationItem.iconPath = new vscode.ThemeIcon('globe');
                items.push(locationItem);
            }

            // Separate REFERENCES from other properties
            const referencesProp = desc.properties['REFERENCES'];
            const propEntries = Object.entries(desc.properties).filter(([key]) => key !== 'REFERENCES');

            if (propEntries.length > 0) {
                const propChildren: DetailItem[] = propEntries.map(([key, value]) => {
                    const propItem = new DetailItem(`${key}: ${value}`, vscode.TreeItemCollapsibleState.None);
                    propItem.iconPath = new vscode.ThemeIcon('symbol-property');
                    return propItem;
                });
                const propsSection = new DetailItem(
                    `Properties (${propEntries.length})`,
                    vscode.TreeItemCollapsibleState.Expanded,
                    'properties',
                    propChildren,
                );
                propsSection.iconPath = new vscode.ThemeIcon('list-unordered');
                items.push(propsSection);
            }

            // Show references as collapsible section with navigable sub-items
            if (referencesProp) {
                let refPaths: string[] = [];
                try {
                    const parsed = JSON.parse(referencesProp);
                    if (Array.isArray(parsed)) {
                        refPaths = parsed.map(String);
                    }
                } catch {
                    // Try comma-separated fallback
                    refPaths = referencesProp.split(',').map(s => s.trim()).filter(Boolean);
                }

                if (refPaths.length > 0) {
                    const db = driver.database.endsWith('/') ? driver.database.slice(0, -1) : driver.database;
                    const refChildren: DetailItem[] = refPaths.map(refPath => {
                        // Compute relative path (strip database prefix)
                        let displayPath = refPath;
                        if (displayPath.startsWith(db + '/')) {
                            displayPath = displayPath.slice(db.length + 1);
                        }
                        const refItem = new DetailItem(displayPath, vscode.TreeItemCollapsibleState.None);
                        refItem.iconPath = new vscode.ThemeIcon('link-external');
                        refItem.contextValue = 'detail-reference-link';
                        refItem.referencePath = refPath;
                        refItem.tooltip = refPath;
                        refItem.command = {
                            command: 'ydb.goToReference',
                            title: 'Go to Reference',
                            arguments: [{ referencePath: refPath }],
                        };
                        return refItem;
                    });
                    const refsSection = new DetailItem(
                        `References (${refPaths.length})`,
                        vscode.TreeItemCollapsibleState.Expanded,
                        'references',
                        refChildren,
                    );
                    refsSection.iconPath = new vscode.ThemeIcon('references');
                    items.push(refsSection);
                }
            }

            this.currentItems = items;
            this._onDidChangeTreeData.fire();
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.currentItems = [
                new DetailItem(`Error: ${msg}`, vscode.TreeItemCollapsibleState.None),
            ];
            this._onDidChangeTreeData.fire();
        } finally {
            this.loading = false;
        }
    }

    private async loadExternalTableDetails(item: NavigatorItem): Promise<void> {
        if (this.loading) {
            return;
        }
        this.loading = true;

        try {
            const driver = await this.connectionManager.getDriver();
            const queryService = new QueryService(driver);
            const db = driver.database.endsWith('/') ? driver.database.slice(0, -1) : driver.database;
            const fullPath = item.fullPath.startsWith('/')
                ? item.fullPath
                : db + '/' + item.fullPath;
            const desc = await queryService.describeExternalTable(fullPath);

            if (this.selectedItem !== item) {
                return;
            }

            const items: DetailItem[] = [];

            const headerItem = new DetailItem(item.label as string, vscode.TreeItemCollapsibleState.None);
            headerItem.contextValue = `detail-${item.contextValue}`;
            headerItem.iconPath = new vscode.ThemeIcon('link-external');
            items.push(headerItem);

            if (desc.sourceType) {
                const sourceTypeItem = new DetailItem(`Source Type: ${desc.sourceType}`, vscode.TreeItemCollapsibleState.None);
                sourceTypeItem.iconPath = new vscode.ThemeIcon('symbol-type-parameter');
                items.push(sourceTypeItem);
            }

            if (desc.dataSourcePath) {
                const dsPathItem = new DetailItem(`Data Source: ${desc.dataSourcePath}`, vscode.TreeItemCollapsibleState.None);
                dsPathItem.iconPath = new vscode.ThemeIcon('plug');
                dsPathItem.contextValue = 'detail-datasource-link';
                dsPathItem.dataSourcePath = desc.dataSourcePath;
                items.push(dsPathItem);
            }

            if (desc.location) {
                const locationItem = new DetailItem(`Location: ${desc.location}`, vscode.TreeItemCollapsibleState.None);
                locationItem.iconPath = new vscode.ThemeIcon('globe');
                items.push(locationItem);
            }

            if (desc.columns.length > 0) {
                const columnChildren: DetailItem[] = desc.columns.map(col => {
                    const colItem = new DetailItem(`${col.name}: ${col.type}`, vscode.TreeItemCollapsibleState.None);
                    colItem.iconPath = new vscode.ThemeIcon('symbol-field');
                    return colItem;
                });
                const columnsSection = new DetailItem(
                    `Columns (${desc.columns.length})`,
                    vscode.TreeItemCollapsibleState.Expanded,
                    'columns',
                    columnChildren,
                );
                columnsSection.iconPath = new vscode.ThemeIcon('symbol-structure');
                items.push(columnsSection);
            }

            if (desc.format) {
                const formatItem = new DetailItem(`Format: ${desc.format}`, vscode.TreeItemCollapsibleState.None);
                formatItem.iconPath = new vscode.ThemeIcon('file-text');
                items.push(formatItem);
            }

            if (desc.compression) {
                const compressionItem = new DetailItem(`Compression: ${desc.compression}`, vscode.TreeItemCollapsibleState.None);
                compressionItem.iconPath = new vscode.ThemeIcon('fold');
                items.push(compressionItem);
            }

            this.currentItems = items;
            this._onDidChangeTreeData.fire();
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.currentItems = [
                new DetailItem(`Error: ${msg}`, vscode.TreeItemCollapsibleState.None),
            ];
            this._onDidChangeTreeData.fire();
        } finally {
            this.loading = false;
        }
    }

    private async loadTransferDetails(item: NavigatorItem): Promise<void> {
        if (this.loading) {
            return;
        }
        this.loading = true;

        try {
            const driver = await this.connectionManager.getDriver();
            const queryService = new QueryService(driver);
            const db = driver.database.endsWith('/') ? driver.database.slice(0, -1) : driver.database;
            const fullPath = item.fullPath.startsWith('/')
                ? item.fullPath
                : db + '/' + item.fullPath;
            const desc = await queryService.describeTransfer(fullPath);

            if (this.selectedItem !== item) {
                return;
            }

            const items: DetailItem[] = [];

            const headerItem = new DetailItem(item.label as string, vscode.TreeItemCollapsibleState.None);
            headerItem.contextValue = `detail-${item.contextValue}`;
            headerItem.iconPath = new vscode.ThemeIcon('arrow-swap');
            items.push(headerItem);

            const stateItem = new DetailItem(`State: ${desc.state}`, vscode.TreeItemCollapsibleState.None);
            stateItem.iconPath = new vscode.ThemeIcon('symbol-event');
            items.push(stateItem);

            // grpc:///? (no host, empty or no database) means local — treat as non-external
            const isExternal = !!desc.connectionString
                && !desc.connectionString.startsWith('grpc:///?');

            const stripDb = (p: string) => p.startsWith(db + '/') ? p.slice(db.length + 1) : p;

            if (desc.sourcePath) {
                // Normalize to absolute path — source is relative to the database
                let absSourcePath = desc.sourcePath;
                if (!absSourcePath.startsWith(db + '/')) {
                    absSourcePath = absSourcePath.startsWith('/')
                        ? db + absSourcePath
                        : db + '/' + absSourcePath;
                }
                const relSourcePath = stripDb(absSourcePath);

                if (isExternal) {
                    const sourceItem = new DetailItem(`Source: ${relSourcePath}`, vscode.TreeItemCollapsibleState.None);
                    sourceItem.iconPath = new vscode.ThemeIcon('cloud');
                    sourceItem.description = 'external';
                    sourceItem.tooltip = `External source (${desc.connectionString})`;
                    items.push(sourceItem);
                } else {
                    const sourceItem = new DetailItem(`Source: ${relSourcePath}`, vscode.TreeItemCollapsibleState.None);
                    sourceItem.iconPath = new vscode.ThemeIcon('database');
                    sourceItem.contextValue = 'detail-transfer-target-link';
                    sourceItem.transferTargetPath = absSourcePath;
                    sourceItem.tooltip = absSourcePath;
                    sourceItem.command = {
                        command: 'ydb.goToTransferTarget',
                        title: 'Go to Source',
                        arguments: [{ transferTargetPath: absSourcePath }],
                    };
                    items.push(sourceItem);
                }
            }

            if (desc.destinationPath) {
                // Normalize to absolute path
                const absDestPath = desc.destinationPath.startsWith('/')
                    ? desc.destinationPath
                    : db + '/' + desc.destinationPath;
                const relDestPath = stripDb(absDestPath);

                // Destination is always local
                const destItem = new DetailItem(`Destination: ${relDestPath}`, vscode.TreeItemCollapsibleState.None);
                destItem.iconPath = new vscode.ThemeIcon('database');
                destItem.contextValue = 'detail-transfer-target-link';
                destItem.transferTargetPath = absDestPath;
                destItem.tooltip = absDestPath;
                destItem.command = {
                    command: 'ydb.goToTransferTarget',
                    title: 'Go to Destination',
                    arguments: [{ transferTargetPath: absDestPath }],
                };
                items.push(destItem);
            }

            if (isExternal && desc.connectionString) {
                const connItem = new DetailItem(`Connection: ${desc.connectionString}`, vscode.TreeItemCollapsibleState.None);
                connItem.iconPath = new vscode.ThemeIcon('cloud');
                items.push(connItem);
            }

            if (desc.transformationLambda) {
                const lambdaItem = new DetailItem(`Transformation Lambda`, vscode.TreeItemCollapsibleState.None);
                lambdaItem.iconPath = new vscode.ThemeIcon('symbol-function');
                lambdaItem.tooltip = desc.transformationLambda;
                items.push(lambdaItem);
            }

            if (desc.consumerName) {
                const consumerItem = new DetailItem(`Consumer: ${desc.consumerName}`, vscode.TreeItemCollapsibleState.None);
                consumerItem.iconPath = new vscode.ThemeIcon('symbol-constant');
                items.push(consumerItem);
            }

            this.currentItems = items;
            this._onDidChangeTreeData.fire();
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.currentItems = [
                new DetailItem(`Error: ${msg}`, vscode.TreeItemCollapsibleState.None),
            ];
            this._onDidChangeTreeData.fire();
        } finally {
            this.loading = false;
        }
    }

    private async loadResourcePoolDetails(item: NavigatorItem): Promise<void> {
        if (this.loading) {
            return;
        }
        this.loading = true;

        try {
            const driver = await this.connectionManager.getDriver();
            const queryService = new QueryService(driver);
            const pool = await queryService.loadResourcePoolByName(item.fullPath);

            if (this.selectedItem !== item) {
                return;
            }

            const items: DetailItem[] = [];

            const headerItem = new DetailItem(item.label as string, vscode.TreeItemCollapsibleState.None);
            headerItem.contextValue = `detail-${item.contextValue}`;
            headerItem.iconPath = new vscode.ThemeIcon('server-process');
            items.push(headerItem);

            if (!pool) {
                items.push(new DetailItem('Not found', vscode.TreeItemCollapsibleState.None));
                this.currentItems = items;
                this._onDidChangeTreeData.fire();
                return;
            }

            const makeItem = (label: string, icon: string): DetailItem => {
                const d = new DetailItem(label, vscode.TreeItemCollapsibleState.None);
                d.iconPath = new vscode.ThemeIcon(icon);
                return d;
            };

            const fmt = (val: number) => val === -1 ? 'unlimited' : String(val);

            items.push(makeItem(`ConcurrentQueryLimit: ${fmt(pool.concurrentQueryLimit)}`, 'symbol-numeric'));
            items.push(makeItem(`QueueSize: ${fmt(pool.queueSize)}`, 'list-ordered'));
            items.push(makeItem(`DatabaseLoadCpuThreshold: ${fmt(pool.databaseLoadCpuThreshold)}`, 'dashboard'));
            items.push(makeItem(`ResourceWeight: ${fmt(pool.resourceWeight)}`, 'symbol-numeric'));
            items.push(makeItem(`TotalCpuLimitPercentPerNode: ${fmt(pool.totalCpuLimitPercentPerNode)}`, 'pulse'));
            items.push(makeItem(`QueryCpuLimitPercentPerNode: ${fmt(pool.queryCpuLimitPercentPerNode)}`, 'pulse'));
            items.push(makeItem(`QueryMemoryLimitPercentPerNode: ${fmt(pool.queryMemoryLimitPercentPerNode)}`, 'database'));

            this.currentItems = items;
            this._onDidChangeTreeData.fire();
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.currentItems = [
                new DetailItem(`Error: ${msg}`, vscode.TreeItemCollapsibleState.None),
            ];
            this._onDidChangeTreeData.fire();
        } finally {
            this.loading = false;
        }
    }

    private buildTableItems(desc: TableDescription, itemContextValue: string): DetailItem[] {
        const items: DetailItem[] = [];

        // Build columns section
        const pkSet = new Set(desc.primaryKeys);
        const pkColumns: DetailItem[] = [];
        const nonPkColumns: DetailItem[] = [];

        // PK columns in PK declaration order
        for (const pkName of desc.primaryKeys) {
            const col = desc.columns.find(c => c.name === pkName);
            if (col) {
                const item = new DetailItem(
                    `${col.name}: ${col.type}`,
                    vscode.TreeItemCollapsibleState.None,
                );
                item.iconPath = new vscode.ThemeIcon('key');
                item.description = 'PK';
                pkColumns.push(item);
            }
        }

        // Non-PK columns in original order
        for (const col of desc.columns) {
            if (!pkSet.has(col.name)) {
                const item = new DetailItem(
                    `${col.name}: ${col.type}`,
                    vscode.TreeItemCollapsibleState.None,
                );
                item.iconPath = new vscode.ThemeIcon('symbol-field');
                nonPkColumns.push(item);
            }
        }

        const allColumnItems = [...pkColumns, ...nonPkColumns];
        const columnsSection = new DetailItem(
            `Columns (${allColumnItems.length})`,
            vscode.TreeItemCollapsibleState.Expanded,
            'columns',
            allColumnItems,
        );
        columnsSection.iconPath = new vscode.ThemeIcon('symbol-structure');
        columnsSection.contextValue = `detail-${itemContextValue}`;
        items.push(columnsSection);

        // Partition By section
        if (desc.partitionBy.length > 0) {
            const partitionItems = desc.partitionBy.map(name => {
                const item = new DetailItem(name, vscode.TreeItemCollapsibleState.None);
                item.iconPath = new vscode.ThemeIcon('split-horizontal');
                return item;
            });
            const partitionSection = new DetailItem(
                `Partition By (${partitionItems.length})`,
                vscode.TreeItemCollapsibleState.Expanded,
                'partitionBy',
                partitionItems,
            );
            partitionSection.iconPath = new vscode.ThemeIcon('layers');
            items.push(partitionSection);
        }

        return items;
    }
}
