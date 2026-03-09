import * as vscode from 'vscode';
import { ConnectionManager } from '../services/connectionManager';
import { QueryService, CancellationError } from '../services/queryService';
import { showQueryResults, showExplainResults } from '../views/resultsWebview';
import { NavigatorItem } from '../views/navigatorItems';
import { openQueryWorkspace, insertTextIntoWorkspace, makeQueryInWorkspace, makeQueryInNewWorkspace, executeQueryFromEditor } from '../views/queryWorkspaceWebview';
import { YdbNavigatorProvider } from '../views/navigatorProvider';

export function registerQueryCommands(
    context: vscode.ExtensionContext,
    connectionManager: ConnectionManager,
    navigatorProvider?: YdbNavigatorProvider,
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('ydb.executeQuery', () => executeQuery(connectionManager)),
        vscode.commands.registerCommand('ydb.explainQuery', () => explainQuery(connectionManager)),
        vscode.commands.registerCommand('ydb.selectTop100', (item: NavigatorItem) => selectTop100(connectionManager, item)),
        vscode.commands.registerCommand('ydb.selectSystemView', (item: NavigatorItem) => selectSystemView(connectionManager, item)),
        vscode.commands.registerCommand('ydb.openQueryWorkspace', () => openQueryWorkspace(connectionManager)),
        vscode.commands.registerCommand('ydb.makeQuery', (item: NavigatorItem) => makeQueryInWorkspace(connectionManager, item.fullPath)),
        vscode.commands.registerCommand('ydb.makeQueryNewWindow', (item: NavigatorItem) => makeQueryInNewWorkspace(connectionManager, item.fullPath)),
        vscode.commands.registerCommand('ydb.insertTablePath', (item: NavigatorItem) => insertTextIntoWorkspace(connectionManager, item.fullPath)),
        vscode.commands.registerCommand('ydb.copyPathToClipboard', (item: NavigatorItem) => {
            vscode.env.clipboard.writeText(item.fullPath);
            vscode.window.showInformationMessage(`Copied: ${item.fullPath}`);
        }),
        vscode.commands.registerCommand('ydb.copyConnectionPathToClipboard', (item: NavigatorItem) => {
            const profile = connectionManager.getActiveProfile();
            const connectionName = profile?.name ?? 'unknown';
            const pathWithoutLeadingSlash = item.fullPath.replace(/^\//, '');
            const text = `"${connectionName}"."${pathWithoutLeadingSlash}"`;
            vscode.env.clipboard.writeText(text);
            vscode.window.showInformationMessage(`Copied: ${text}`);
        }),
        vscode.commands.registerCommand('ydb.executeQueryFromEditor', () => executeQueryFromEditor()),
        vscode.commands.registerCommand('ydb.startStreamingQuery', (item: NavigatorItem) => startStreamingQuery(connectionManager, item)),
        vscode.commands.registerCommand('ydb.stopStreamingQuery', (item: NavigatorItem) => stopStreamingQuery(connectionManager, item)),
        vscode.commands.registerCommand('ydb.viewStreamingQuerySource', (item: NavigatorItem) => viewStreamingQuerySource(connectionManager, item)),
        vscode.commands.registerCommand('ydb.refreshStreamingQueries', () => navigatorProvider?.refresh()),
    );
}

async function executeQuery(connectionManager: ConnectionManager): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('No active editor. Open a .yql file first.');
        return;
    }

    const selection = editor.selection;
    const queryText = selection.isEmpty
        ? editor.document.getText()
        : editor.document.getText(selection);

    if (!queryText.trim()) {
        vscode.window.showWarningMessage('No query text to execute.');
        return;
    }

    try {
        const result = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Executing YQL query...', cancellable: true },
            async (_progress, token) => {
                const driver = await connectionManager.getDriver();
                const queryService = new QueryService(driver);
                return queryService.executeQuery(queryText, token);
            },
        );

        showQueryResults(result, queryText);
    } catch (err: unknown) {
        if (err instanceof CancellationError) { return; }
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage('Query execution failed', { modal: true, detail: message });
    }
}

async function explainQuery(connectionManager: ConnectionManager): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('No active editor.');
        return;
    }

    const selection = editor.selection;
    const queryText = selection.isEmpty
        ? editor.document.getText()
        : editor.document.getText(selection);

    if (!queryText.trim()) {
        vscode.window.showWarningMessage('No query text to explain.');
        return;
    }

    try {
        const result = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Explaining YQL query...', cancellable: true },
            async (_progress, token) => {
                const driver = await connectionManager.getDriver();
                const queryService = new QueryService(driver);
                return queryService.explainQuery(queryText, token);
            },
        );

        showExplainResults(result, queryText);
    } catch (err: unknown) {
        if (err instanceof CancellationError) { return; }
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage('Explain failed', { modal: true, detail: message });
    }
}

