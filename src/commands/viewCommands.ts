import * as vscode from 'vscode';
import { ConnectionManager } from '../services/connectionManager';
import { SchemeService } from '../services/schemeService';
import { QueryService } from '../services/queryService';
import { PermissionsProvider } from '../views/permissionsProvider';
import { NavigatorItem } from '../views/navigatorItems';
import { DashboardMetrics, SchemeEntryType } from '../models/types';
import { getMonitoringUrl } from '../models/connectionProfile';
import { MonitoringAuthClient, buildMonitoringAuthClient } from '../services/monitoringAuthClient';
import { generateTableDDL, generateViewDDL, generateTransferDDL, generateExternalTableDDL, generateStreamingQueryDDL } from '../utils/ddlGenerator.js';
import { DialectConverterViewProvider } from '../views/dialectConverterWebview';

export function registerViewCommands(
    context: vscode.ExtensionContext,
    connectionManager: ConnectionManager,
    permissionsProvider: PermissionsProvider,
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('ydb.viewPermissions', (item: NavigatorItem) =>
            viewPermissions(connectionManager, permissionsProvider, item)),
        vscode.commands.registerCommand('ydb.showDashboard', () =>
            showDashboard(connectionManager)),
        vscode.commands.registerCommand('ydb.toggleHideIdle', () => {
            // This will be connected to sessionProvider in extension.ts
            vscode.commands.executeCommand('ydb.refreshSessions');
        }),
        vscode.commands.registerCommand('ydb.createDDL', (item: NavigatorItem) =>
            createDDL(connectionManager, item)),
        vscode.commands.registerCommand('ydb.convertDialect', () =>
            vscode.commands.executeCommand(`${DialectConverterViewProvider.viewId}.focus`)),
    );

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            DialectConverterViewProvider.viewId,
            new DialectConverterViewProvider(),
        ),
    );
}

