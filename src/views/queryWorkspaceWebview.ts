import * as vscode from 'vscode';
import { ConnectionManager } from '../services/connectionManager';
import { QueryService, fetchPlanSvg, CancellationError } from '../services/queryService';
import { Type_PrimitiveTypeId, TypeSchema, TypedValueSchema, ValueSchema } from '@ydbjs/api/value';
import type { Type, TypedValue, Value } from '@ydbjs/api/value';
import { create } from '@bufbuild/protobuf';
import { ColumnInfo } from '../models/types';
import { parsePlanRoot } from '../utils/planParser';
import { getMonitoringUrl, extractAuthToken } from '../models/connectionProfile';
import { YqlCompletionProvider } from '../completionProvider';

// ==================== Interfaces ====================

interface CachedState {
    queryResult?: Record<string, unknown>;
    statsResult?: Record<string, unknown>;
    explainResult?: Record<string, unknown>;
    allRows?: Record<string, unknown>;
}

interface WorkspacePair {
    panel: vscode.WebviewPanel;
    connectionManager: ConnectionManager;
    cachedColumns: ColumnInfo[];
    currentQuery: string;
    cancellation: vscode.CancellationTokenSource | undefined;
    cached: CachedState;
    boundConnectionProfileId?: string;
}

export interface PersistedWorkspaceState {
    pairKey: string;
    title: string;
    queryText: string;
    connectionProfileId?: string;
    cachedColumns: ColumnInfo[];
    cached: CachedState;
    viewColumn?: number;
}

interface EditEntry {
    rowIdx: number;
    colName: string;
    newValue: string;
    pkValues: Record<string, unknown>;
    colType: string;
}

interface CommitEditsMessage {
    tablePath: string;
    edits: EditEntry[];
    columnTypes: Record<string, string>;
}

// ==================== Global state ====================

const workspacePairs = new Map<string, WorkspacePair>();
let workspaceCounter = 0;
let _extensionUri: vscode.Uri | undefined;
let _lastActivePairKey: string | undefined;
let _completionProvider: YqlCompletionProvider | undefined;
let _workspaceState: vscode.Memento | undefined;
let _connectionManager: ConnectionManager | undefined;
let _saveTimer: ReturnType<typeof setTimeout> | undefined;

const WORKSPACE_STATES_KEY = 'ydb.workspaceStates';
const WORKSPACE_COUNTER_KEY = 'ydb.workspaceCounter';
const MAX_CACHED_BYTES = 2 * 1024 * 1024;

// ==================== Helpers ====================

function getLastActivePair(): WorkspacePair | undefined {
    if (!_lastActivePairKey) {return undefined;}
    return workspacePairs.get(_lastActivePairKey);
}

function sendToPair(pair: WorkspacePair, msg: Record<string, unknown>): void {
    pair.panel.webview.postMessage(msg);
}

function pairCancelQuery(pair: WorkspacePair): void {
    if (pair.cancellation) {
        pair.cancellation.cancel();
        pair.cancellation.dispose();
        pair.cancellation = undefined;
    }
}

function pairCreateToken(pair: WorkspacePair): vscode.CancellationToken {
    pairCancelQuery(pair);
    pair.cancellation = new vscode.CancellationTokenSource();
    return pair.cancellation.token;
}

function pairCleanupCancellation(pair: WorkspacePair): void {
    if (pair.cancellation) {
        pair.cancellation.dispose();
        pair.cancellation = undefined;
    }
}

function generateNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let nonce = '';
    for (let i = 0; i < 32; i++) {
        nonce += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return nonce;
}

function getMonacoTheme(): string {
    switch (vscode.window.activeColorTheme.kind) {
        case vscode.ColorThemeKind.Dark: return 'vs-dark';
        case vscode.ColorThemeKind.HighContrast: return 'hc-black';
        case vscode.ColorThemeKind.HighContrastLight: return 'hc-light';
        default: return 'vs';
    }
}

// ==================== Persistence ====================

export function truncateCachedState(cached: CachedState, maxBytes: number = MAX_CACHED_BYTES): CachedState {
    const result = { ...cached };
    const json = JSON.stringify(result);
    if (json.length <= maxBytes) {
        return result;
    }

    // Drop largest entries first: allRows, queryResult, statsResult, explainResult
    const keys: (keyof CachedState)[] = ['allRows', 'queryResult', 'statsResult', 'explainResult'];
    const sizes = keys
        .filter(k => result[k] !== undefined)
        .map(k => ({ key: k, size: JSON.stringify(result[k]).length }))
        .sort((a, b) => b.size - a.size);

    for (const entry of sizes) {
        result[entry.key] = undefined;
        if (JSON.stringify(result).length <= maxBytes) {
            break;
        }
    }
    return result;
}

export function saveAllWorkspaceStates(): void {
    if (!_workspaceState) {return;}
    const states: PersistedWorkspaceState[] = [];
    for (const [pairKey, pair] of workspacePairs) {
        states.push({
            pairKey,
            title: pair.panel.title,
            queryText: pair.currentQuery,
            connectionProfileId: pair.boundConnectionProfileId,
            cachedColumns: pair.cachedColumns,
            cached: truncateCachedState(pair.cached),
            viewColumn: pair.panel.viewColumn,
        });
    }
    _workspaceState.update(WORKSPACE_STATES_KEY, states);
    _workspaceState.update(WORKSPACE_COUNTER_KEY, workspaceCounter);
}

function scheduleSaveWorkspaceStates(): void {
    if (_saveTimer) {clearTimeout(_saveTimer);}
    _saveTimer = setTimeout(() => {
        _saveTimer = undefined;
        saveAllWorkspaceStates();
    }, 300);
}

function replayCachedState(pair: WorkspacePair, cached: CachedState): void {
    if (cached.queryResult) {
        sendToPair(pair, cached.queryResult);
    }
    if (cached.statsResult) {
        sendToPair(pair, cached.statsResult);
    }
    if (cached.explainResult) {
        sendToPair(pair, cached.explainResult);
    }
    if (cached.allRows) {
        sendToPair(pair, cached.allRows);
    }
}

// ==================== Public API ====================

export function registerWorkspaceListeners(context: vscode.ExtensionContext, connectionManager: ConnectionManager, completionProvider?: YqlCompletionProvider): void {
    _extensionUri = context.extensionUri;
    _completionProvider = completionProvider;
    _workspaceState = context.workspaceState;
    _connectionManager = connectionManager;

    // Restore workspace counter
    const savedCounter = _workspaceState.get<number>(WORKSPACE_COUNTER_KEY, 0);
    if (savedCounter > workspaceCounter) {
        workspaceCounter = savedCounter;
    }

    // Register serializer for restoring panels on VS Code restart
    context.subscriptions.push(
        vscode.window.registerWebviewPanelSerializer('ydbQueryWorkspace', {
            async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: { pairKey?: string }): Promise<void> {
                if (!_extensionUri) {return;}
                const pairKey = state?.pairKey;
                if (!pairKey) {return;}

                // Find persisted state for this panel
                const savedStates = _workspaceState?.get<PersistedWorkspaceState[]>(WORKSPACE_STATES_KEY, []) ?? [];
                const persisted = savedStates.find(s => s.pairKey === pairKey);

                // Resolve connection profile
                let boundProfileId = persisted?.connectionProfileId;
                if (boundProfileId) {
                    const exists = connectionManager.getProfiles().some(p => p.id === boundProfileId);
                    if (!exists) {
                        boundProfileId = connectionManager.getFocusedProfileId();
                    }
                } else {
                    boundProfileId = connectionManager.getFocusedProfileId();
                }

                const queryText = persisted?.queryText ?? '';
                const title = persisted?.title ?? panel.title;

                panel.title = title;
                panel.webview.options = {
                    enableScripts: true,
                    localResourceRoots: [_extensionUri],
                };

                const pair: WorkspacePair = {
                    panel,
                    connectionManager,
                    cachedColumns: persisted?.cachedColumns ?? [],
                    currentQuery: queryText,
                    cancellation: undefined,
                    cached: persisted?.cached ?? {},
                    boundConnectionProfileId: boundProfileId,
                };

                workspacePairs.set(pairKey, pair);
                _lastActivePairKey = pairKey;

                panel.webview.html = buildWorkspaceHtml(panel.webview, _extensionUri, queryText, pairKey);

                setupMessageHandlers(panel, pair, pairKey);
            },
        }),
    );
}

export async function openQueryWorkspace(connectionManager: ConnectionManager): Promise<void> {
    await createUnifiedWorkspace(connectionManager);
}

export async function insertTextIntoWorkspace(connectionManager: ConnectionManager, text: string): Promise<void> {
    let pair = getLastActivePair();
    if (!pair) {
        pair = await createUnifiedWorkspace(connectionManager);
    }
    sendToPair(pair, { type: 'insertText', text: '`' + text + '`' });
    pair.panel.reveal(vscode.ViewColumn.Active, false);
}

export async function makeQueryInWorkspace(connectionManager: ConnectionManager, tablePath: string, rawQuery?: boolean): Promise<void> {
    const query = rawQuery ? tablePath : `select * from \`${tablePath}\` `;
    let pair = getLastActivePair();
    if (!pair) {
        pair = await createUnifiedWorkspace(connectionManager, query);
        sendToPair(pair, { type: 'triggerExecute' });
    } else {
        sendToPair(pair, { type: 'setContent', content: query });
        pair.panel.reveal(vscode.ViewColumn.Active, false);
        sendToPair(pair, { type: 'triggerExecute' });
    }
}

export async function makeQueryInNewWorkspace(connectionManager: ConnectionManager, tablePath: string): Promise<void> {
    const query = `select * from \`${tablePath}\` `;
    const pair = await createUnifiedWorkspace(connectionManager, query);
    sendToPair(pair, { type: 'triggerExecute' });
}

export function executeQueryFromEditor(): void {
    const pair = getLastActivePair();
    if (!pair) {return;}
    sendToPair(pair, { type: 'triggerExecute' });
    pair.panel.reveal(vscode.ViewColumn.Active, false);
}

// ==================== Workspace creation ====================

function setupMessageHandlers(panel: vscode.WebviewPanel, pair: WorkspacePair, pairKey: string): void {
    panel.webview.onDidReceiveMessage(async (message) => {
        switch (message.type) {
            case 'executeQuery': {
                const query = (message.query as string || '').trim();
                if (!query) {break;}
                await handleExecuteQuery(pair, query, message.pageSize as number || 200);
                scheduleSaveWorkspaceStates();
                break;
            }
            case 'loadMoreRows':
                await handleLoadMoreRows(pair, message.offset as number, message.pageSize as number);
                break;
            case 'executeWithStats': {
                const query = (message.query as string || '').trim();
                if (!query) {break;}
                await handleExecuteWithStats(pair, query);
                scheduleSaveWorkspaceStates();
                break;
            }
            case 'explainQuery': {
                const query = (message.query as string || '').trim();
                if (!query) {break;}
                await handleExplainQuery(pair, query);
                scheduleSaveWorkspaceStates();
                break;
            }
            case 'loadAllRows':
                await handleLoadAllRows(pair);
                scheduleSaveWorkspaceStates();
                break;
            case 'cancelQuery':
                pairCancelQuery(pair);
                break;
            case 'savePng':
                await handleSavePng(message.dataUrl as string);
                break;
            case 'commitEdits':
                await executeCommitEdits(pair.connectionManager, message as unknown as CommitEditsMessage, (msg) => sendToPair(pair, msg));
                break;
            case 'completionRequest': {
                if (_completionProvider) {
                    const completionItems = await _completionProvider.getCompletionItemsForText(
                        message.text as string,
                        message.line as number,
                        message.column as number,
                    );
                    sendToPair(pair, {
                        type: 'completionResponse',
                        requestId: message.requestId,
                        items: completionItems.map(item => ({
                            label: typeof item.label === 'string' ? item.label : (item.label as { label: string }).label,
                            kind: item.kind ?? 0,
                            detail: item.detail,
                            insertText: typeof item.insertText === 'string' ? item.insertText : undefined,
                            sortText: item.sortText,
                        })),
                    });
                }
                break;
            }
            case 'contentChanged': {
                pair.currentQuery = message.text as string || '';
                scheduleSaveWorkspaceStates();
                break;
            }
            case 'webviewReady': {
                if (pair.cached && Object.keys(pair.cached).some(k => pair.cached[k as keyof CachedState] !== undefined)) {
                    replayCachedState(pair, pair.cached);
                }
                break;
            }
        }
    });

    panel.onDidChangeViewState((e) => {
        if (e.webviewPanel.active) {
            _lastActivePairKey = pairKey;
        }
        scheduleSaveWorkspaceStates();
    });

    panel.onDidDispose(() => {
        pairCancelQuery(pair);
        workspacePairs.delete(pairKey);
        if (_lastActivePairKey === pairKey) {
            _lastActivePairKey = undefined;
        }
        saveAllWorkspaceStates();
    });
}

async function createUnifiedWorkspace(connectionManager: ConnectionManager, initialContent?: string): Promise<WorkspacePair> {
    if (!_extensionUri) {throw new Error('Extension URI not initialized');}
    workspaceCounter++;
    const pairKey = `workspace-${workspaceCounter}`;

    const panel = vscode.window.createWebviewPanel(
        'ydbQueryWorkspace',
        `Query ${workspaceCounter}`,
        vscode.ViewColumn.Active,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [_extensionUri],
        },
    );

    const pair: WorkspacePair = {
        panel,
        connectionManager,
        cachedColumns: [],
        currentQuery: initialContent || '',
        cancellation: undefined,
        cached: {},
        boundConnectionProfileId: connectionManager.getFocusedProfileId(),
    };

    workspacePairs.set(pairKey, pair);
    _lastActivePairKey = pairKey;

    panel.webview.html = buildWorkspaceHtml(panel.webview, _extensionUri, initialContent, pairKey);

    setupMessageHandlers(panel, pair, pairKey);
    scheduleSaveWorkspaceStates();

    return pair;
}

// ==================== Query handlers ====================

