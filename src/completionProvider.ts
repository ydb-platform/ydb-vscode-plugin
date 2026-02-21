import * as vscode from 'vscode';
import { parseYqlQuery } from '@gravity-ui/websql-autocomplete/yql';
import type { YqlAutocompleteResult } from '@gravity-ui/websql-autocomplete/yql';
import { YdbNavigatorProvider } from './views/navigatorProvider';
import { ConnectionManager } from './services/connectionManager';
import { getMonitoringUrl, extractAuthToken } from './models/connectionProfile';
import { fetchEntities, fetchColumns } from './services/viewerService';
import {
    SimpleFunctions,
    AggregateFunctions,
    WindowFunctions,
    TableFunctions,
    Udfs,
    SimpleTypes,
    Pragmas,
    EntitySettings,
} from './constants/yqlConstants';
import type { YQLEntity } from './constants/yqlConstants';

const COLUMN_ENTITY_TYPES = new Set(['column', 'column_table_column']);

const ENTITY_TYPE_MAP: Partial<Record<YQLEntity, string[]>> = {
    externalDataSource: ['external_data_source'],
    externalTable: ['external_table'],
    replication: ['replication'],
    table: ['table', 'column_table'],
    tableStore: ['column_store'],
    topic: ['pers_queue_group'],
    view: ['view'],
    tableIndex: ['table_index', 'index'],
    streamingQuery: ['streaming_query'],
};

const DIRECTORY_TYPES = new Set(['dir', 'ext_sub_domain']);
const COMMON_ENTITY_TYPES = new Set(['dir', 'unknown', 'ext_sub_domain']);

function removeBackticks(value: string): string {
    let start = 0;
    let end = value.length;
    if (value.startsWith('`')) { start = 1; }
    if (value.endsWith('`')) { end = -1; }
    return value.slice(start, end === -1 ? undefined : end);
}

function normalizeEntityPrefix(value = '', database: string): string {
    const cleaned = removeBackticks(value);
    if (!cleaned.startsWith('/')) {
        return cleaned;
    }
    let v = cleaned.startsWith('/') ? cleaned.slice(1) : cleaned;
    const db = database.startsWith('/') ? database.slice(1) : database;
    if (v.startsWith(db)) {
        v = v.slice(db.length);
    }
    return v.startsWith('/') ? v.slice(1) : v;
}

function getColumnDetails(entity: { PKIndex?: number; NotNull?: boolean; Default?: number }): string {
    const details: string[] = [];
    if (entity.PKIndex !== undefined) { details.push(`PK${entity.PKIndex}`); }
    if (entity.NotNull) { details.push('NN'); }
    if (entity.Default) { details.push('Default'); }
    return details.join(', ');
}