async function viewPermissions(
    connectionManager: ConnectionManager,
    permissionsProvider: PermissionsProvider,
    item: NavigatorItem,
): Promise<void> {
    try {
        const driver = await connectionManager.getDriver();
        const schemeService = new SchemeService(driver);
        const entry = await schemeService.describePath(item.fullPath);

        await vscode.commands.executeCommand('setContext', 'ydb.permissionsVisible', true);
        permissionsProvider.setPermissions(
            item.fullPath,
            entry.owner,
            entry.permissions ?? [],
            entry.effectivePermissions ?? [],
        );
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Failed to load permissions: ${message}`);
    }
}

let dashboardPanel: vscode.WebviewPanel | undefined;
let dashboardInterval: ReturnType<typeof setInterval> | undefined;

async function showDashboard(connectionManager: ConnectionManager): Promise<void> {
    const profile = connectionManager.getActiveProfile();
    if (!profile) {
        vscode.window.showWarningMessage('No active connection.');
        return;
    }

    const monitoringUrl = getMonitoringUrl(profile);
    if (!monitoringUrl) {
        vscode.window.showWarningMessage(
            'No monitoring URL configured for this connection. Edit the connection and add a monitoring URL.',
        );
        return;
    }

    if (dashboardPanel) {
        dashboardPanel.reveal();
        return;
    }

    dashboardPanel = vscode.window.createWebviewPanel(
        'ydbDashboard',
        `YDB Dashboard: ${profile.name}`,
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true },
    );

    dashboardPanel.onDidDispose(() => {
        dashboardPanel = undefined;
        if (dashboardInterval) {
            clearInterval(dashboardInterval);
            dashboardInterval = undefined;
        }
    });

    dashboardPanel.webview.html = buildDashboardHtml(profile.name);

    const authClient = buildMonitoringAuthClient(monitoringUrl, profile);

    const sendMetrics = async () => {
        if (!dashboardPanel) {return;}
        try {
            let queryService: QueryService | undefined;
            try {
                const driver = await connectionManager.getDriver();
                queryService = new QueryService(driver);
            } catch {
                queryService = undefined;
            }
            const metrics = await fetchDashboardMetrics(monitoringUrl, authClient, queryService);
            dashboardPanel.webview.postMessage({ type: 'dashboardData', metrics });
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            dashboardPanel.webview.postMessage({ type: 'dashboardError', message });
        }
    };

    await sendMetrics();
    dashboardInterval = setInterval(sendMetrics, 5000);
}

export async function fetchDashboardMetrics(
    monitoringUrl: string,
    authClient: MonitoringAuthClient,
    queryService?: QueryService,
): Promise<DashboardMetrics> {
    const viewerUrl = `${monitoringUrl}/viewer/json/cluster`;

    const [clusterData, runningQueries] = await Promise.all([
        authClient.httpGet(viewerUrl),
        fetchRunningQueriesCount(queryService),
    ]);

    const json = JSON.parse(clusterData);

    const metrics: DashboardMetrics = {
        cpuUsed: 0,
        cpuTotal: 0,
        storageUsed: 0,
        storageTotal: 0,
        memoryUsed: 0,
        memoryTotal: 0,
        networkThroughput: 0,
        runningQueries,
    };

    // Parse cluster-level metrics (values come as strings from YDB Viewer API)
    if (json.CoresUsed !== undefined) {
        metrics.cpuUsed = parseFloat(String(json.CoresUsed)) || 0;
    }
    if (json.CoresTotal !== undefined) {
        metrics.cpuTotal = parseFloat(String(json.CoresTotal)) || 0;
    }
    if (json.MemoryUsed !== undefined) {
        metrics.memoryUsed = parseInt(String(json.MemoryUsed), 10) || 0;
    }
    if (json.MemoryTotal !== undefined) {
        metrics.memoryTotal = parseInt(String(json.MemoryTotal), 10) || 0;
    }
    if (json.StorageUsed !== undefined) {
        metrics.storageUsed = parseInt(String(json.StorageUsed), 10) || 0;
    }
    if (json.StorageTotal !== undefined) {
        metrics.storageTotal = parseInt(String(json.StorageTotal), 10) || 0;
    }
    if (json.NetworkWriteThroughput !== undefined) {
        metrics.networkThroughput = parseFloat(String(json.NetworkWriteThroughput)) || 0;
    }

    return metrics;
}

async function fetchRunningQueriesCount(queryService: QueryService | undefined): Promise<number> {
    if (!queryService) {return 0;}
    try {
        const result = await queryService.executeQuery(
            "SELECT COUNT(*) AS Cnt FROM `.sys/query_sessions` WHERE State = 'EXECUTING'",
        );
        const row = result.rows?.[0];
        if (!row) {return 0;}
        const cnt = row.Cnt ?? row.cnt ?? 0;
        return Number(cnt) || 0;
    } catch {
        return 0;
    }
}

function buildDashboardHtml(name: string): string {
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
body {
    font-family: var(--vscode-font-family); color: var(--vscode-foreground);
    background: var(--vscode-editor-background); padding: 16px; margin: 0;
}
h1 { font-size: 18px; margin: 0 0 16px; }
.metrics {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 12px; margin-bottom: 16px;
}
.dash-card {
    background: var(--vscode-editor-selectionBackground); border-radius: 8px;
    padding: 16px; display: flex; flex-direction: column; align-items: center;
}
.dash-label { font-size: 12px; color: var(--vscode-descriptionForeground); margin-bottom: 8px; }
.dash-donut { position: relative; width: 80px; height: 80px; }
.dash-donut svg { width: 80px; height: 80px; }
.dash-value {
    position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
    font-size: 16px; font-weight: bold;
}
.dash-detail { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 6px; }
.dash-charts {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    gap: 12px; margin-top: 16px;
}
.dash-chart-card {
    background: var(--vscode-editor-selectionBackground); border-radius: 8px; padding: 12px;
}
.dash-chart-card h4 { font-size: 12px; margin-bottom: 8px; color: var(--vscode-descriptionForeground); }
.dash-chart-card canvas { width: 100%; height: 120px; }
.refresh-note { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 12px; }
.error {
    color: var(--vscode-errorForeground); padding: 12px;
    background: var(--vscode-inputValidation-errorBackground); border-radius: 4px;
}
#loading { text-align: center; padding: 40px; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
    <h1>YDB Dashboard: ${escapeHtml(name)}</h1>
    <div id="loading">Loading metrics...</div>
    <div id="content" style="display:none;"></div>
<script>
const MAX_HISTORY = 60;
const history = { cpu: [], memory: [], network: [] };

window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'dashboardData') onData(msg.metrics);
    if (msg.type === 'dashboardError') onError(msg.message);
});

function onData(m) {
    document.getElementById('loading').style.display = 'none';
    const content = document.getElementById('content');
    content.style.display = '';

    const cpuPct = m.cpuTotal > 0 ? (m.cpuUsed / m.cpuTotal * 100) : 0;
    const memPct = m.memoryTotal > 0 ? (m.memoryUsed / m.memoryTotal * 100) : 0;
    const storagePct = m.storageTotal > 0 ? (m.storageUsed / m.storageTotal * 100) : 0;

    const now = Date.now();
    addHistory('cpu', now, cpuPct);
    addHistory('memory', now, m.memoryUsed);
    addHistory('network', now, m.networkThroughput);

    let html = '<div class="metrics">';
    html += donutCard('CPU', cpuPct, m.cpuUsed.toFixed(1) + ' / ' + m.cpuTotal + ' cores');
    html += donutCard('Memory', memPct, formatBytes(m.memoryUsed) + ' / ' + formatBytes(m.memoryTotal));
    html += donutCard('Storage', storagePct, formatBytes(m.storageUsed) + ' / ' + formatBytes(m.storageTotal));
    html += donutCard('Network', 0, formatBytesPerSec(m.networkThroughput), true);
    html += donutCard('Running queries', 0, String(m.runningQueries), true);
    html += '</div>';

    html += '<div class="dash-charts">';
    html += '<div class="dash-chart-card"><h4>CPU %</h4><canvas id="chartCpu" width="300" height="120"></canvas></div>';
    html += '<div class="dash-chart-card"><h4>Memory</h4><canvas id="chartMem" width="300" height="120"></canvas></div>';
    html += '<div class="dash-chart-card"><h4>Network</h4><canvas id="chartNet" width="300" height="120"></canvas></div>';
    html += '</div>';

    html += '<div class="refresh-note">Auto-refreshing every 5 seconds</div>';
    content.innerHTML = html;

    setTimeout(() => {
        drawArea('chartCpu', history.cpu, '%');
        drawArea('chartMem', history.memory, 'bytes');
        drawArea('chartNet', history.network, 'bytes/s');
    }, 0);
}

function onError(message) {
    document.getElementById('loading').style.display = 'none';
    const content = document.getElementById('content');
    content.style.display = '';
    content.innerHTML = '<div class="error">Failed to fetch metrics: ' + esc(message) + '</div><p>Retrying in 5 seconds...</p>';
}

function addHistory(key, ts, value) {
    history[key].push({ ts, value });
    while (history[key].length > MAX_HISTORY) history[key].shift();
}

function donutCard(label, percent, detail, noDonut) {
    if (noDonut) {
        return '<div class="dash-card"><div class="dash-label">' + label + '</div>'
            + '<div style="font-size:28px;font-weight:bold;">' + detail + '</div></div>';
    }
    const r = 34, stroke = 6, c = 2 * Math.PI * r;
    const dashLen = (percent / 100) * c;
    const color = percent < 60 ? '#4caf50' : percent < 85 ? '#ff9800' : '#f44336';
    return '<div class="dash-card"><div class="dash-label">' + label + '</div>'
        + '<div class="dash-donut"><svg viewBox="0 0 80 80">'
        + '<circle cx="40" cy="40" r="' + r + '" fill="none" stroke="var(--vscode-input-background, #333)" stroke-width="' + stroke + '"/>'
        + '<circle cx="40" cy="40" r="' + r + '" fill="none" stroke="' + color + '" stroke-width="' + stroke
        + '" stroke-dasharray="' + dashLen + ' ' + c + '" stroke-linecap="round" transform="rotate(-90 40 40)"/>'
        + '</svg><div class="dash-value">' + percent.toFixed(1) + '%</div></div>'
        + '<div class="dash-detail">' + detail + '</div></div>';
}

function drawArea(canvasId, data, unit) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    if (data.length < 2) return;

    const values = data.map(p => p.value);
    const maxVal = Math.max(...values, 0.001);
    const minVal = Math.min(...values, 0);
    const range = maxVal - minVal || 1;

    const fg = getComputedStyle(document.body).color || '#ccc';

    // Grid
    ctx.strokeStyle = 'rgba(128,128,128,0.15)';
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 3; i++) {
        const y = 5 + ((3 - i) / 3) * (h - 20);
        ctx.beginPath(); ctx.moveTo(40, y); ctx.lineTo(w - 5, y); ctx.stroke();
        ctx.fillStyle = fg; ctx.font = '9px sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        let label = (minVal + (i / 3) * range).toFixed(1);
        if (unit === 'bytes') label = formatBytes(minVal + (i / 3) * range);
        else if (unit === 'bytes/s') label = formatBytes(minVal + (i / 3) * range) + '/s';
        ctx.fillText(label, 38, y);
    }

    // Area
    const chartW = w - 45, chartH = h - 20, startX = 40;
    ctx.beginPath();
    ctx.moveTo(startX, 5 + chartH);
    for (let i = 0; i < values.length; i++) {
        const x = startX + (i / (values.length - 1)) * chartW;
        const y = 5 + chartH - ((values[i] - minVal) / range) * chartH;
        ctx.lineTo(x, y);
    }
    ctx.lineTo(startX + chartW, 5 + chartH);
    ctx.closePath();
    ctx.fillStyle = 'rgba(66, 133, 244, 0.2)';
    ctx.fill();

    // Line
    ctx.beginPath();
    ctx.strokeStyle = '#4285f4';
    ctx.lineWidth = 1.5;
    for (let i = 0; i < values.length; i++) {
        const x = startX + (i / (values.length - 1)) * chartW;
        const y = 5 + chartH - ((values[i] - minVal) / range) * chartH;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Current value
    ctx.fillStyle = fg; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    const cur = values[values.length - 1];
    let curText = cur.toFixed(1);
    if (unit === 'bytes') curText = formatBytes(cur);
    else if (unit === 'bytes/s') curText = formatBytes(cur) + '/s';
    else if (unit) curText += ' ' + unit;
    ctx.fillText(curText, startX, 0);
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(k));
    return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
}

function formatBytesPerSec(bytes) {
    const kbps = bytes / 1024;
    if (kbps > 1024) return (kbps / 1024).toFixed(0) + ' MB/s';
    return kbps.toFixed(0) + ' KB/s';
}

function esc(text) {
    if (text === null || text === undefined) return '';
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
</script>
</body>
</html>`;
}

async function createDDL(
    connectionManager: ConnectionManager,
    item: NavigatorItem,
): Promise<void> {

    try {
        const driver = await connectionManager.getDriver();
        const queryService = new QueryService(driver);
        const db = driver.database.endsWith('/') ? driver.database.slice(0, -1) : driver.database;
        const fullPath = item.fullPath.startsWith('/') ? item.fullPath : db + '/' + item.fullPath;

        const isTable = item.entryType === SchemeEntryType.TABLE
            || item.entryType === SchemeEntryType.COLUMN_TABLE
            || item.entryType === SchemeEntryType.COLUMN_STORE;
        const isColumnTable = item.entryType === SchemeEntryType.COLUMN_TABLE
            || item.entryType === SchemeEntryType.COLUMN_STORE;
        const isTransfer = item.entryType === SchemeEntryType.TRANSFER;
        const isExternalTable = item.entryType === SchemeEntryType.EXTERNAL_TABLE;
        const isView = item.entryType === SchemeEntryType.VIEW;

        let ddl: string;
        if (isTable) {
            const desc = await queryService.describeTable(fullPath, isColumnTable);
            ddl = generateTableDDL(item.fullPath, desc);
        } else if (isExternalTable) {
            const desc = await queryService.describeExternalTable(fullPath);
            ddl = generateExternalTableDDL(item.fullPath, desc);
        } else if (isTransfer) {
            const desc = await queryService.describeTransfer(fullPath);
            ddl = generateTransferDDL(item.fullPath, desc, db);
        } else if (isView) {
            const queryText = await queryService.describeView(fullPath);
            ddl = generateViewDDL(item.fullPath, queryText);
        } else {
            // Streaming queries and other objects with queryText
            const queries = await queryService.loadStreamingQueries(db);
            const sq = queries.find(q => q.fullPath === item.fullPath);
            if (sq) {
                ddl = generateStreamingQueryDDL(item.fullPath, sq);
            } else {
                throw new Error(`Unsupported object type for DDL generation`);
            }
        }

        const doc = await vscode.workspace.openTextDocument({ content: ddl, language: 'yql' });
        await vscode.window.showTextDocument(doc, { preview: false });
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Failed to create DDL: ${message}`);
    }
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