async function handleExecuteQuery(pair: WorkspacePair, query: string, pageSize: number): Promise<void> {
    const token = pairCreateToken(pair);
    try {
        sendToPair(pair, { type: 'loading', tab: 'results', loading: true });
        pair.currentQuery = query;
        const driver = await pair.connectionManager.getDriver(pair.boundConnectionProfileId);
        const qs = new QueryService(driver);
        const result = await qs.executePagedQuery(query, pageSize + 1, 0, token);
        pair.cachedColumns = result.columns;
        const hasMore = result.rows.length > pageSize;
        const rows = hasMore ? result.rows.slice(0, pageSize) : result.rows;

        let tablePath: string | undefined;
        let primaryKeys: string[] | undefined;
        const extractedPath = extractTablePath(query);
        if (extractedPath) {
            try {
                const db = driver.database.endsWith('/') ? driver.database.slice(0, -1) : driver.database;
                const fullPath = extractedPath.startsWith('/')
                    ? extractedPath
                    : db + '/' + extractedPath;
                const desc = await qs.describeTable(fullPath);
                if (desc.primaryKeys.length > 0) {
                    tablePath = extractedPath;
                    primaryKeys = desc.primaryKeys;
                }
            } catch { /* editing not available */ }
        }

        const msg = {
            type: 'queryResult',
            columns: pair.cachedColumns,
            rows,
            totalRows: rows.length,
            hasMore,
            tablePath,
            primaryKeys,
        };
        pair.cached.queryResult = msg;
        sendToPair(pair, msg);
    } catch (err: unknown) {
        if (err instanceof CancellationError) {
            sendToPair(pair, { type: 'cancelled' });
            return;
        }
        const errMsg = err instanceof Error ? err.message : String(err);
        sendToPair(pair, { type: 'error', message: errMsg });
    } finally {
        pairCleanupCancellation(pair);
        sendToPair(pair, { type: 'loading', tab: 'results', loading: false });
    }
}

async function handleLoadMoreRows(pair: WorkspacePair, offset: number, pageSize: number): Promise<void> {
    if (!pair.currentQuery) {return;}
    try {
        const driver = await pair.connectionManager.getDriver(pair.boundConnectionProfileId);
        const qs = new QueryService(driver);
        const result = await qs.executePagedQuery(pair.currentQuery, pageSize + 1, offset);
        const hasMore = result.rows.length > pageSize;
        const rows = hasMore ? result.rows.slice(0, pageSize) : result.rows;
        sendToPair(pair, { type: 'moreRows', rows, offset, hasMore });
    } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        sendToPair(pair, { type: 'error', message: errMsg });
    }
}

async function handleLoadAllRows(pair: WorkspacePair): Promise<void> {
    if (!pair.currentQuery) {return;}
    const token = pairCreateToken(pair);
    try {
        sendToPair(pair, { type: 'loading', tab: 'chart', loading: true });
        const maxRows = vscode.workspace.getConfiguration('ydb').get<number>('maxChartRows', 50000);
        const driver = await pair.connectionManager.getDriver(pair.boundConnectionProfileId);
        const qs = new QueryService(driver);
        const result = await qs.executePagedQuery(pair.currentQuery, maxRows + 1, 0, token);
        const truncated = result.rows.length > maxRows;
        const rows = truncated ? result.rows.slice(0, maxRows) : result.rows;
        const msg = { type: 'allRows', columns: result.columns, rows, truncated, maxRows };
        pair.cached.allRows = msg;
        sendToPair(pair, msg);
    } catch (err: unknown) {
        if (err instanceof CancellationError) {
            sendToPair(pair, { type: 'cancelled' });
            return;
        }
        const errMsg = err instanceof Error ? err.message : String(err);
        sendToPair(pair, { type: 'error', message: errMsg });
    } finally {
        pairCleanupCancellation(pair);
        sendToPair(pair, { type: 'loading', tab: 'chart', loading: false });
    }
}

async function handleExecuteWithStats(pair: WorkspacePair, query: string): Promise<void> {
    const token = pairCreateToken(pair);
    try {
        sendToPair(pair, { type: 'loading', tab: 'statistics', loading: true });
        const driver = await pair.connectionManager.getDriver(pair.boundConnectionProfileId);
        const qs = new QueryService(driver);
        const { result, stats } = await qs.executeWithStats(query, token);
        pair.cachedColumns = result.columns;

        let svgContent: string | undefined;
        const profile = pair.connectionManager.getActiveProfile();
        if (stats.planJson && profile) {
            const monUrl = getMonitoringUrl(profile);
            if (monUrl) {
                try {
                    const authToken = extractAuthToken(profile);
                    svgContent = await fetchPlanSvg(monUrl, stats.planJson, authToken);
                } catch { /* ignore */ }
            }
        }

        let parsedPlan: Record<string, unknown> | undefined;
        if (stats.planJson) {
            console.log('[YDB] stats.planJson length:', stats.planJson.length, 'has A-Cpu:', stats.planJson.includes('A-Cpu'), 'has A-Rows:', stats.planJson.includes('A-Rows'));
            try {
                const parsed = JSON.parse(stats.planJson);
                parsedPlan = parsePlanRoot(parsed) as unknown as Record<string, unknown>;
            } catch { /* ignore */ }
        }
        const msg: Record<string, unknown> = { type: 'statsResult', stats, svgContent, result: { columns: result.columns, rows: result.rows, rowCount: result.rows.length } };
        pair.cached.statsResult = msg;
        sendToPair(pair, msg);
        if (parsedPlan) {
            const explainMsg = { type: 'explainResult', plan: parsedPlan, rawJson: stats.planJson };
            pair.cached.explainResult = explainMsg;
            sendToPair(pair, explainMsg);
        }
    } catch (err: unknown) {
        if (err instanceof CancellationError) {
            sendToPair(pair, { type: 'cancelled' });
            return;
        }
        const errMsg = err instanceof Error ? err.message : String(err);
        sendToPair(pair, { type: 'error', message: errMsg });
    } finally {
        pairCleanupCancellation(pair);
        sendToPair(pair, { type: 'loading', tab: 'statistics', loading: false });
    }
}

async function handleExplainQuery(pair: WorkspacePair, query: string): Promise<void> {
    const token = pairCreateToken(pair);
    try {
        sendToPair(pair, { type: 'loading', tab: 'plan', loading: true });
        const driver = await pair.connectionManager.getDriver(pair.boundConnectionProfileId);
        const qs = new QueryService(driver);
        const result = await qs.explainQuery(query, token);
        const msg = { type: 'explainResult', plan: result.plan, rawJson: result.rawJson };
        pair.cached.explainResult = msg;
        sendToPair(pair, msg);
    } catch (err: unknown) {
        if (err instanceof CancellationError) {
            sendToPair(pair, { type: 'cancelled' });
            return;
        }
        const errMsg = err instanceof Error ? err.message : String(err);
        sendToPair(pair, { type: 'error', message: errMsg });
    } finally {
        pairCleanupCancellation(pair);
        sendToPair(pair, { type: 'loading', tab: 'plan', loading: false });
    }
}

async function handleSavePng(dataUrl: string): Promise<void> {
    const uri = await vscode.window.showSaveDialog({
        filters: { 'PNG Image': ['png'] },
        defaultUri: vscode.Uri.file('chart.png'),
    });
    if (uri) {
        const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
        await vscode.workspace.fs.writeFile(uri, Buffer.from(base64, 'base64'));
        vscode.window.showInformationMessage(`Chart saved to ${uri.fsPath}`);
    }
}

// ==================== Table editing ====================

const PRIMITIVE_TYPE_MAP: Record<string, Type_PrimitiveTypeId> = {
    'bool': Type_PrimitiveTypeId.BOOL,
    'int8': Type_PrimitiveTypeId.INT8,
    'int16': Type_PrimitiveTypeId.INT16,
    'int32': Type_PrimitiveTypeId.INT32,
    'int64': Type_PrimitiveTypeId.INT64,
    'uint8': Type_PrimitiveTypeId.UINT8,
    'uint16': Type_PrimitiveTypeId.UINT16,
    'uint32': Type_PrimitiveTypeId.UINT32,
    'uint64': Type_PrimitiveTypeId.UINT64,
    'float': Type_PrimitiveTypeId.FLOAT,
    'double': Type_PrimitiveTypeId.DOUBLE,
    'string': Type_PrimitiveTypeId.STRING,
    'utf8': Type_PrimitiveTypeId.UTF8,
    'date': Type_PrimitiveTypeId.DATE,
    'datetime': Type_PrimitiveTypeId.DATETIME,
    'timestamp': Type_PrimitiveTypeId.TIMESTAMP,
    'json': Type_PrimitiveTypeId.JSON,
    'jsondocument': Type_PrimitiveTypeId.JSON_DOCUMENT,
    'yson': Type_PrimitiveTypeId.YSON,
};

function createValue(init: Parameters<typeof create>[1]): Value {
    return create(ValueSchema, init) as Value;
}
function createType(init: Parameters<typeof create>[1]): Type {
    return create(TypeSchema, init) as Type;
}
function createTypedValue(init: Parameters<typeof create>[1]): TypedValue {
    return create(TypedValueSchema, init) as TypedValue;
}

function buildTypedValue(value: string, colType: string): TypedValue {
    const isOptional = /^Optional<(.+)>$/i.test(colType);
    const baseType = colType.replace(/^Optional<(.+)>$/i, '$1');
    const baseLower = baseType.toLowerCase();

    const primitiveId = PRIMITIVE_TYPE_MAP[baseLower];
    if (!primitiveId) {
        const innerType = createType({ type: { case: 'typeId', value: Type_PrimitiveTypeId.UTF8 } });
        const type = isOptional
            ? createType({ type: { case: 'optionalType', value: { item: innerType } } })
            : innerType;
        return createTypedValue({ type, value: createValue({ value: { case: 'textValue', value } }) });
    }

    const innerType = createType({ type: { case: 'typeId', value: primitiveId } });
    const type = isOptional
        ? createType({ type: { case: 'optionalType', value: { item: innerType } } })
        : innerType;

    let ydbValue: Value;
    switch (baseLower) {
        case 'bool':
            ydbValue = createValue({ value: { case: 'boolValue', value: value.toLowerCase() === 'true' } });
            break;
        case 'int8': case 'int16': case 'int32':
            ydbValue = createValue({ value: { case: 'int32Value', value: parseInt(value, 10) } });
            break;
        case 'uint8': case 'uint16': case 'uint32':
            ydbValue = createValue({ value: { case: 'uint32Value', value: parseInt(value, 10) } });
            break;
        case 'int64':
            ydbValue = createValue({ value: { case: 'int64Value', value: BigInt(value) } });
            break;
        case 'uint64':
            ydbValue = createValue({ value: { case: 'uint64Value', value: BigInt(value) } });
            break;
        case 'float':
            ydbValue = createValue({ value: { case: 'floatValue', value: parseFloat(value) } });
            break;
        case 'double':
            ydbValue = createValue({ value: { case: 'doubleValue', value: parseFloat(value) } });
            break;
        case 'string':
            ydbValue = createValue({ value: { case: 'bytesValue', value: new Uint8Array(Buffer.from(value)) } });
            break;
        case 'date':
            ydbValue = createValue({ value: { case: 'uint32Value', value: isFinite(Number(value))
                ? Number(value)
                : Math.floor(new Date(value).getTime() / 86400000) } });
            break;
        case 'datetime':
            ydbValue = createValue({ value: { case: 'uint32Value', value: isFinite(Number(value))
                ? Number(value)
                : Math.floor(new Date(value).getTime() / 1000) } });
            break;
        case 'timestamp':
            ydbValue = createValue({ value: { case: 'uint64Value', value: BigInt(isFinite(Number(value))
                ? Number(value)
                : new Date(value).getTime() * 1000) } });
            break;
        default:
            ydbValue = createValue({ value: { case: 'textValue', value } });
            break;
    }

    if (isOptional) {
        ydbValue = createValue({ value: { case: 'nestedValue', value: ydbValue } });
    }

    return createTypedValue({ type, value: ydbValue });
}

async function executeCommitEdits(
    cm: ConnectionManager,
    message: CommitEditsMessage,
    sendMessage: (msg: Record<string, unknown>) => void,
): Promise<void> {
    try {
        sendMessage({ type: 'loading', tab: 'results', loading: true });
        const driver = await cm.getDriver();
        const qs = new QueryService(driver);

        const rowEdits = new Map<number, EditEntry[]>();
        for (const edit of message.edits) {
            const existing = rowEdits.get(edit.rowIdx) ?? [];
            existing.push(edit);
            rowEdits.set(edit.rowIdx, existing);
        }

        const statements: string[] = [];
        const parameters: Record<string, TypedValue> = {};
        let paramIdx = 0;

        for (const [, edits] of rowEdits) {
            const setClauses = edits.map(e => {
                const paramName = `$p${paramIdx++}`;
                parameters[paramName] = buildTypedValue(e.newValue, e.colType);
                return `\`${e.colName}\` = ${paramName}`;
            }).join(', ');

            const pkValues = edits[0].pkValues;
            const whereClauses = Object.entries(pkValues).map(([k, v]) => {
                const paramName = `$p${paramIdx++}`;
                const strVal = v === null || v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
                parameters[paramName] = buildTypedValue(strVal, message.columnTypes[k] ?? 'Utf8');
                return `\`${k}\` = ${paramName}`;
            }).join(' AND ');

            statements.push(`UPDATE \`${message.tablePath}\` SET ${setClauses} WHERE ${whereClauses}`);
        }

        const fullQuery = statements.join(';\n');
        console.log('[YDB Edit] Commit query:', fullQuery, 'params:', Object.keys(parameters));
        await qs.executeQuery(fullQuery, undefined, parameters);
        sendMessage({ type: 'commitResult', success: true });
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        sendMessage({ type: 'commitResult', success: false, error: msg });
    } finally {
        sendMessage({ type: 'loading', tab: 'results', loading: false });
    }
}

// ==================== Utilities ====================