async function selectSystemView(connectionManager: ConnectionManager, item: NavigatorItem): Promise<void> {
    const viewPath = item.fullPath;
    const queryText = `SELECT * FROM \`${viewPath}\``;

    try {
        const result = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Fetching ${item.label}...`, cancellable: true },
            async (_progress, token) => {
                const driver = await connectionManager.getDriver();
                const queryService = new QueryService(driver);
                return queryService.executeScanQuery(queryText, token);
            },
        );

        showQueryResults(result, queryText);
    } catch (err: unknown) {
        if (err instanceof CancellationError) { return; }
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage('Select failed', { modal: true, detail: message });
    }
}

async function selectTop100(connectionManager: ConnectionManager, item: NavigatorItem): Promise<void> {
    const tablePath = item.fullPath;
    const queryText = `SELECT * FROM \`${tablePath}\` LIMIT 100`;

    try {
        const result = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Fetching top 100 from ${item.label}...`, cancellable: true },
            async (_progress, token) => {
                const driver = await connectionManager.getDriver();
                const queryService = new QueryService(driver);
                return queryService.executeScanQuery(queryText, token);
            },
        );

        showQueryResults(result, queryText);
    } catch (err: unknown) {
        if (err instanceof CancellationError) { return; }
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage('Select failed', { modal: true, detail: message });
    }
}

async function startStreamingQuery(connectionManager: ConnectionManager, item: NavigatorItem): Promise<void> {
    const path = item.fullPath;
    const queryText = `ALTER STREAMING QUERY \`${path}\` SET (RUN=TRUE)`;

    try {
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Starting streaming query ${item.label}...`, cancellable: true },
            async (_progress, token) => {
                const driver = await connectionManager.getDriver();
                const queryService = new QueryService(driver);
                await queryService.executeQuery(queryText, token);
            },
        );
        vscode.window.showInformationMessage(`Streaming query "${item.label}" started.`);
        vscode.commands.executeCommand('ydb.refreshStreamingQueries');
    } catch (err: unknown) {
        if (err instanceof CancellationError) { return; }
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage('Failed to start streaming query', { modal: true, detail: message });
    }
}

async function stopStreamingQuery(connectionManager: ConnectionManager, item: NavigatorItem): Promise<void> {
    const path = item.fullPath;
    const queryText = `ALTER STREAMING QUERY \`${path}\` SET (RUN=FALSE)`;

    try {
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Stopping streaming query ${item.label}...`, cancellable: true },
            async (_progress, token) => {
                const driver = await connectionManager.getDriver();
                const queryService = new QueryService(driver);
                await queryService.executeQuery(queryText, token);
            },
        );
        vscode.window.showInformationMessage(`Streaming query "${item.label}" stopped.`);
        vscode.commands.executeCommand('ydb.refreshStreamingQueries');
    } catch (err: unknown) {
        if (err instanceof CancellationError) { return; }
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage('Failed to stop streaming query', { modal: true, detail: message });
    }
}

export async function previewTopic(connectionManager: ConnectionManager, fullPath: string): Promise<void> {
    try {
        const driver = await connectionManager.getDriver();
        const queryService = new QueryService(driver);
        const versionResult = await queryService.executeQuery('SELECT version()');

        let version = '';
        if (versionResult.rows.length > 0) {
            const row = versionResult.rows[0];
            const firstKey = Object.keys(row)[0];
            if (firstKey !== undefined) {
                version = String(row[firstKey]);
            }
        }

        // Version may be base64-encoded (e.g. "c3RhYmxlLTI1LTQtMS04" → "stable-25-4-1-8")
        let decoded = version;
        try {
            const candidate = Buffer.from(version, 'base64').toString('utf-8');
            if (/^[a-z0-9.-]+$/i.test(candidate)) {
                decoded = candidate;
            }
        } catch {
            // not base64, use as-is
        }

        let supported = false;
        if (decoded.startsWith('stable-')) {
            const match = decoded.match(/^stable-(\d+)-(\d+)/);
            if (match) {
                const major = parseInt(match[1], 10);
                const minor = parseInt(match[2], 10);
                supported = major > 26 || (major === 26 && minor >= 1);
            }
        } else {
            // Non-stable builds (e.g. "main", trunk, dev) — allow preview
            supported = true;
        }

        if (!supported) {
            vscode.window.showErrorMessage(
                `Topic preview requires YDB version >= 26.1, current version: ${decoded || 'unknown'}`,
            );
            return;
        }

        const query = `SELECT * FROM \`${fullPath}\` WITH (FORMAT = "raw", SCHEMA = (data String), STREAMING = "TRUE") LIMIT 200`;
        makeQueryInWorkspace(connectionManager, query, true);
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage('Topic preview failed', { modal: true, detail: message });
    }
}

async function viewStreamingQuerySource(connectionManager: ConnectionManager, item: NavigatorItem): Promise<void> {
    const path = item.fullPath;
    try {
        const driver = await connectionManager.getDriver();
        const queryService = new QueryService(driver);
        const database = connectionManager.getActiveProfile()?.database ?? '';
        const queries = await queryService.loadStreamingQueries(database);
        const query = queries.find(q => q.fullPath === path);
        const content = query?.queryText ?? `-- Source not found for ${path}`;
        const doc = await vscode.workspace.openTextDocument({ content, language: 'yql' });
        await vscode.window.showTextDocument(doc, { preview: true });
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage('Failed to load query source', { modal: true, detail: message });
    }
}