export class YqlCompletionProvider implements vscode.CompletionItemProvider {
    constructor(
        private navigatorProvider: YdbNavigatorProvider,
        private connectionManager?: ConnectionManager,
    ) {}

    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
    ): Promise<vscode.CompletionItem[]> {
        return this.getCompletionItemsForText(
            document.getText(),
            position.line + 1,
            position.character + 1,
        );
    }

    // line and column are 1-based (Monaco / parseYqlQuery convention)
    async getCompletionItemsForText(text: string, line: number, column: number): Promise<vscode.CompletionItem[]> {
        const cursor = { line, column };

        let result: YqlAutocompleteResult;
        try {
            result = parseYqlQuery(text, cursor);
        } catch {
            return [];
        }

        const items: vscode.CompletionItem[] = [];

        // Keywords
        if (result.suggestKeywords) {
            for (const kw of result.suggestKeywords) {
                const item = new vscode.CompletionItem(kw.value, vscode.CompletionItemKind.Keyword);
                item.detail = 'YQL keyword';
                item.sortText = '1_' + kw.value;
                items.push(item);
            }
        }

        // Simple functions
        if (result.suggestFunctions) {
            for (const fn of SimpleFunctions) {
                const item = new vscode.CompletionItem(fn, vscode.CompletionItemKind.Function);
                item.detail = 'YQL function';
                item.sortText = '2_' + fn;
                items.push(item);
            }
        }

        // Aggregate functions
        if (result.suggestAggregateFunctions) {
            for (const fn of AggregateFunctions) {
                const item = new vscode.CompletionItem(fn, vscode.CompletionItemKind.Function);
                item.detail = 'Aggregate function';
                item.sortText = '2_' + fn;
                items.push(item);
            }
        }

        // Window functions
        if (result.suggestWindowFunctions) {
            for (const fn of WindowFunctions) {
                const item = new vscode.CompletionItem(fn, vscode.CompletionItemKind.Function);
                item.detail = 'Window function';
                item.sortText = '2_' + fn;
                items.push(item);
            }
        }

        // Table functions
        if (result.suggestTableFunctions) {
            for (const fn of TableFunctions) {
                const item = new vscode.CompletionItem(fn, vscode.CompletionItemKind.Function);
                item.detail = 'Table function';
                item.sortText = '2_' + fn;
                items.push(item);
            }
        }

        // UDFs
        if (result.suggestUdfs) {
            for (const udf of Udfs) {
                const item = new vscode.CompletionItem(udf, vscode.CompletionItemKind.Function);
                item.detail = 'UDF';
                item.sortText = '3_' + udf;
                items.push(item);
            }
        }

        // Simple types
        if (result.suggestSimpleTypes) {
            for (const tp of SimpleTypes) {
                const item = new vscode.CompletionItem(tp, vscode.CompletionItemKind.TypeParameter);
                item.detail = 'YQL type';
                item.sortText = '4_' + tp;
                items.push(item);
            }
        }

        // Pragmas
        if (result.suggestPragmas) {
            for (const pragma of Pragmas) {
                const item = new vscode.CompletionItem(pragma, vscode.CompletionItemKind.Property);
                item.detail = 'Pragma';
                item.sortText = '5_' + pragma;
                items.push(item);
            }
        }

        // Entity settings
        if (result.suggestEntitySettings) {
            const entityType = result.suggestEntitySettings as YQLEntity;
            const settings = EntitySettings[entityType] ?? [];
            for (const setting of settings) {
                const item = new vscode.CompletionItem(setting, vscode.CompletionItemKind.Property);
                item.detail = 'Setting';
                item.sortText = '5_' + setting;
                items.push(item);
            }
        }

        // Column aliases
        if (result.suggestColumnAliases) {
            for (const alias of result.suggestColumnAliases) {
                const item = new vscode.CompletionItem(alias.name, vscode.CompletionItemKind.Variable);
                item.detail = 'Column alias';
                item.sortText = '0_' + alias.name;
                items.push(item);
            }
        }

        // Variables
        if (result.suggestVariables) {
            for (const variable of result.suggestVariables) {
                const item = new vscode.CompletionItem(variable.name, vscode.CompletionItemKind.Variable);
                item.detail = 'Variable';
                item.sortText = '0_' + variable.name;
                items.push(item);
            }
        }

        // Entities (tables, views, etc.) - from viewer API and navigator cache
        if (result.suggestEntity && result.suggestEntity.length > 0) {
            const entityItems = await this.getEntityCompletionsForText(result.suggestEntity, text, line, column);
            items.push(...entityItems);
        }

        // Columns - from viewer API
        if (result.suggestColumns) {
            const columnItems = await this.getColumnCompletions(result.suggestColumns);
            items.push(...columnItems);
        }

        return items;
    }

    private async getEntityCompletionsForText(
        suggestEntity: YQLEntity[],
        text: string,
        line: number,
        column: number,
    ): Promise<vscode.CompletionItem[]> {
        const items: vscode.CompletionItem[] = [];

        const allowedTypes = new Set<string>();
        for (const entity of suggestEntity) {
            const types = ENTITY_TYPE_MAP[entity];
            if (types) {
                types.forEach(t => allowedTypes.add(t));
            }
        }
        COMMON_ENTITY_TYPES.forEach(t => allowedTypes.add(t));

        // Check if cursor is inside backticks to avoid double-wrapping
        // line and column are 1-based
        const lines = text.split('\n');
        let offset = 0;
        for (let i = 0; i < line - 1 && i < lines.length; i++) {
            offset += lines[i].length + 1;
        }
        offset += Math.min(column - 1, (lines[line - 1] || '').length);
        const textBefore = text.slice(0, offset);
        const insideBacktick = (textBefore.split('`').length % 2) === 0;

        let hasViewerResults = false;

        // 1. Try viewer API first (fast HTTP call)
        if (this.connectionManager) {
            try {
                const profile = this.connectionManager.getActiveProfile();
                if (profile) {
                    const monitoringUrl = getMonitoringUrl(profile);
                    if (monitoringUrl) {
                        const entities = await fetchEntities(
                            monitoringUrl,
                            profile.database,
                            '',
                            extractAuthToken(profile),
                        );
                        const filtered = entities.filter(e =>
                            allowedTypes.has(e.Type) || COMMON_ENTITY_TYPES.has(e.Type),
                        );
                        for (const entity of filtered) {
                            const isDir = DIRECTORY_TYPES.has(entity.Type);
                            const item = new vscode.CompletionItem(
                                entity.Name,
                                isDir ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.Value,
                            );
                            item.detail = entity.Type;
                            item.sortText = '0_' + entity.Name;
                            items.push(item);
                        }
                        hasViewerResults = filtered.length > 0;
                    }
                }
            } catch {
                // Graceful degradation — fall through to SchemeService
            }
        }

        // 2. Fall back to SchemeService (may be slow on large catalogs)
        const tables = await this.navigatorProvider.ensureTableNamesLoaded();
        for (const table of tables) {
            // Skip if viewer API already returned results and this table is likely a duplicate
            if (hasViewerResults) {
                const shortName = table.split('/').pop() ?? table;
                if (items.some(i => i.label === shortName)) {
                    continue;
                }
            }
            const shortName = table.split('/').pop() ?? table;
            const item = new vscode.CompletionItem(shortName, vscode.CompletionItemKind.Value);
            item.detail = table;
            item.insertText = insideBacktick ? table : `\`${table}\``;
            item.sortText = '0_' + shortName;
            items.push(item);
        }

        return items;
    }

    private async getColumnCompletions(
        suggestColumns: YqlAutocompleteResult['suggestColumns'],
    ): Promise<vscode.CompletionItem[]> {
        const items: vscode.CompletionItem[] = [];

        if (!suggestColumns?.tables?.length || !this.connectionManager) {
            return items;
        }

        try {
            const profile = this.connectionManager.getActiveProfile();
            if (!profile) { return items; }
            const monitoringUrl = getMonitoringUrl(profile);
            if (!monitoringUrl) { return items; }

            const tableNames = suggestColumns.tables.map((t: { name: string }) => {
                let name = removeBackticks(t.name);
                if (!name.endsWith('/')) {
                    name = name + '/';
                }
                return normalizeEntityPrefix(name, profile.database);
            });

            const entities = await fetchColumns(
                monitoringUrl,
                profile.database,
                tableNames,
                extractAuthToken(profile),
            );

            for (const entity of entities) {
                if (!COLUMN_ENTITY_TYPES.has(entity.Type)) {
                    continue;
                }
                const item = new vscode.CompletionItem(entity.Name, vscode.CompletionItemKind.Field);
                const detail = getColumnDetails(entity);
                item.detail = detail || 'Column';
                item.sortText = '0_' + entity.Name;
                items.push(item);
            }
        } catch {
            // Graceful degradation
        }

        return items;
    }
}