export function extractTablePath(query: string): string | undefined {
    const normalized = query.replace(/\s+/g, ' ').trim();
    if (/\bjoin\b/i.test(normalized) || /\(\s*select\b/i.test(normalized)) {
        return undefined;
    }
    const m = normalized.match(/\bfrom\s+`([^`]+)`/i) || normalized.match(/\bfrom\s+([^\s,;()]+)/i);
    return m ? m[1] : undefined;
}

// ==================== HTML builder ====================

function buildWorkspaceHtml(webview: vscode.Webview, extensionUri: vscode.Uri, initialContent?: string, pairKey?: string): string {
    const vsBaseUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out', 'monaco', 'vs')).toString();
    const monacoTheme = getMonacoTheme();
    const nonce = generateNonce();
    const csp = webview.cspSource;
    const escapedContent = JSON.stringify(initialContent || '');
    const escapedPairKey = JSON.stringify(pairKey || '');

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${csp} data: blob:; script-src ${csp} 'nonce-${nonce}'; style-src ${csp} 'unsafe-inline'; worker-src blob: ${csp}; font-src ${csp} data:;">
<link rel="stylesheet" href="${vsBaseUri}/editor/editor.main.css">
<style>
${getStyles()}
</style>
</head>
<body>
    <div class="unified-container">
        <div id="editorPane" class="editor-pane">
            <div id="monacoContainer"></div>
        </div>
        <div id="splitHandle" class="split-handle"></div>
        <div id="resultsPane" class="results-pane">
            <div class="toolbar">
                <button id="btnRun" class="btn btn-primary" title="Execute Query (Ctrl+Enter)">&#9654; Run</button>
                <button id="btnStats" class="btn" title="Run with Statistics">&#128202; Statistics</button>
                <button id="btnPlan" class="btn" title="Explain Query">&#128203; Plan</button>
                <div class="toolbar-spacer"></div>
                <label class="page-size-label">Page size:
                    <input type="number" id="pageSize" value="200" min="10" max="10000" step="10">
                </label>
                <label class="decode-string-label">
                    <input type="checkbox" id="decodeString" checked> Decode string
                </label>
            </div>
            <div class="tabs">
                <button class="tab active" data-tab="results" id="tabResults">Results</button>
                <button class="tab" data-tab="statistics" id="tabStatistics" style="display:none;">Statistics</button>
                <button class="tab" data-tab="plan" id="tabPlan" style="display:none;">Plan</button>
                <button class="tab" data-tab="chart" id="tabChart">Chart</button>
            </div>
            <div class="tab-content">
                <div id="tab-results" class="tab-panel active">
                    <div class="results-toolbar">
                        <div id="resultsInfo" class="info-bar"></div>
                        <button id="btnEdit" class="btn btn-edit" style="display:none;" title="Edit cells">&#9998; Edit</button>
                    </div>
                    <div id="editBar" class="edit-bar" style="display:none;">
                        <span id="editCount" class="edit-count"></span>
                        <button id="btnCommit" class="btn btn-primary">Commit</button>
                        <button id="btnDiscard" class="btn btn-danger">Discard</button>
                        <button id="btnCancelEdit" class="btn">Cancel editing</button>
                    </div>
                    <div id="resultsContainer" class="results-scroll">
                        <table id="resultsTable"><thead></thead><tbody></tbody></table>
                    </div>
                    <div id="loadingMore" class="loading-more" style="display:none;">Loading more rows...</div>
                </div>
                <div id="tab-statistics" class="tab-panel" style="display:none;">
                    <div id="statsContent"></div>
                </div>
                <div id="tab-plan" class="tab-panel" style="display:none;">
                    <div class="plan-sub-tabs">
                        <button class="plan-sub-tab active" data-plan-tab="graph">Graph</button>
                        <button class="plan-sub-tab" data-plan-tab="table">Table</button>
                        <button class="plan-sub-tab" data-plan-tab="json">JSON</button>
                    </div>
                    <div id="planView-graph" class="plan-view-panel">
                        <div class="plan-graph-toolbar">
                            <button id="planZoomIn" class="plan-toolbar-btn" title="Zoom In">+</button>
                            <button id="planZoomOut" class="plan-toolbar-btn" title="Zoom Out">&minus;</button>
                            <button id="planFitView" class="plan-toolbar-btn" title="Fit to View">Fit</button>
                            <span id="planZoomLabel" class="plan-zoom-label">100%</span>
                        </div>
                        <div id="planContainer" class="plan-container">
                            <div id="planSvgWrap" class="plan-svg-wrap" tabindex="0">
                                <svg id="planSvg"></svg>
                            </div>
                            <div id="planProperties" class="plan-properties"></div>
                        </div>
                    </div>
                    <div id="planView-table" class="plan-view-panel" style="display:none;">
                        <div class="plan-table-container">
                            <table id="planTable" class="plan-tree-table">
                                <thead>
                                    <tr>
                                        <th class="plan-col-op">Operation</th>
                                        <th class="plan-col-metric">A-Cpu</th>
                                        <th class="plan-col-metric">A-Rows</th>
                                        <th class="plan-col-metric">E-Cost</th>
                                        <th class="plan-col-metric">E-Rows</th>
                                        <th class="plan-col-metric">E-Size</th>
                                    </tr>
                                </thead>
                                <tbody id="planTableBody"></tbody>
                            </table>
                        </div>
                    </div>
                    <div id="planView-json" class="plan-view-panel" style="display:none;">
                        <div class="plan-json-toolbar">
                            <button id="planJsonExpandAll" class="plan-toolbar-btn">Expand All</button>
                            <button id="planJsonCollapseAll" class="plan-toolbar-btn">Collapse All</button>
                            <button id="planJsonCopy" class="plan-toolbar-btn">Copy</button>
                        </div>
                        <div id="planJsonContainer" class="plan-json-container"></div>
                    </div>
                </div>
                <div id="tab-chart" class="tab-panel" style="display:none;">
                    <div id="chartInfo" class="chart-info" style="display:none;"></div>
                    <div class="chart-controls">
                        <label>Type: <select id="chartType"><option value="pie">Pie Chart</option><option value="line">Line Chart</option></select></label>
                        <label>X / Names: <select id="chartX"></select></label>
                        <label>Y / Values: <select id="chartY"></select></label>
                        <button id="btnBuildChart" class="btn btn-primary">Build Chart</button>
                        <button id="btnExportChart" class="btn">Export PNG</button>
                    </div>
                    <canvas id="chartCanvas" width="800" height="500"></canvas>
                </div>
            </div>
        </div>
    </div>
    <div id="globalLoading" class="global-loading" style="display:none;">
        <div class="loading-content">
            <div class="spinner"></div>
            <button id="btnCancel" class="btn cancel-btn">Cancel</button>
        </div>
    </div>
    <div id="cellModal" class="cell-modal-overlay">
        <div class="cell-modal">
            <div class="cell-modal-header">
                <span>Cell content</span>
                <button id="cellModalCloseX" class="cell-modal-x">&times;</button>
            </div>
            <pre id="cellModalContent" class="cell-modal-body"></pre>
            <div class="cell-modal-footer">
                <button id="cellModalCopy" class="btn btn-primary">Copy</button>
                <button id="cellModalClose" class="btn">Close</button>
            </div>
        </div>
    </div>
<script nonce="${nonce}">
window.MonacoEnvironment = {
    getWorker: function() {
        var blob = new Blob(['self.onmessage=function(){}'], { type: 'text/javascript' });
        return new Worker(URL.createObjectURL(blob));
    }
};
var require = { paths: { 'vs': '${vsBaseUri}' } };
</script>
<script nonce="${nonce}" src="${vsBaseUri}/loader.js"></script>
<script nonce="${nonce}">
${getScript(escapedContent, monacoTheme, escapedPairKey)}
</script>
</body>
</html>`;
}

// ==================== CSS ====================

function getStyles(): string {
    return `
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
    font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    display: flex; flex-direction: column; height: 100vh; overflow: hidden;
}
.unified-container { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-height: 0; }
.editor-pane { height: 35%; min-height: 60px; overflow: hidden; position: relative; flex-shrink: 0; }
#monacoContainer { position: absolute; top: 0; left: 0; right: 0; bottom: 0; }
.split-handle { height: 5px; cursor: row-resize; flex-shrink: 0; background: var(--vscode-panel-border, #333); }
.split-handle:hover { background: var(--vscode-focusBorder, #007fd4); }
.results-pane { flex: 1; overflow: hidden; display: flex; flex-direction: column; min-height: 0; }
.toolbar {
    display: flex; align-items: center; gap: 6px; padding: 8px 12px;
    background: var(--vscode-titleBar-activeBackground, var(--vscode-editor-background));
    border-bottom: 1px solid var(--vscode-panel-border, #333); flex-shrink: 0;
}
.toolbar-spacer { flex: 1; }
.btn {
    padding: 4px 12px; border: 1px solid var(--vscode-button-border, var(--vscode-panel-border, #555));
    background: var(--vscode-button-secondaryBackground, #333); color: var(--vscode-button-secondaryForeground, #ccc);
    border-radius: 4px; cursor: pointer; font-size: 12px; white-space: nowrap;
}
.btn:hover { background: var(--vscode-button-secondaryHoverBackground, #444); }
.btn-primary {
    background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff);
    border-color: var(--vscode-button-background, #0e639c);
}
.btn-primary:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
.page-size-label, .decode-string-label { font-size: 12px; color: var(--vscode-descriptionForeground); display: flex; align-items: center; gap: 4px; }
.page-size-label input {
    width: 70px; padding: 2px 4px; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, #555); border-radius: 3px;
}
.tabs {
    display: flex; gap: 0; padding: 0 12px;
    border-bottom: 1px solid var(--vscode-panel-border, #333); flex-shrink: 0;
}
.tab {
    padding: 6px 16px; background: none; border: none; border-bottom: 2px solid transparent;
    color: var(--vscode-foreground); cursor: pointer; font-size: 12px; opacity: 0.7;
}
.tab:hover { opacity: 1; }
.tab.active { opacity: 1; border-bottom-color: var(--vscode-focusBorder, #007fd4); }
.tab-content { flex: 1; overflow: hidden; position: relative; min-height: 0; }
.tab-panel { height: 100%; overflow: auto; padding: 8px 12px; }
.info-bar { font-size: 12px; color: var(--vscode-descriptionForeground); padding: 4px 0; }
.results-scroll { overflow: auto; max-height: calc(100% - 30px); }
table { border-collapse: collapse; width: 100%; font-size: 12px; }
th, td {
    border: 1px solid var(--vscode-panel-border, #333); padding: 3px 8px;
    text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
td { max-width: 300px; }
th {
    background: var(--vscode-editor-selectionBackground); position: sticky; top: 0; z-index: 1;
    cursor: pointer; user-select: none;
}
th:hover { background: var(--vscode-list-hoverBackground); }
.resize-line { position: fixed; top: 0; width: 2px; height: 100vh; background: var(--vscode-focusBorder, #007fd4); z-index: 1000; pointer-events: none; display: none; }
th .col-type { font-size: 10px; color: var(--vscode-descriptionForeground); font-weight: normal; }
tr:nth-child(even) { background: var(--vscode-list-hoverBackground); }
.null-val { color: var(--vscode-descriptionForeground); font-style: italic; }
.cell-expandable { cursor: pointer; }
.cell-expandable:hover { background: var(--vscode-list-hoverBackground); }
.cell-modal-overlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 200; justify-content: center; align-items: center; }
.cell-modal-overlay.visible { display: flex; }
.cell-modal { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border, #444); border-radius: 6px; width: 80%; max-width: 800px; max-height: 80vh; display: flex; flex-direction: column; box-shadow: 0 8px 32px rgba(0,0,0,0.4); }
.cell-modal-header { display: flex; justify-content: space-between; align-items: center; padding: 10px 16px; border-bottom: 1px solid var(--vscode-panel-border, #333); font-weight: 600; }
.cell-modal-x { background: none; border: none; color: var(--vscode-foreground); font-size: 20px; cursor: pointer; padding: 0 4px; line-height: 1; }
.cell-modal-x:hover { color: var(--vscode-errorForeground); }
.cell-modal-body { flex: 1; overflow: auto; padding: 16px; margin: 0; font-family: var(--vscode-editor-font-family, monospace); font-size: 13px; white-space: pre-wrap; word-break: break-all; line-height: 1.5; user-select: text; }
.cell-modal-footer { display: flex; gap: 8px; justify-content: flex-end; padding: 10px 16px; border-top: 1px solid var(--vscode-panel-border, #333); }
.hl-key { color: var(--vscode-symbolIcon-propertyForeground, #9cdcfe); }
.hl-string { color: var(--vscode-debugTokenExpression-string, #ce9178); }
.hl-number { color: var(--vscode-debugTokenExpression-number, #b5cea8); }
.hl-keyword { color: var(--vscode-debugTokenExpression-boolean, #569cd6); }
.loading-more { text-align: center; padding: 8px; color: var(--vscode-descriptionForeground); font-size: 12px; }
.global-loading {
    position: absolute; top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.3); display: flex; align-items: center; justify-content: center; z-index: 100;
}
.loading-content { display: flex; flex-direction: column; align-items: center; gap: 16px; }
.spinner {
    width: 32px; height: 32px; border: 3px solid var(--vscode-foreground);
    border-top-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite;
}
.cancel-btn {
    padding: 6px 20px; font-size: 13px;
    background: var(--vscode-button-secondaryBackground, #333); color: var(--vscode-button-secondaryForeground, #ccc);
    border: 1px solid var(--vscode-button-border, var(--vscode-panel-border, #555));
    border-radius: 4px; cursor: pointer;
}
.cancel-btn:hover { background: var(--vscode-button-secondaryHoverBackground, #444); }
@keyframes spin { to { transform: rotate(360deg); } }
.stats-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-bottom: 16px; }
.stat-card { background: var(--vscode-editor-selectionBackground); border-radius: 8px; padding: 16px; }
.stat-card .label { font-size: 12px; color: var(--vscode-descriptionForeground); }
.stat-card .value { font-size: 28px; font-weight: bold; margin-top: 4px; }
.stat-card .unit { font-size: 14px; color: var(--vscode-descriptionForeground); }
.stats-plan-json {
    background: var(--vscode-textBlockQuote-background); border-radius: 4px;
    padding: 8px; font-family: monospace; font-size: 12px; max-height: 300px; overflow: auto;
    white-space: pre-wrap; word-break: break-all;
}
.stats-plan-svg {
    overflow: auto; border: 1px solid var(--vscode-panel-border, #333); border-radius: 4px;
    background: #f9fafb; max-height: 600px; padding: 8px;
}
.stats-plan-svg svg { max-width: 100%; height: auto; display: block; }
.stats-plan-toggle { display: inline-flex; gap: 0; margin: 12px 0 8px; }
.stats-plan-toggle button {
    padding: 4px 12px; border: 1px solid var(--vscode-panel-border, #555);
    background: var(--vscode-button-secondaryBackground, #333); color: var(--vscode-button-secondaryForeground, #ccc);
    cursor: pointer; font-size: 12px;
}
.stats-plan-toggle button:first-child { border-radius: 4px 0 0 4px; }
.stats-plan-toggle button:last-child { border-radius: 0 4px 4px 0; }
.stats-plan-toggle button.active {
    background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff);
    border-color: var(--vscode-button-background, #0e639c);
}
.plan-sub-tabs { display: inline-flex; gap: 0; margin: 8px 0; }
.plan-sub-tab {
    padding: 4px 12px; border: 1px solid var(--vscode-panel-border, #555);
    background: var(--vscode-button-secondaryBackground, #333); color: var(--vscode-button-secondaryForeground, #ccc);
    cursor: pointer; font-size: 12px;
}
.plan-sub-tab:first-child { border-radius: 4px 0 0 4px; }
.plan-sub-tab:last-child { border-radius: 0 4px 4px 0; }
.plan-sub-tab.active {
    background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff);
    border-color: var(--vscode-button-background, #0e639c);
}
.plan-view-panel { height: calc(100% - 40px); }
.plan-graph-toolbar { display: flex; align-items: center; gap: 4px; padding: 4px 0; }
.plan-toolbar-btn {
    padding: 2px 8px; font-size: 12px; border: 1px solid var(--vscode-panel-border, #555);
    background: var(--vscode-button-secondaryBackground, #333); color: var(--vscode-button-secondaryForeground, #ccc);
    border-radius: 3px; cursor: pointer;
}
.plan-toolbar-btn:hover { background: var(--vscode-button-secondaryHoverBackground, #444); }
.plan-zoom-label { font-size: 11px; color: var(--vscode-descriptionForeground); margin-left: 4px; }
.plan-container { display: flex; height: calc(100% - 30px); gap: 0; }
.plan-svg-wrap { flex: 1; min-width: 0; overflow: auto; background: #f9fafb; position: relative; outline: none; }
#planSvg { display: block; transform-origin: 0 0; }
.plan-properties {
    width: 300px; overflow: auto; border-left: 1px solid var(--vscode-panel-border, #333);
    padding: 12px; font-size: 12px; flex-shrink: 0;
}
.plan-properties h3 { margin-bottom: 8px; font-size: 13px; border-bottom: 1px solid var(--vscode-panel-border, #333); padding-bottom: 6px; }
.plan-prop-row { display: flex; gap: 8px; padding: 3px 0; border-bottom: 1px solid var(--vscode-panel-border, #222); }
.plan-prop-key { color: var(--vscode-symbolIcon-propertyForeground, #9cdcfe); min-width: 100px; flex-shrink: 0; }
.plan-prop-val { word-break: break-all; flex: 1; }
.plan-prop-expandable { cursor: pointer; }
.plan-prop-expandable:hover { color: var(--vscode-textLink-foreground, #3794ff); }
.plan-prop-expanded { white-space: pre-wrap; max-height: 200px; overflow: auto; }
.plan-table-container { overflow: auto; height: 100%; }
.plan-tree-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.plan-tree-table th {
    position: sticky; top: 0; z-index: 1;
    background: var(--vscode-editor-selectionBackground, #264f78); padding: 6px 8px;
    text-align: left; font-weight: 600; border-bottom: 2px solid var(--vscode-panel-border, #555);
}
.plan-col-op { min-width: 250px; }
.plan-col-metric { min-width: 80px; text-align: right; }
.plan-tree-table td { padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border, #222); vertical-align: top; }
.plan-tree-table td.metric-cell { text-align: right; font-family: monospace; }
.plan-tree-table tr:hover { background: var(--vscode-list-hoverBackground); }
.plan-tree-table tr.plan-row-collapsed { display: none; }
.plan-op-toggle { cursor: pointer; user-select: none; margin-right: 4px; display: inline-block; width: 14px; }
.plan-op-name { font-weight: 600; }
.plan-op-table { color: #4a9cd6; font-size: 11px; display: block; }
.plan-op-operators { color: #6a9955; font-size: 11px; display: block; }
.plan-json-toolbar { display: flex; align-items: center; gap: 4px; padding: 4px 0; }
.plan-json-container {
    overflow: auto; height: calc(100% - 30px); font-family: monospace; font-size: 12px;
    background: var(--vscode-textBlockQuote-background, #222); border-radius: 4px; padding: 8px;
    white-space: pre; line-height: 1.5;
}
.json-key { color: #9cdcfe; }
.json-string { color: #ce9178; }
.json-number { color: #b5cea8; }
.json-bool { color: #569cd6; }
.json-null { color: #808080; }
.json-bracket { color: var(--vscode-foreground, #ccc); }
.json-toggle { cursor: pointer; user-select: none; }
.json-toggle:hover { color: var(--vscode-textLink-foreground, #3794ff); }
.json-collapsed-info { color: var(--vscode-descriptionForeground, #888); font-style: italic; }
.plan-tooltip {
    position: fixed; background: var(--vscode-editorHoverWidget-background, #252526);
    border: 1px solid var(--vscode-editorHoverWidget-border, #454545);
    padding: 6px 10px; border-radius: 4px; font-size: 12px; z-index: 1000;
    pointer-events: none; max-width: 300px; box-shadow: 0 2px 8px rgba(0,0,0,0.4);
}
.plan-tooltip-title { font-weight: bold; margin-bottom: 2px; }
.plan-tooltip-detail { color: var(--vscode-descriptionForeground); font-size: 11px; }
.chart-controls { display: flex; gap: 12px; align-items: center; padding: 8px 0; flex-wrap: wrap; }
.chart-controls label { font-size: 12px; display: flex; align-items: center; gap: 4px; }
.chart-controls select {
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, #555); border-radius: 3px; padding: 2px 4px;
}
#chartCanvas { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border, #333); border-radius: 4px; max-width: 100%; }
.chart-info {
    font-size: 12px; padding: 6px 10px; border-radius: 4px; margin-bottom: 8px;
    background: var(--vscode-inputValidation-warningBackground, #352a05);
    color: var(--vscode-inputValidation-warningForeground, #cca700);
    border: 1px solid var(--vscode-inputValidation-warningBorder, #cca700);
}
.results-toolbar { display: flex; align-items: center; gap: 8px; }
.results-toolbar .info-bar { flex: 1; }
.btn-edit { font-size: 12px; padding: 2px 8px; }
.edit-bar { display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 12px; }
.edit-count { color: var(--vscode-descriptionForeground); }
.btn-danger {
    background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
    color: var(--vscode-errorForeground, #f48771);
    border-color: var(--vscode-inputValidation-errorBorder, #be1100);
}
.btn-danger:hover { opacity: 0.9; }
td.cell-edited { background: var(--vscode-diffEditor-insertedTextBackground, rgba(155, 185, 85, 0.2)); }
td.cell-editable { cursor: text; }
td.cell-editable:hover { background: var(--vscode-list-hoverBackground); }
td.cell-pk { color: var(--vscode-descriptionForeground); }
th.col-pk { color: var(--vscode-symbolIcon-keywordForeground, #d19a66); }
.cell-inline-input {
    width: 100%; padding: 1px 4px; margin: -2px -4px;
    font-family: var(--vscode-editor-font-family, monospace); font-size: 12px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-focusBorder, #007fd4); border-radius: 2px;
    outline: none; box-sizing: border-box;
}
`;
}

// ==================== Webview JavaScript ====================

function getScript(escapedInitialContent: string, monacoTheme: string, escapedPairKey: string): string {
    return `
var vscode = acquireVsCodeApi();

// Persist pairKey for WebviewPanelSerializer
var _pairKey = ${escapedPairKey};
if (_pairKey) { vscode.setState({ pairKey: _pairKey }); }

// State
var currentTab = 'results';
var allColumns = [];
var displayedRowCount = 0;
var totalRowCount = 0;
var hasMoreRows = false;
var isLoadingMore = false;
var sortCol = -1;
var sortAsc = true;
var chartRows = [];
var chartColumns = [];
var chartDataLoaded = false;
var pendingBuildChart = false;
var lastQueryId = 0;
var allDisplayedRows = [];
var editMode = false;
var pendingEdits = {};
var tablePrimaryKeys = [];
var currentTablePath = '';
var columnTypeMap = {};
var pendingContent = null;
var pendingTriggerExecute = false;
var cellFullValues = [];
var completionRequestId = 0;
var pendingCompletionRequests = new Map();

// DOM refs
var resultsTable = document.getElementById('resultsTable');
var resultsContainer = document.getElementById('resultsContainer');
var resultsInfo = document.getElementById('resultsInfo');
var loadingMore = document.getElementById('loadingMore');
var globalLoading = document.getElementById('globalLoading');
var pageSizeInput = document.getElementById('pageSize');
var decodeStringCheckbox = document.getElementById('decodeString');
var btnEdit = document.getElementById('btnEdit');
var editBar = document.getElementById('editBar');
var editCount = document.getElementById('editCount');
var btnCommit = document.getElementById('btnCommit');
var btnDiscard = document.getElementById('btnDiscard');
var btnCancelEdit = document.getElementById('btnCancelEdit');

function isStringType(typeName) {
    if (!typeName) return false;
    var t = typeName.replace(/^Optional<(.+)>$/i, '$1').toLowerCase();
    return t === 'string' || t === 'yson';
}

function decodeBase64(str) {
    try { return decodeURIComponent(Array.from(atob(str), function(c) { return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2); }).join('')); }
    catch (e) { return str; }
}

// Tabs
document.querySelectorAll('.tab').forEach(function(tab) {
    tab.addEventListener('click', function() {
        document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
        document.querySelectorAll('.tab-panel').forEach(function(p) { p.style.display = 'none'; p.classList.remove('active'); });
        tab.classList.add('active');
        currentTab = tab.dataset.tab;
        var panel = document.getElementById('tab-' + currentTab);
        panel.style.display = '';
        panel.classList.add('active');
    });
});

// Toolbar
document.getElementById('btnRun').addEventListener('click', function() { executeQuery(); });
document.getElementById('btnStats').addEventListener('click', function() { executeWithStats(); });
document.getElementById('btnPlan').addEventListener('click', function() { explainQuery(); });
document.getElementById('btnBuildChart').addEventListener('click', function() { buildChart(); });
document.getElementById('btnExportChart').addEventListener('click', function() { exportChart(); });
document.getElementById('btnCancel').addEventListener('click', function() {
    vscode.postMessage({ type: 'cancelQuery' });
    clearResults();
    globalLoading.style.display = 'none';
});

decodeStringCheckbox.addEventListener('change', function() {
    if (allDisplayedRows.length > 0 && allColumns.length > 0) {
        resultsTable.querySelector('tbody').innerHTML = renderRows(allDisplayedRows);
        if (editMode) applyEditHighlights();
    }
});

// Edit mode
btnEdit.addEventListener('click', function() {
    editMode = true; btnEdit.style.display = 'none'; editBar.style.display = 'flex';
    applyEditableClasses(); updateEditCount();
});
btnCancelEdit.addEventListener('click', function() { exitEditMode(); });
btnDiscard.addEventListener('click', function() {
    pendingEdits = {};
    document.querySelectorAll('#resultsTable tbody td.cell-edited').forEach(function(td) { td.classList.remove('cell-edited'); });
    updateEditCount();
});
btnCommit.addEventListener('click', function() {
    var edits = Object.values(pendingEdits);
    if (edits.length === 0) return;
    vscode.postMessage({
        type: 'commitEdits', tablePath: currentTablePath,
        edits: edits.map(function(e) { return { rowIdx: e.rowIdx, colName: e.colName, newValue: e.newValue, pkValues: getPkValues(e.rowIdx), colType: columnTypeMap[e.colName] || 'String' }; }),
        columnTypes: columnTypeMap,
    });
});

function getPkValues(rowIdx) {
    var row = allDisplayedRows[rowIdx]; if (!row) return {};
    var pk = {}; tablePrimaryKeys.forEach(function(k) { pk[k] = row[k]; }); return pk;
}
function exitEditMode() {
    editMode = false; pendingEdits = {};
    btnEdit.style.display = tablePrimaryKeys.length > 0 ? '' : 'none'; editBar.style.display = 'none';
    document.querySelectorAll('#resultsTable tbody td.cell-edited').forEach(function(td) { td.classList.remove('cell-edited'); });
    document.querySelectorAll('#resultsTable tbody td.cell-editable').forEach(function(td) { td.classList.remove('cell-editable'); });
    document.querySelectorAll('#resultsTable tbody td.cell-pk').forEach(function(td) { td.classList.remove('cell-pk'); });
}
function applyEditableClasses() {
    resultsTable.querySelectorAll('tbody tr').forEach(function(tr) {
        var tds = tr.querySelectorAll('td');
        allColumns.forEach(function(col, ci) {
            if (ci >= tds.length) return;
            if (tablePrimaryKeys.indexOf(col.name) >= 0) tds[ci].classList.add('cell-pk');
            else tds[ci].classList.add('cell-editable');
        });
    });
}
function applyEditHighlights() {
    applyEditableClasses();
    Object.values(pendingEdits).forEach(function(e) {
        var rows = resultsTable.querySelectorAll('tbody tr');
        if (e.rowIdx < rows.length) {
            var colIdx = allColumns.findIndex(function(c) { return c.name === e.colName; });
            if (colIdx >= 0) { var td = rows[e.rowIdx].querySelectorAll('td')[colIdx]; if (td) td.classList.add('cell-edited'); }
        }
    });
}
function updateEditCount() {
    var count = Object.keys(pendingEdits).length;
    editCount.textContent = count > 0 ? count + ' change(s)' : 'No changes';
    btnCommit.disabled = count === 0; btnDiscard.disabled = count === 0;
}

// Infinite scroll
resultsContainer.addEventListener('scroll', function() {
    if (isLoadingMore || !hasMoreRows) return;
    if (resultsContainer.scrollTop + resultsContainer.clientHeight >= resultsContainer.scrollHeight - 50) {
        isLoadingMore = true; loadingMore.style.display = '';
        vscode.postMessage({ type: 'loadMoreRows', offset: displayedRowCount, pageSize: getPageSize() });
    }
});

function getPageSize() { return parseInt(pageSizeInput.value, 10) || 200; }
function switchTab(name) { document.querySelector('.tab[data-tab="' + name + '"]').click(); }

function getCurrentQuery() {
    return window.monacoEditor ? window.monacoEditor.getValue() : '';
}

function executeQuery() {
    var query = getCurrentQuery().trim();
    if (!query) return;
    clearErrors(); clearResults(); switchTab('results');
    document.getElementById('tabResults').style.display = '';
    document.getElementById('tabChart').style.display = '';
    vscode.postMessage({ type: 'executeQuery', query: query, pageSize: getPageSize() });
}
function executeWithStats() {
    var query = getCurrentQuery().trim();
    if (!query) return;
    clearErrors(); clearResults(); switchTab('statistics');
    document.getElementById('tabResults').style.display = '';
    document.getElementById('tabChart').style.display = '';
    vscode.postMessage({ type: 'executeWithStats', query: query });
}
function explainQuery() {
    var query = getCurrentQuery().trim();
    if (!query) return;
    clearErrors(); clearResults(); switchTab('plan');
    document.getElementById('tabResults').style.display = 'none';
    document.getElementById('tabChart').style.display = 'none';
    document.getElementById('tabStatistics').style.display = 'none';
    vscode.postMessage({ type: 'explainQuery', query: query });
}

// Message handler
window.addEventListener('message', function(event) {
    var msg = event.data;
    switch (msg.type) {
        case 'queryResult': onQueryResult(msg); break;
        case 'moreRows': onMoreRows(msg); break;
        case 'allRows': onAllRows(msg); break;
        case 'statsResult': onStatsResult(msg); break;
        case 'explainResult': onExplainResult(msg); break;
        case 'triggerExecute':
            if (window.monacoEditor) executeQuery();
            else pendingTriggerExecute = true;
            break;
        case 'setContent':
            if (window.monacoEditor) window.monacoEditor.setValue(msg.content || '');
            else pendingContent = msg.content || '';
            break;
        case 'insertText':
            if (window.monacoEditor) {
                var pos = window.monacoEditor.getPosition();
                if (pos) window.monacoEditor.executeEdits('insert', [{ range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column), text: msg.text || '' }]);
            }
            break;
        case 'clearState': clearErrors(); clearResults(); break;
        case 'cancelled': globalLoading.style.display = 'none'; clearResults(); break;
        case 'error': onError(msg); break;
        case 'loading': globalLoading.style.display = msg.loading ? '' : 'none'; break;
        case 'commitResult': onCommitResult(msg); break;
        case 'completionResponse': {
            var resolve = pendingCompletionRequests.get(msg.requestId);
            if (resolve) { pendingCompletionRequests.delete(msg.requestId); resolve(msg.items || []); }
            break;
        }
    }
});

function clearErrors() { document.querySelectorAll('.query-error').forEach(function(el) { el.remove(); }); }
function clearResults() {
    allColumns = []; displayedRowCount = 0; totalRowCount = 0; hasMoreRows = false;
    chartDataLoaded = false; chartRows = []; chartColumns = []; allDisplayedRows = [];
    editMode = false; pendingEdits = {}; tablePrimaryKeys = []; currentTablePath = ''; columnTypeMap = {};
    btnEdit.style.display = 'none'; editBar.style.display = 'none';
    resultsInfo.textContent = '';
    resultsTable.querySelector('thead').innerHTML = ''; resultsTable.querySelector('tbody').innerHTML = '';
    resultsTable.style.tableLayout = ''; resultsTable.style.width = '';
    delete resultsTable.dataset.frozen;
    document.getElementById('statsContent').innerHTML = '';
    updateChartSelectors();
}

function onError(msg) {
    globalLoading.style.display = 'none'; clearResults();
    var panel = document.getElementById('tab-' + currentTab);
    var div = document.createElement('div');
    div.className = 'query-error';
    div.style.cssText = 'color: var(--vscode-errorForeground); padding: 12px; background: var(--vscode-inputValidation-errorBackground); border-radius: 4px; margin: 8px 0; white-space: pre-wrap; word-break: break-word; max-height: 300px; overflow: auto;';
    div.textContent = msg.message;
    panel.prepend(div);
}

// ========== Results ==========
function onQueryResult(msg) {
    editMode = false; pendingEdits = {}; editBar.style.display = 'none';
    allColumns = msg.columns; displayedRowCount = msg.rows.length; totalRowCount = msg.totalRows;
    hasMoreRows = msg.hasMore; sortCol = -1; cellFullValues = [];
    chartDataLoaded = false; chartRows = []; chartColumns = []; lastQueryId++;
    allDisplayedRows = msg.rows.slice();
    tablePrimaryKeys = msg.primaryKeys || []; currentTablePath = msg.tablePath || '';
    columnTypeMap = {};
    allColumns.forEach(function(c) { columnTypeMap[c.name] = c.type; });

    if (tablePrimaryKeys.length > 0) {
        var pkSet = {}; tablePrimaryKeys.forEach(function(k) { pkSet[k] = true; });
        var pkCols = []; tablePrimaryKeys.forEach(function(k) { var col = allColumns.find(function(c) { return c.name === k; }); if (col) pkCols.push(col); });
        allColumns = pkCols.concat(allColumns.filter(function(c) { return !pkSet[c.name]; }));
    }
    btnEdit.style.display = tablePrimaryKeys.length > 0 ? '' : 'none';
    resultsInfo.textContent = displayedRowCount + ' row(s)' + (hasMoreRows ? ' (more available)' : '');

    resultsTable.querySelector('thead').innerHTML = '<tr>' + allColumns.map(function(c, i) {
        var isPk = tablePrimaryKeys.indexOf(c.name) >= 0;
        return '<th onclick="sortTableBy(' + i + ')"' + (isPk ? ' class="col-pk"' : '') + '>' + esc(c.name) + (isPk ? ' &#128273;' : '') + '<br><span class="col-type">' + esc(c.type) + '</span></th>';
    }).join('') + '</tr>';
    resultsTable.querySelector('tbody').innerHTML = renderRows(msg.rows);
    markOverflowCells(); updateChartSelectors();
}

function onMoreRows(msg) {
    isLoadingMore = false; loadingMore.style.display = 'none';
    displayedRowCount += msg.rows.length; hasMoreRows = msg.hasMore;
    allDisplayedRows = allDisplayedRows.concat(msg.rows);
    resultsInfo.textContent = displayedRowCount + ' row(s)' + (hasMoreRows ? ' (more available)' : '');
    resultsTable.querySelector('tbody').insertAdjacentHTML('beforeend', renderRows(msg.rows));
    markOverflowCells();
}

function renderRows(rows) {
    var shouldDecode = decodeStringCheckbox.checked;
    return rows.map(function(row) {
        return '<tr>' + allColumns.map(function(c) {
            var val = row[c.name];
            if (val === null || val === undefined) return '<td><span class="null-val">NULL</span></td>';
            var s = typeof val === 'object' ? JSON.stringify(val) : String(val);
            if (shouldDecode && isStringType(c.type)) s = decodeBase64(s);
            var idx = cellFullValues.length; cellFullValues.push(s);
            return '<td data-cellidx="' + idx + '" title="' + esc(s) + '">' + esc(s) + '</td>';
        }).join('') + '</tr>';
    }).join('');
}
function markOverflowCells() {
    document.querySelectorAll('#resultsTable tbody td[data-cellidx]').forEach(function(td) {
        td.classList.toggle('cell-expandable', td.scrollWidth > td.clientWidth);
    });
}

function sortTableBy(col) {
    var tbody = resultsTable.querySelector('tbody');
    var rows = Array.from(tbody.querySelectorAll('tr'));
    if (sortCol === col) sortAsc = !sortAsc; else { sortCol = col; sortAsc = true; }
    rows.sort(function(a, b) {
        var at = a.cells[col] ? a.cells[col].textContent : '';
        var bt = b.cells[col] ? b.cells[col].textContent : '';
        var an = parseFloat(at), bn = parseFloat(bt);
        if (!isNaN(an) && !isNaN(bn)) return sortAsc ? an - bn : bn - an;
        return sortAsc ? at.localeCompare(bt) : bt.localeCompare(at);
    });
    rows.forEach(function(r) { tbody.appendChild(r); });
}
window.sortTableBy = sortTableBy;

// ========== Inline cell editing ==========
resultsTable.addEventListener('click', function(e) {
    if (!editMode) return;
    var td = e.target.closest('td.cell-editable');
    if (!td || td.querySelector('.cell-inline-input')) return;
    var tr = td.closest('tr');
    var rowIdx = Array.from(resultsTable.querySelectorAll('tbody tr')).indexOf(tr);
    var colIdx = Array.from(tr.querySelectorAll('td')).indexOf(td);
    if (rowIdx < 0 || colIdx < 0 || colIdx >= allColumns.length) return;
    var colName = allColumns[colIdx].name;
    var currentVal = allDisplayedRows[rowIdx][colName];
    var displayVal = currentVal === null || currentVal === undefined ? '' : (typeof currentVal === 'object' ? JSON.stringify(currentVal) : String(currentVal));
    var editKey = rowIdx + ':' + colName;
    if (pendingEdits[editKey]) displayVal = pendingEdits[editKey].newValue;
    var input = document.createElement('input'); input.type = 'text'; input.className = 'cell-inline-input'; input.value = displayVal;
    var originalHtml = td.innerHTML; td.textContent = ''; td.appendChild(input); input.focus(); input.select();
    function commitEdit() {
        var newVal = input.value; td.innerHTML = originalHtml;
        var oldVal = currentVal === null || currentVal === undefined ? '' : (typeof currentVal === 'object' ? JSON.stringify(currentVal) : String(currentVal));
        if (newVal !== oldVal) { td.textContent = newVal; td.classList.add('cell-edited', 'cell-editable'); pendingEdits[editKey] = { rowIdx: rowIdx, colName: colName, oldValue: oldVal, newValue: newVal }; }
        else { delete pendingEdits[editKey]; td.classList.remove('cell-edited'); }
        updateEditCount();
    }
    input.addEventListener('keydown', function(ev) { if (ev.key === 'Enter') { ev.preventDefault(); commitEdit(); } if (ev.key === 'Escape') { ev.preventDefault(); td.innerHTML = originalHtml; td.classList.add('cell-editable'); } });
    input.addEventListener('blur', function() { setTimeout(function() { if (td.querySelector('.cell-inline-input')) commitEdit(); }, 0); });
});

function onCommitResult(msg) {
    if (msg.success) {
        Object.values(pendingEdits).forEach(function(e) { if (allDisplayedRows[e.rowIdx]) allDisplayedRows[e.rowIdx][e.colName] = e.newValue; });
        pendingEdits = {}; cellFullValues = [];
        resultsTable.querySelector('tbody').innerHTML = renderRows(allDisplayedRows);
        markOverflowCells(); if (editMode) applyEditableClasses(); updateEditCount();
    } else {
        var div = document.createElement('div'); div.className = 'query-error';
        div.style.cssText = 'color: var(--vscode-errorForeground); padding: 12px; background: var(--vscode-inputValidation-errorBackground); border-radius: 4px; margin: 8px 0; white-space: pre-wrap; word-break: break-word; max-height: 300px; overflow: auto;';
        div.textContent = 'Commit failed: ' + (msg.error || 'Unknown error');
        document.getElementById('tab-results').prepend(div);
    }
}

// ========== Statistics ==========
function onStatsResult(msg) {
    document.getElementById('tabStatistics').style.display = '';
    var s = msg.stats;
    var durationMs = (s.totalDurationUs / 1000).toFixed(2);
    var cpuMs = (s.totalCpuTimeUs / 1000).toFixed(2);
    var html = '<div class="stats-cards">';
    html += statCard('Total Duration', durationMs, 'ms');
    html += statCard('CPU Time', cpuMs, 'ms');
    html += statCard('Rows', msg.result.rowCount, '');
    html += '</div>';
    if (msg.svgContent || s.planJson) {
        var hasSvg = !!msg.svgContent, hasJson = !!s.planJson;
        if (hasSvg && hasJson) {
            html += '<div class="stats-plan-toggle"><button class="active" data-plan-view="svg">Plan (SVG)</button><button data-plan-view="json">Plan (JSON)</button></div>';
        } else if (hasSvg) { html += '<h3 style="margin: 12px 0 8px;">Query Plan</h3>'; }
        else { html += '<h3 style="margin: 12px 0 8px;">Query Plan (JSON)</h3>'; }
        if (hasSvg) html += '<div id="statsPlanSvg" class="stats-plan-svg">' + msg.svgContent + '</div>';
        if (hasJson) {
            var jsonHtml = '';
            try { jsonHtml = '<pre class="stats-plan-json">' + esc(JSON.stringify(JSON.parse(s.planJson), null, 2)) + '</pre>'; }
            catch(e) { jsonHtml = '<pre class="stats-plan-json">' + esc(s.planJson) + '</pre>'; }
            html += '<div id="statsPlanJson"' + (hasSvg ? ' style="display:none"' : '') + '>' + jsonHtml + '</div>';
        }
    }
    var statsContent = document.getElementById('statsContent');
    statsContent.innerHTML = html;
    statsContent.querySelectorAll('[data-plan-view]').forEach(function(btn) {
        btn.addEventListener('click', function() { showStatsPlanView(btn.getAttribute('data-plan-view')); });
    });
    if (msg.result.rows && msg.result.columns) {
        onQueryResult({ columns: msg.result.columns, rows: msg.result.rows, totalRows: msg.result.rowCount, hasMore: false, primaryKeys: [], tablePath: '' });
    }
}
function statCard(label, value, unit) { return '<div class="stat-card"><div class="label">' + label + '</div><div class="value">' + value + ' <span class="unit">' + unit + '</span></div></div>'; }
function showStatsPlanView(view) {
    var svgEl = document.getElementById('statsPlanSvg'), jsonEl = document.getElementById('statsPlanJson');
    if (svgEl) svgEl.style.display = view === 'svg' ? '' : 'none';
    if (jsonEl) jsonEl.style.display = view === 'json' ? '' : 'none';
    document.querySelectorAll('.stats-plan-toggle button').forEach(function(b) { b.classList.toggle('active', b.textContent.toLowerCase().indexOf(view) >= 0); });
}
window.showStatsPlanView = showStatsPlanView;

// ========== Execution Plan ==========
var planNodes = []; var selectedPlanNode = null;
var planZoomLevel = 1; var planRawJson = '';
var currentPlanSubTab = 'graph';

// Plan sub-tab switching
document.querySelectorAll('.plan-sub-tab').forEach(function(btn) {
    btn.addEventListener('click', function() {
        document.querySelectorAll('.plan-sub-tab').forEach(function(b) { b.classList.remove('active'); });
        btn.classList.add('active');
        currentPlanSubTab = btn.dataset.planTab;
        document.querySelectorAll('.plan-view-panel').forEach(function(p) { p.style.display = 'none'; });
        var panel = document.getElementById('planView-' + currentPlanSubTab);
        if (panel) panel.style.display = '';
    });
});

// Zoom controls
function updatePlanZoom() {
    var svg = document.getElementById('planSvg');
    if (svg) svg.style.transform = 'scale(' + planZoomLevel + ')';
    var label = document.getElementById('planZoomLabel');
    if (label) label.textContent = Math.round(planZoomLevel * 100) + '%';
}
document.getElementById('planZoomIn').addEventListener('click', function() { planZoomLevel = Math.min(planZoomLevel * 1.2, 5); updatePlanZoom(); });
document.getElementById('planZoomOut').addEventListener('click', function() { planZoomLevel = Math.max(planZoomLevel / 1.2, 0.1); updatePlanZoom(); });
document.getElementById('planFitView').addEventListener('click', function() {
    var svg = document.getElementById('planSvg'), wrap = document.getElementById('planSvgWrap');
    if (!svg || !wrap) return;
    var sw = parseFloat(svg.getAttribute('width')) || svg.getBoundingClientRect().width / planZoomLevel;
    var sh = parseFloat(svg.getAttribute('height')) || svg.getBoundingClientRect().height / planZoomLevel;
    if (sw && sh) {
        var sx = wrap.clientWidth / sw, sy = wrap.clientHeight / sh;
        planZoomLevel = Math.min(sx, sy, 2) * 0.95;
        updatePlanZoom(); wrap.scrollLeft = 0; wrap.scrollTop = 0;
    }
});
document.getElementById('planSvgWrap').addEventListener('wheel', function(e) {
    if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        planZoomLevel = e.deltaY < 0 ? Math.min(planZoomLevel * 1.1, 5) : Math.max(planZoomLevel / 1.1, 0.1);
        updatePlanZoom();
    }
}, { passive: false });

// Table view
function formatMetricNumber(val) {
    if (val === undefined || val === null || val === '') return '';
    var n = Number(val); if (isNaN(n)) return String(val);
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return n % 1 !== 0 ? n.toFixed(1) : String(n);
}
function formatCpuTime(val) {
    if (val === undefined || val === null || val === '') return '';
    var n = Number(val); if (isNaN(n)) return String(val);
    return (n / 1000).toFixed(1) + 'ms';
}
function getMetric(props, key) { return props[key] !== undefined ? props[key] : ''; }
function collectOperatorMetrics(node) {
    var result = { aCpu: '', aRows: '', eCost: '', eRows: '', eSize: '' };
    var props = node.properties || {};
    // Check node-level Stats first
    result.aCpu = getMetric(props, 'Stats.TotalCpuTimeUs');
    result.aRows = getMetric(props, 'Stats.TotalRows');
    result.eCost = getMetric(props, 'E-Cost');
    result.eRows = getMetric(props, 'E-Rows');
    result.eSize = getMetric(props, 'E-Size');
    // Then check operator details (where YDB typically stores all metrics)
    if (node.operatorDetails && node.operatorDetails.length > 0) {
        for (var i = 0; i < node.operatorDetails.length; i++) {
            var op = node.operatorDetails[i];
            if (!result.aCpu && op.properties['A-Cpu']) result.aCpu = op.properties['A-Cpu'];
            if (!result.aRows && op.properties['A-Rows']) result.aRows = op.properties['A-Rows'];
            if (!result.eCost && op.properties['E-Cost']) result.eCost = op.properties['E-Cost'];
            if (!result.eRows && op.properties['E-Rows']) result.eRows = op.properties['E-Rows'];
            if (!result.eSize && op.properties['E-Size']) result.eSize = op.properties['E-Size'];
        }
    }
    return result;
}
function renderPlanTable(planRoot) {
    var tbody = document.getElementById('planTableBody'); if (!tbody) return;
    var html = ''; var rowId = 0;
    function renderRow(node, depth, parentId) {
        var id = rowId++; var hasChildren = node.children && node.children.length > 0;
        var indent = depth * 20;
        var toggle = hasChildren ? '<span class="plan-op-toggle" data-plan-row-id="' + id + '">&#9660;</span>' : '<span style="display:inline-block;width:14px;margin-right:4px;"></span>';
        var opHtml = toggle + '<span class="plan-op-name">' + esc(node.name) + '</span>';
        if (node.tableName) opHtml += '<span class="plan-op-table">' + esc(node.tableName) + '</span>';
        if (node.operators) opHtml += '<span class="plan-op-operators">' + esc(node.operators) + '</span>';
        var m = collectOperatorMetrics(node);
        html += '<tr data-plan-row="' + id + '" data-plan-parent="' + parentId + '" data-plan-depth="' + depth + '">';
        html += '<td style="padding-left:' + (8 + indent) + 'px">' + opHtml + '</td>';
        html += '<td class="metric-cell">' + esc(formatCpuTime(m.aCpu)) + '</td>';
        html += '<td class="metric-cell">' + esc(formatMetricNumber(m.aRows)) + '</td>';
        html += '<td class="metric-cell">' + esc(formatMetricNumber(m.eCost)) + '</td>';
        html += '<td class="metric-cell">' + esc(formatMetricNumber(m.eRows)) + '</td>';
        html += '<td class="metric-cell">' + esc(formatMetricNumber(m.eSize)) + '</td>';
        html += '</tr>';
        if (node.children) node.children.forEach(function(child) { renderRow(child, depth + 1, id); });
    }
    renderRow(planRoot, 0, -1);
    tbody.innerHTML = html;
    tbody.querySelectorAll('.plan-op-toggle').forEach(function(toggle) {
        toggle.addEventListener('click', function(e) {
            e.stopPropagation();
            var rid = toggle.dataset.planRowId;
            var collapsed = toggle.innerHTML === '\u25B6';
            toggle.innerHTML = collapsed ? '\u25BC' : '\u25B6';
            togglePlanTreeChildren(rid, !collapsed);
        });
    });
}
function togglePlanTreeChildren(parentId, hide) {
    var tbody = document.getElementById('planTableBody'); if (!tbody) return;
    var rows = tbody.querySelectorAll('tr');
    var found = false; var parentDepth = -1;
    for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        if (row.dataset.planRow === parentId) { found = true; parentDepth = parseInt(row.dataset.planDepth); continue; }
        if (found) {
            var d = parseInt(row.dataset.planDepth);
            if (d <= parentDepth) break;
            if (hide) { row.classList.add('plan-row-collapsed'); }
            else { row.classList.remove('plan-row-collapsed'); }
        }
    }
}

// JSON view
function renderPlanJson(rawJson) {
    var container = document.getElementById('planJsonContainer'); if (!container) return;
    if (!rawJson) { container.textContent = 'No JSON data'; return; }
    try {
        var parsed = JSON.parse(rawJson);
        container.innerHTML = '';
        container.appendChild(buildJsonTree(parsed, 0));
    } catch (e) {
        container.textContent = rawJson;
    }
}
function buildJsonTree(value, depth) {
    var indent = '  ';
    if (value === null) { var s = document.createElement('span'); s.className = 'json-null'; s.textContent = 'null'; return s; }
    if (typeof value === 'boolean') { var s = document.createElement('span'); s.className = 'json-bool'; s.textContent = String(value); return s; }
    if (typeof value === 'number') { var s = document.createElement('span'); s.className = 'json-number'; s.textContent = String(value); return s; }
    if (typeof value === 'string') { var s = document.createElement('span'); s.className = 'json-string'; s.textContent = JSON.stringify(value); return s; }
    var isArray = Array.isArray(value);
    var keys = isArray ? null : Object.keys(value);
    var count = isArray ? value.length : keys.length;
    var openBr = isArray ? '[' : '{'; var closeBr = isArray ? ']' : '}';
    var wrapper = document.createElement('span');
    var toggleSpan = document.createElement('span');
    toggleSpan.className = 'json-toggle json-bracket';
    toggleSpan.textContent = openBr;
    wrapper.appendChild(toggleSpan);
    var collapsedInfo = document.createElement('span');
    collapsedInfo.className = 'json-collapsed-info';
    collapsedInfo.textContent = '...' + count + ' item' + (count !== 1 ? 's' : '');
    collapsedInfo.style.display = 'none';
    wrapper.appendChild(collapsedInfo);
    var closeBrSpan = document.createElement('span');
    closeBrSpan.className = 'json-bracket';
    var content = document.createElement('span');
    content.className = 'json-content';
    var depthIndent = ''; for (var d = 0; d < depth; d++) depthIndent += indent;
    var childIndent = depthIndent + indent;
    if (isArray) {
        for (var i = 0; i < value.length; i++) {
            content.appendChild(document.createTextNode('\\n' + childIndent));
            content.appendChild(buildJsonTree(value[i], depth + 1));
            if (i < value.length - 1) content.appendChild(document.createTextNode(','));
        }
    } else {
        for (var i = 0; i < keys.length; i++) {
            content.appendChild(document.createTextNode('\\n' + childIndent));
            var keySpan = document.createElement('span'); keySpan.className = 'json-key'; keySpan.textContent = JSON.stringify(keys[i]);
            content.appendChild(keySpan);
            content.appendChild(document.createTextNode(': '));
            content.appendChild(buildJsonTree(value[keys[i]], depth + 1));
            if (i < keys.length - 1) content.appendChild(document.createTextNode(','));
        }
    }
    content.appendChild(document.createTextNode('\\n' + depthIndent));
    wrapper.appendChild(content);
    closeBrSpan.textContent = closeBr;
    wrapper.appendChild(closeBrSpan);
    toggleSpan.addEventListener('click', function() {
        var isHidden = content.style.display === 'none';
        content.style.display = isHidden ? '' : 'none';
        closeBrSpan.style.display = isHidden ? '' : 'none';
        collapsedInfo.style.display = isHidden ? 'none' : '';
    });
    return wrapper;
}
function jsonExpandAll() {
    var container = document.getElementById('planJsonContainer'); if (!container) return;
    container.querySelectorAll('.json-content').forEach(function(el) { el.style.display = ''; });
    container.querySelectorAll('.json-collapsed-info').forEach(function(el) { el.style.display = 'none'; });
    container.querySelectorAll('.json-bracket').forEach(function(el) { el.style.display = ''; });
}
function jsonCollapseAll() {
    var container = document.getElementById('planJsonContainer'); if (!container) return;
    container.querySelectorAll('.json-content').forEach(function(el) { el.style.display = 'none'; });
    container.querySelectorAll('.json-collapsed-info').forEach(function(el) { el.style.display = ''; });
}
document.getElementById('planJsonExpandAll').addEventListener('click', jsonExpandAll);
document.getElementById('planJsonCollapseAll').addEventListener('click', jsonCollapseAll);
document.getElementById('planJsonCopy').addEventListener('click', function() {
    if (planRawJson) navigator.clipboard.writeText(planRawJson).then(function() {
        var btn = document.getElementById('planJsonCopy'); btn.textContent = 'Copied!'; setTimeout(function() { btn.textContent = 'Copy'; }, 1500);
    });
});
var NODE_KIND_COLORS = {
    tablescan:{bg:'#dbeafe',border:'#2980b9'},indexscan:{bg:'#d1fae5',border:'#27ae60'},modify:{bg:'#fee2e2',border:'#c0392b'},
    join:{bg:'#ffedd5',border:'#e67e22'},sort:{bg:'#ede9fe',border:'#8e44ad'},filter:{bg:'#fef9c3',border:'#f1c40f'},
    aggregate:{bg:'#ccfbf1',border:'#1abc9c'},hash:{bg:'#e5e7eb',border:'#7f8c8d'},union:{bg:'#dbeafe',border:'#3498db'},
    merge:{bg:'#e0f2fe',border:'#5dade2'},group:{bg:'#ccfbf1',border:'#1abc9c'},result:{bg:'#d1fae5',border:'#2ecc71'},
    default:{bg:'#f3f4f6',border:'#9ca3af'}
};
function getNodeKind(nodeType) {
    if (!nodeType) return 'default'; var t = nodeType.toLowerCase();
    if (t.indexOf('source')>=0||t.indexOf('tablescan')>=0||t.indexOf('table scan')>=0||t.indexOf('readtable')>=0||t.indexOf('read table')>=0) return 'tablescan';
    if (t.indexOf('index')>=0) return 'indexscan'; if (t.indexOf('upsert')>=0||t.indexOf('sink')>=0||t.indexOf('write')>=0||t.indexOf('modify')>=0||t.indexOf('delete')>=0||t.indexOf('insert')>=0||t.indexOf('update')>=0) return 'modify';
    if (t.indexOf('join')>=0) return 'join'; if (t.indexOf('sort')>=0||t.indexOf('order')>=0) return 'sort';
    if (t.indexOf('filter')>=0||t.indexOf('where')>=0) return 'filter'; if (t.indexOf('aggregate')>=0||t.indexOf('agg')>=0) return 'aggregate';
    if (t.indexOf('hash')>=0) return 'hash'; if (t.indexOf('union')>=0) return 'union'; if (t.indexOf('merge')>=0) return 'merge';
    if (t.indexOf('group')>=0) return 'group'; if (t.indexOf('result')>=0) return 'result'; return 'default';
}
function onExplainResult(msg) {
    document.getElementById('tabPlan').style.display = ''; planNodes = [];
    planZoomLevel = 1; updatePlanZoom();
    planRawJson = msg.rawJson || '';
    flattenPlan(msg.plan, null, 0); layoutPlan(); renderPlanSvg();
    if (planNodes.length > 0) { selectPlanNode(0); document.getElementById('planSvgWrap').focus(); }
    renderPlanTable(msg.plan);
    renderPlanJson(planRawJson);
}
function flattenPlan(node, parentIdx, depth) {
    var idx = planNodes.length;
    planNodes.push({ name:node.name, tableName:node.tableName||null, operators:node.operators||null, operatorDetails:node.operatorDetails||null, properties:node.properties||{}, children:[], parentIdx:parentIdx, depth:depth, x:0, y:0, w:0, h:0 });
    if (parentIdx !== null) planNodes[parentIdx].children.push(idx);
    if (node.children) node.children.forEach(function(child) { flattenPlan(child, idx, depth + 1); });
}
function layoutPlan() {
    var PAD_X=14,PAD_Y=10,H_GAP=50,V_GAP=20,TITLE_FONT=13,SUB_FONT=11,NUM_FONT=10,ROOT_OFFSET=50;
    var mc = document.createElement('canvas').getContext('2d');
    for (var i = 0; i < planNodes.length; i++) {
        var n = planNodes[i];
        mc.font = 'bold ' + TITLE_FONT + 'px sans-serif'; var tw = mc.measureText(n.name).width;
        mc.font = NUM_FONT + 'px sans-serif'; tw += 20 + mc.measureText('#'+(i+1)).width;
        var textW = tw, textH = TITLE_FONT + 4;
        if (n.tableName) { mc.font = SUB_FONT + 'px sans-serif'; textW = Math.max(textW, mc.measureText(n.tableName.length > 35 ? n.tableName.substring(0,35)+'...' : n.tableName).width); textH += SUB_FONT + 4; }
        n.w = Math.max(120, textW + PAD_X * 2); n.h = textH + PAD_Y * 2;
    }
    var dg = {}; planNodes.forEach(function(n) { if (!dg[n.depth]) dg[n.depth] = []; dg[n.depth].push(n); });
    var md = Math.max(0, ...Object.keys(dg).map(Number)); var xOff = ROOT_OFFSET;
    for (var d = 0; d <= md; d++) { var g = dg[d]||[]; g.forEach(function(n){n.x=xOff;}); xOff += Math.max(0,...g.map(function(n){return n.w;})) + H_GAP; }
    var yPos = 30;
    function assignLeafY(idx) { var n = planNodes[idx]; if (n.children.length === 0) { n.y = yPos; yPos += n.h + V_GAP; } else n.children.forEach(assignLeafY); }
    function centerParents(idx) { var n = planNodes[idx]; if (n.children.length === 0) return; n.children.forEach(centerParents); var f = planNodes[n.children[0]], l = planNodes[n.children[n.children.length-1]]; n.y = (f.y+f.h/2+l.y+l.h/2)/2 - n.h/2; }
    if (planNodes.length > 0) { assignLeafY(0); centerParents(0); }
}
function renderPlanSvg() {
    var svg = document.getElementById('planSvg');
    if (!planNodes.length) { svg.setAttribute('width','300'); svg.setAttribute('height','60'); svg.innerHTML='<text x="20" y="30" fill="currentColor" font-size="13">No plan data</text>'; return; }
    var maxX=0,maxY=0; planNodes.forEach(function(n){maxX=Math.max(maxX,n.x+n.w);maxY=Math.max(maxY,n.y+n.h);}); maxX+=40;maxY+=40;
    svg.setAttribute('width',maxX); svg.setAttribute('height',maxY); svg.setAttribute('viewBox','0 0 '+maxX+' '+maxY);
    var html='<defs><filter id="dropShadow"><feDropShadow dx="1" dy="1" stdDeviation="2" flood-opacity="0.15"/></filter></defs>';
    var nFg='#1f2937',nDFg='#6b7280',lFg='#d1d5db',dFg='var(--vscode-descriptionForeground, #888)';
    planNodes.forEach(function(n){n.children.forEach(function(ci){var c=planNodes[ci]; var x1=n.x+n.w,y1=n.y+n.h/2,x2=c.x,y2=c.y+c.h/2,mx=(x1+x2)/2; html+='<path d="M'+x1+','+y1+' C'+mx+','+y1+' '+mx+','+y2+' '+x2+','+y2+'" fill="none" stroke="'+lFg+'" stroke-width="1.5" opacity="0.7"/>';});});
    if (planNodes.length > 0) { var root=planNodes[0],cy=root.y+root.h/2,cx=root.x-24; html+='<circle cx="'+cx+'" cy="'+cy+'" r="10" fill="none" stroke="'+dFg+'" stroke-width="2"/>'; html+='<line x1="'+(cx+10)+'" y1="'+cy+'" x2="'+root.x+'" y2="'+cy+'" stroke="'+lFg+'" stroke-width="1.5"/>'; }
    for (var i=0;i<planNodes.length;i++) {
        var n=planNodes[i],kind=getNodeKind(n.name),colors=NODE_KIND_COLORS[kind]||NODE_KIND_COLORS.default;
        html+='<g class="plan-node-g" data-idx="'+i+'" style="cursor:pointer">';
        html+='<rect id="planRect'+i+'" x="'+n.x+'" y="'+n.y+'" width="'+n.w+'" height="'+n.h+'" rx="8" ry="8" fill="'+colors.bg+'" stroke="'+colors.border+'" stroke-width="1.5" filter="url(#dropShadow)"/>';
        html+='<rect id="planSel'+i+'" x="'+n.x+'" y="'+n.y+'" width="'+n.w+'" height="'+n.h+'" rx="8" ry="8" fill="none" stroke="var(--vscode-focusBorder, #007fd4)" stroke-width="2.5" display="none"/>';
        var tX=n.x+14,tY=n.y+12+13;
        html+='<text x="'+tX+'" y="'+tY+'" fill="'+nFg+'" font-size="13" font-weight="bold" font-family="sans-serif">'+esc(n.name)+'</text>';
        html+='<text x="'+(n.x+n.w-10)+'" y="'+(n.y+16)+'" fill="'+nDFg+'" font-size="10" text-anchor="end" font-family="sans-serif">#'+(i+1)+'</text>';
        if (n.tableName) { var sY=tY+17,sT=n.tableName.length>35?n.tableName.substring(0,35)+'...':n.tableName; html+='<text x="'+tX+'" y="'+sY+'" fill="'+nDFg+'" font-size="11" font-family="sans-serif">'+esc(sT)+'</text>'; }
        html+='</g>';
    }
    svg.innerHTML = html;
    svg.querySelectorAll('.plan-node-g').forEach(function(g) {
        g.addEventListener('click', function(e) { e.stopPropagation(); selectPlanNode(parseInt(g.dataset.idx)); document.getElementById('planSvgWrap').focus(); });
        g.addEventListener('mouseenter', function(e) { showPlanTooltip(parseInt(g.dataset.idx), e); });
        g.addEventListener('mouseleave', hidePlanTooltip);
    });
}
var tooltipEl = null;
function showPlanTooltip(idx, event) {
    var n = planNodes[idx]; if (!tooltipEl) { tooltipEl = document.createElement('div'); tooltipEl.className = 'plan-tooltip'; document.body.appendChild(tooltipEl); }
    var html = '<div class="plan-tooltip-title">' + esc(n.name) + '</div>';
    if (n.tableName) html += '<div class="plan-tooltip-detail">Tables: ' + esc(n.tableName) + '</div>';
    if (n.operators) html += '<div class="plan-tooltip-detail">Operators: ' + esc(n.operators) + '</div>';
    tooltipEl.innerHTML = html; tooltipEl.style.display = 'block'; tooltipEl.style.left = (event.clientX+12)+'px'; tooltipEl.style.top = (event.clientY+12)+'px';
}
function hidePlanTooltip() { if (tooltipEl) tooltipEl.style.display = 'none'; }
function selectPlanNode(idx) {
    if (selectedPlanNode !== null) { var p = document.getElementById('planSel'+selectedPlanNode); if (p) p.setAttribute('display','none'); }
    selectedPlanNode = idx;
    var sel = document.getElementById('planSel'+idx); if (sel) sel.setAttribute('display','');
    ensurePlanNodeVisible(idx); showPlanProperties(idx);
}
function ensurePlanNodeVisible(idx) {
    var wrap = document.getElementById('planSvgWrap'), n = planNodes[idx]; if (!wrap||!n) return;
    if (n.x < wrap.scrollLeft) wrap.scrollLeft = n.x - 20;
    else if (n.x+n.w > wrap.scrollLeft+wrap.clientWidth) wrap.scrollLeft = n.x+n.w-wrap.clientWidth+20;
    if (n.y < wrap.scrollTop) wrap.scrollTop = n.y - 20;
    else if (n.y+n.h > wrap.scrollTop+wrap.clientHeight) wrap.scrollTop = n.y+n.h-wrap.clientHeight+20;
}
function showPlanProperties(idx) {
    var node = planNodes[idx], propsDiv = document.getElementById('planProperties');
    var html = '<h3>' + esc(node.name) + '</h3>';
    if (node.tableName) html += '<div class="plan-prop-row"><span class="plan-prop-key">Tables</span><span class="plan-prop-val">' + esc(node.tableName) + '</span></div>';
    if (node.operators) html += '<div class="plan-prop-row"><span class="plan-prop-key">Operators</span><span class="plan-prop-val">' + esc(node.operators) + '</span></div>';
    var skipKeys = ['Node Type','PlanNodeType','Tables','Table','Operators','Plans'];
    Object.keys(node.properties).forEach(function(k) {
        if (skipKeys.indexOf(k) >= 0) return;
        var val = String(node.properties[k]); if (!val) return;
        if (val.length > 100 || val.indexOf('\\n') >= 0) {
            var tr = val.replace(/\\n/g, ' ').substring(0, 80) + '...';
            var propId = 'planProp_' + idx + '_' + k.replace(/[^a-zA-Z0-9]/g, '_');
            html += '<div class="plan-prop-row"><span class="plan-prop-key">' + esc(k) + '</span><span class="plan-prop-val plan-prop-expandable" onclick="togglePlanProp(\\'' + propId + '\\')">';
            html += '<span id="' + propId + '_short">' + esc(tr) + '</span><span id="' + propId + '_full" class="plan-prop-expanded" style="display:none">' + esc(val) + '</span></span></div>';
        } else { html += '<div class="plan-prop-row"><span class="plan-prop-key">' + esc(k) + '</span><span class="plan-prop-val">' + esc(val) + '</span></div>'; }
    });
    propsDiv.innerHTML = html;
}
function togglePlanProp(id) { var s = document.getElementById(id+'_short'), f = document.getElementById(id+'_full'); if (!s||!f) return; if (f.style.display==='none') {s.style.display='none';f.style.display='';} else {s.style.display='';f.style.display='none';} }
window.togglePlanProp = togglePlanProp;

document.addEventListener('keydown', function(e) {
    if (currentTab !== 'plan' || (document.activeElement && document.activeElement.tagName === 'INPUT')) return;
    if (selectedPlanNode === null) { if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].indexOf(e.key)>=0 && planNodes.length>0) { e.preventDefault(); selectPlanNode(0); } return; }
    var node = planNodes[selectedPlanNode], target = null;
    if (e.key==='ArrowRight' && node.children.length>0) target=node.children[0];
    else if (e.key==='ArrowLeft' && node.parentIdx!==null) target=node.parentIdx;
    else if (e.key==='ArrowDown'||e.key==='ArrowUp') {
        var siblings = node.parentIdx!==null ? planNodes[node.parentIdx].children : planNodes.map(function(_,i){return i;}).filter(function(i){return planNodes[i].parentIdx===null;});
        var myPos = siblings.indexOf(selectedPlanNode), next = e.key==='ArrowDown' ? myPos+1 : myPos-1;
        if (next>=0 && next<siblings.length) target = siblings[next];
    }
    if (target !== null) { e.preventDefault(); selectPlanNode(target); }
});

// ========== Charts ==========
var CHART_COLORS = ['#4285f4','#ea4335','#34a853','#fbbc04','#9c27b0','#e91e63','#00bcd4','#ff9800','#8bc34a','#673ab7'];
function onAllRows(msg) {
    chartColumns=msg.columns; chartRows=msg.rows; chartDataLoaded=true; updateChartSelectors();
    var ci=document.getElementById('chartInfo');
    if (msg.truncated) { ci.textContent='Warning: only first '+msg.maxRows+' rows shown.'; ci.style.display=''; }
    else { ci.textContent=msg.rows.length+' row(s) loaded for chart.'; ci.style.display=''; }
    if (pendingBuildChart) { pendingBuildChart=false; buildChart(); }
}
function updateChartSelectors() {
    var cols=chartColumns.length>0?chartColumns:allColumns, xS=document.getElementById('chartX'), yS=document.getElementById('chartY');
    xS.innerHTML=''; yS.innerHTML='';
    cols.forEach(function(c){ xS.innerHTML+='<option value="'+esc(c.name)+'">'+esc(c.name)+'</option>'; yS.innerHTML+='<option value="'+esc(c.name)+'">'+esc(c.name)+'</option>'; });
    if (cols.length>=2) yS.selectedIndex=1;
}
function buildChart() {
    if (!chartDataLoaded) { pendingBuildChart=true; vscode.postMessage({type:'loadAllRows'}); return; }
    var canvas=document.getElementById('chartCanvas'),ctx=canvas.getContext('2d'),type=document.getElementById('chartType').value;
    var xCol=document.getElementById('chartX').value,yCol=document.getElementById('chartY').value;
    if (!xCol||!yCol||!chartRows.length) return;
    var data=[]; chartRows.forEach(function(row) { var yVal=parseFloat(row[yCol]!==null&&row[yCol]!==undefined?String(row[yCol]):''); if (!isNaN(yVal)) data.push({x:row[xCol]!==null&&row[xCol]!==undefined?String(row[xCol]):'',y:yVal}); });
    if (!data.length) return; canvas.width=800;canvas.height=500;ctx.clearRect(0,0,800,500);
    if (type==='pie') drawPieChart(ctx,data); else drawLineChart(ctx,data);
}
function drawPieChart(ctx,data) {
    var total=data.reduce(function(s,d){return s+Math.abs(d.y);},0); if (!total) return;
    var cx=300,cy=250,r=180,startAngle=-Math.PI/2;
    for (var i=0;i<data.length;i++) { var slice=Math.abs(data[i].y)/total,endAngle=startAngle+slice*2*Math.PI; ctx.beginPath();ctx.moveTo(cx,cy);ctx.arc(cx,cy,r,startAngle,endAngle);ctx.closePath(); ctx.fillStyle=CHART_COLORS[i%CHART_COLORS.length];ctx.fill(); ctx.strokeStyle=getComputedStyle(document.body).backgroundColor||'#1e1e1e';ctx.lineWidth=2;ctx.stroke(); if (slice>0.03){var mid=(startAngle+endAngle)/2,lr=r*0.65;ctx.fillStyle='#fff';ctx.font='bold 12px sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText((slice*100).toFixed(1)+'%',cx+Math.cos(mid)*lr,cy+Math.sin(mid)*lr);} startAngle=endAngle; }
    var lX=520,lY=40,fg=getComputedStyle(document.body).color||'#ccc'; ctx.font='12px sans-serif';ctx.textAlign='left';ctx.textBaseline='middle';
    for (var i=0;i<Math.min(data.length,20);i++){var y=lY+i*22;ctx.fillStyle=CHART_COLORS[i%CHART_COLORS.length];ctx.fillRect(lX,y-6,14,14);ctx.fillStyle=fg;ctx.fillText((data[i].x.length>20?data[i].x.substring(0,20)+'...':data[i].x)+' ('+data[i].y+')',lX+20,y+1);}
}
function drawLineChart(ctx,data) {
    var fg=getComputedStyle(document.body).color||'#ccc',gridColor='rgba(128,128,128,0.2)';
    var M={top:40,right:30,bottom:60,left:70},w=800-M.left-M.right,h=500-M.top-M.bottom;
    var yMin=Math.min.apply(null,data.map(function(d){return d.y;})),yMax=Math.max.apply(null,data.map(function(d){return d.y;})),yR=yMax-yMin||1;
    ctx.strokeStyle=gridColor;ctx.lineWidth=0.5;
    for(var i=0;i<=5;i++){var y=M.top+h-(i/5)*h;ctx.beginPath();ctx.moveTo(M.left,y);ctx.lineTo(M.left+w,y);ctx.stroke();ctx.fillStyle=fg;ctx.font='11px sans-serif';ctx.textAlign='right';ctx.textBaseline='middle';ctx.fillText((yMin+(i/5)*yR).toFixed(1),M.left-8,y);}
    ctx.fillStyle=fg;ctx.font='11px sans-serif';ctx.textAlign='center';ctx.textBaseline='top';
    var step=Math.max(1,Math.floor(data.length/10));
    for(var i=0;i<data.length;i+=step){var x=M.left+(i/(data.length-1||1))*w;ctx.save();ctx.translate(x,M.top+h+8);ctx.rotate(Math.PI/6);ctx.fillText(data[i].x.length>10?data[i].x.substring(0,10)+'..':data[i].x,0,0);ctx.restore();}
    ctx.beginPath();ctx.moveTo(M.left,M.top+h);
    for(var i=0;i<data.length;i++){var x=M.left+(i/(data.length-1||1))*w,y=M.top+h-((data[i].y-yMin)/yR)*h;ctx.lineTo(x,y);}
    ctx.lineTo(M.left+w,M.top+h);ctx.closePath();ctx.fillStyle='rgba(66,133,244,0.15)';ctx.fill();
    ctx.beginPath();ctx.strokeStyle=CHART_COLORS[0];ctx.lineWidth=2.5;
    for(var i=0;i<data.length;i++){var x=M.left+(i/(data.length-1||1))*w,y=M.top+h-((data[i].y-yMin)/yR)*h;if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);}ctx.stroke();
    for(var i=0;i<data.length;i++){var x=M.left+(i/(data.length-1||1))*w,y=M.top+h-((data[i].y-yMin)/yR)*h;ctx.beginPath();ctx.arc(x,y,4,0,Math.PI*2);ctx.fillStyle=CHART_COLORS[0];ctx.fill();ctx.strokeStyle=getComputedStyle(document.body).backgroundColor||'#1e1e1e';ctx.lineWidth=1.5;ctx.stroke();}
}
function exportChart() { vscode.postMessage({type:'savePng',dataUrl:document.getElementById('chartCanvas').toDataURL('image/png')}); }

function esc(text) { if (text===null||text===undefined) return ''; return String(text).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ========== Column resize ==========
(function(){
    var rl=document.createElement('div');rl.className='resize-line';document.body.appendChild(rl);
    var dragging=false,startX=0,startWidth=0,dragColIdx=-1,EDGE=8;
    function getThIdx(e){var ths=resultsTable.querySelectorAll('thead th');for(var i=0;i<ths.length;i++){var r=ths[i].getBoundingClientRect();if(e.clientX>=r.right-EDGE&&e.clientX<=r.right+2)return i;}return -1;}
    document.addEventListener('mousemove',function(e){if(dragging){rl.style.left=e.clientX+'px';return;}var th=e.target.closest&&e.target.closest('th');if(th&&resultsTable.contains(th)){th.style.cursor=getThIdx(e)>=0?'col-resize':'';}});
    resultsContainer.addEventListener('mousedown',function(e){var ci=getThIdx(e);if(ci<0)return;e.preventDefault();e.stopPropagation();var ths=resultsTable.querySelectorAll('thead th');
    if(!resultsTable.dataset.frozen){var widths=[];for(var i=0;i<ths.length;i++)widths.push(ths[i].offsetWidth);resultsTable.style.tableLayout='fixed';resultsTable.style.width=resultsTable.offsetWidth+'px';for(var i=0;i<ths.length;i++){ths[i].style.width=widths[i]+'px';ths[i].style.maxWidth='none';}resultsTable.dataset.frozen='1';}
    dragging=true;dragColIdx=ci;startX=e.clientX;startWidth=ths[ci].offsetWidth;rl.style.left=e.clientX+'px';rl.style.display='block';document.body.style.cursor='col-resize';document.body.style.userSelect='none';});
    document.addEventListener('mouseup',function(e){if(!dragging)return;var nw=Math.max(30,startWidth+e.clientX-startX);var ths=resultsTable.querySelectorAll('thead th');if(ths[dragColIdx]){ths[dragColIdx].style.width=nw+'px';ths[dragColIdx].style.minWidth=nw+'px';ths[dragColIdx].style.maxWidth=nw+'px';}dragging=false;dragColIdx=-1;rl.style.display='none';document.body.style.cursor='';document.body.style.userSelect='';});
})();

// ========== Cell modal ==========
(function(){
    var cm=document.getElementById('cellModal'),cc=document.getElementById('cellModalContent'),cb=document.getElementById('cellModalCopy');
    function close(){cm.classList.remove('visible');}
    document.getElementById('cellModalCloseX').addEventListener('click',close);
    document.getElementById('cellModalClose').addEventListener('click',close);
    cm.addEventListener('click',function(e){if(e.target===cm)close();});
    document.addEventListener('keydown',function(e){if(e.key==='Escape'&&cm.classList.contains('visible')){close();e.stopPropagation();}});
    document.addEventListener('click',function(e){if(editMode)return;var el=e.target.closest('td.cell-expandable[data-cellidx]');if(!el)return;var idx=parseInt(el.dataset.cellidx,10);var text=cellFullValues[idx];if(!text)return;cc.textContent='';cc.appendChild(hlCellText(text));cm.classList.add('visible');});
    cb.addEventListener('click',function(){navigator.clipboard.writeText(cc.textContent).then(function(){cb.textContent='Copied!';setTimeout(function(){cb.textContent='Copy';},1500);});});
    function hlCellText(text){var f=document.createDocumentFragment(),t=text.trim();if((t[0]==='{'&&t[t.length-1]==='}')||(t[0]==='['&&t[t.length-1]===']')){try{hlJson(JSON.stringify(JSON.parse(t),null,2),f);return f;}catch(e){}}hlPlain(text,f);return f;}
    function hlJson(text,parent){var re=/("(?:[^"\\\\]|\\\\.)*")\\s*(:?)|(\\b(?:true|false|null)\\b)|(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)/g,last=0,m;while((m=re.exec(text))!==null){if(m.index>last)parent.appendChild(document.createTextNode(text.slice(last,m.index)));var span=document.createElement('span');if(m[1]){span.className=m[2]?'hl-key':'hl-string';span.textContent=m[1]+m[2];}else if(m[3]){span.className='hl-keyword';span.textContent=m[3];}else if(m[4]){span.className='hl-number';span.textContent=m[4];}parent.appendChild(span);last=re.lastIndex;}if(last<text.length)parent.appendChild(document.createTextNode(text.slice(last)));}
    function hlPlain(text,parent){var re=/("(?:[^"\\\\]|\\\\.)*")|('(?:[^'\\\\]|\\\\.)*')|(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)/g,last=0,m;while((m=re.exec(text))!==null){if(m.index>last)parent.appendChild(document.createTextNode(text.slice(last,m.index)));var span=document.createElement('span');span.className=(m[1]||m[2])?'hl-string':'hl-number';span.textContent=m[0];parent.appendChild(span);last=re.lastIndex;}if(last<text.length)parent.appendChild(document.createTextNode(text.slice(last)));}
})();

// ========== Split handle drag ==========
(function(){
    var handle=document.getElementById('splitHandle'),ep=document.getElementById('editorPane');
    handle.addEventListener('mousedown',function(e){
        var startY=e.clientY,startH=ep.offsetHeight;
        function onMove(ev){ep.style.height=Math.max(60,Math.min(startH+ev.clientY-startY,window.innerHeight-150))+'px';if(window.monacoEditor)window.monacoEditor.layout();}
        function onUp(){document.removeEventListener('mousemove',onMove);}
        document.addEventListener('mousemove',onMove); document.addEventListener('mouseup',onUp,{once:true}); e.preventDefault();
    });
})();

// ========== Monaco Editor ==========
require(['vs/editor/editor.main'], function() {
    monaco.languages.register({ id: 'yql' });
    monaco.languages.setMonarchTokensProvider('yql', {
        ignoreCase: true,
        keywords: ['SELECT','FROM','WHERE','INSERT','UPDATE','DELETE','UPSERT','REPLACE','CREATE','ALTER','DROP','TABLE','INDEX','VIEW','DATABASE','TOPIC','JOIN','INNER','LEFT','RIGHT','FULL','OUTER','CROSS','ON','USING','GROUP','BY','ORDER','HAVING','LIMIT','OFFSET','DISTINCT','ALL','AS','AND','OR','NOT','IN','IS','NULL','BETWEEN','LIKE','EXISTS','CASE','WHEN','THEN','ELSE','END','IF','BEGIN','COMMIT','ROLLBACK','INTO','VALUES','SET','RETURNING','WITH','UNION','INTERSECT','EXCEPT','ASC','DESC','NULLS','FIRST','LAST','OVER','PARTITION','ROWS','RANGE','UNBOUNDED','PRECEDING','FOLLOWING','CURRENT','ROW','DECLARE','PRAGMA','DEFINE','PROCESS','REDUCE','FLATTEN','PRIMARY','KEY','UNIQUE','DEFAULT','CHECK','REFERENCES','CONSTRAINT','TRUE','FALSE','ANY','SOME','EVERY','COUNT','SUM','AVG','MIN','MAX','CAST','BITCAST','LIST','DICT','STRUCT','TUPLE','VARIANT','TAGGED','ENUM','CALLABLE','OPTIONAL','STREAM','FLOW','EVALUATE','IMPORT','EXPORT','BACKUP','RESTORE'],
        tokenizer: {
            root: [
                [/--[^\\r\\n]*/, 'comment'],
                [/\\/\\*/, { token: 'comment.block', next: '@comment' }],
                [/'([^'\\\\\\\\]|\\\\\\\\.)*'/, 'string'],
                [/"([^"\\\\\\\\]|\\\\\\\\.)*"/, 'string'],
                [/\`[^\`]*\`/, 'variable.other'],
                [/\\$[a-zA-Z_][a-zA-Z_0-9]*/, 'variable.parameter'],
                [/\\b\\d+(\\.\\d+)?([eE][+\\\\-]?\\d+)?\\b/, 'constant.numeric'],
                [/[a-zA-Z_][a-zA-Z_0-9]*(?=\\s*\\()/, 'entity.name.function'],
                [/[a-zA-Z_][a-zA-Z_0-9]*::[a-zA-Z_][a-zA-Z_0-9]*/, 'entity.name.function'],
                [/[a-zA-Z_][a-zA-Z_0-9]*/, { cases: { '@keywords': 'keyword.control', '@default': 'variable.other' } }],
                [/[;,.()\\[\\]{}]/, 'delimiter'],
                [/[+\\-*\\/=<>!&|^~%]/, 'operator'],
            ],
            comment: [
                [/[^\\/*]+/, 'comment.block'],
                [/\\*\\//, { token: 'comment.block', next: '@pop' }],
                [/[\\/*]/, 'comment.block'],
            ]
        }
    });
    monaco.languages.setLanguageConfiguration('yql', {
        comments: { lineComment: '--', blockComment: ['/*', '*/'] },
        brackets: [['(', ')'], ['[', ']'], ['{', '}']],
        autoClosingPairs: [
            { open: '(', close: ')' }, { open: '[', close: ']' }, { open: '{', close: '}' },
            { open: "'", close: "'", notIn: ['string'] }, { open: '"', close: '"', notIn: ['string'] },
            { open: '\`', close: '\`' },
        ],
    });

    monaco.languages.registerCompletionItemProvider('yql', {
        triggerCharacters: [' ', '.', '\`'],
        provideCompletionItems: function(model, position) {
            return new Promise(function(resolve) {
                var reqId = ++completionRequestId;
                pendingCompletionRequests.set(reqId, function(rawItems) {
                    resolve({
                        suggestions: rawItems.map(function(item) {
                            return {
                                label: item.label,
                                kind: item.kind,
                                detail: item.detail,
                                insertText: item.insertText || item.label,
                                sortText: item.sortText,
                            };
                        })
                    });
                });
                vscode.postMessage({
                    type: 'completionRequest',
                    requestId: reqId,
                    text: model.getValue(),
                    line: position.lineNumber,
                    column: position.column,
                });
            });
        }
    });

    window.monacoEditor = monaco.editor.create(document.getElementById('monacoContainer'), {
        value: ${escapedInitialContent},
        language: 'yql',
        theme: '${monacoTheme}',
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontSize: 13,
        lineNumbers: 'on',
        automaticLayout: false,
        wordWrap: 'off',
        renderWhitespace: 'none',
        contextmenu: true,
        quickSuggestions: { other: true, comments: false, strings: false },
        suggestOnTriggerCharacters: true,
    });

    window.monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, function() { executeQuery(); });

    if (pendingContent !== null) { window.monacoEditor.setValue(pendingContent); pendingContent = null; }
    if (pendingTriggerExecute) { pendingTriggerExecute = false; executeQuery(); }

    new ResizeObserver(function() { window.monacoEditor.layout(); }).observe(document.getElementById('monacoContainer'));

    // Track content changes (debounced)
    var contentChangeTimer = null;
    window.monacoEditor.onDidChangeModelContent(function() {
        if (contentChangeTimer) clearTimeout(contentChangeTimer);
        contentChangeTimer = setTimeout(function() {
            contentChangeTimer = null;
            vscode.postMessage({ type: 'contentChanged', text: window.monacoEditor.getValue() });
        }, 500);
    });

    // Signal that webview is ready for cached state replay
    vscode.postMessage({ type: 'webviewReady' });
});
`;
}
