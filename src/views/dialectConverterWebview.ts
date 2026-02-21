import * as vscode from 'vscode';
import * as https from 'https';

const SQLGLOT_URL = 'https://functions.yandexcloud.net/d4e4evd4n6rg50cb3mag';

export class DialectConverterViewProvider implements vscode.WebviewViewProvider {
    static readonly viewId = 'ydbDialectConverterView';

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        webviewView.webview.options = { enableScripts: true };

        webviewView.webview.onDidReceiveMessage(async (message) => {
            if (message.type === 'getDialects') {
                try {
                    const dialects = await fetchDialects();
                    webviewView.webview.postMessage({ type: 'dialects', dialects });
                } catch (err: unknown) {
                    const errorMsg = err instanceof Error ? err.message : String(err);
                    webviewView.webview.postMessage({ type: 'dialectsError', message: errorMsg });
                }
            } else if (message.type === 'convert') {
                try {
                    const result = await convertSql(message.sql, message.dialect);
                    webviewView.webview.postMessage({ type: 'result', convertedSql: result });
                } catch (err: unknown) {
                    const errorMsg = err instanceof Error ? err.message : String(err);
                    webviewView.webview.postMessage({ type: 'error', message: errorMsg });
                }
            }
        });

        webviewView.webview.html = buildConverterHtml();
    }
}

export function fetchDialects(): Promise<string[]> {
    return new Promise((resolve, reject) => {
        const url = new URL(SQLGLOT_URL);

        const req = https.request(
            {
                hostname: url.hostname,
                path: url.pathname + '?action=dialects',
                method: 'GET',
                headers: { 'Accept': 'application/json' },
            },
            (res) => {
                let data = '';
                res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
                res.on('end', () => {
                    if (res.statusCode !== 200) {
                        reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                        return;
                    }
                    try {
                        const json = JSON.parse(data);
                        if (Array.isArray(json.dialects)) {
                            resolve(json.dialects as string[]);
                        } else {
                            reject(new Error('Unexpected response: missing dialects field'));
                        }
                    } catch {
                        reject(new Error(`Invalid response: ${data}`));
                    }
                });
                res.on('error', reject);
            },
        );

        req.on('error', reject);
        req.setTimeout(10000, () => {
            req.destroy(new Error('Request timed out'));
        });
        req.end();
    });
}

export function convertSql(sql: string, dialect: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ sql, dialect });
        const url = new URL(SQLGLOT_URL);

        const req = https.request(
            {
                hostname: url.hostname,
                path: url.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                },
            },
            (res) => {
                let data = '';
                res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
                res.on('end', () => {
                    if (res.statusCode !== 200) {
                        reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                        return;
                    }
                    try {
                        const json = JSON.parse(data);
                        resolve(json.convertedSql ?? '');
                    } catch {
                        reject(new Error(`Invalid response: ${data}`));
                    }
                });
                res.on('error', reject);
            },
        );

        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

export function buildConverterHtml(): string {
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
* { box-sizing: border-box; }
html, body {
    height: 100%;
    margin: 0;
    padding: 0;
    overflow: hidden;
}
body {
    display: flex;
    flex-direction: column;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 8px;
    gap: 6px;
}
.toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
}
.toolbar label {
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    white-space: nowrap;
}
select {
    flex: 1;
    min-width: 0;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    padding: 3px 6px;
    border-radius: 3px;
    font-family: inherit;
    font-size: inherit;
}
button {
    padding: 4px 14px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 3px;
    cursor: pointer;
    font-size: 12px;
    white-space: nowrap;
    flex-shrink: 0;
}
button:hover { background: var(--vscode-button-hoverBackground); }
button:disabled { opacity: 0.5; cursor: default; }
.report-link {
    margin-left: auto;
    font-size: 11px;
    color: var(--vscode-textLink-foreground);
    text-decoration: none;
    white-space: nowrap;
}
.report-link:hover { text-decoration: underline; }
.columns {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    flex: 1;
    min-height: 0;
}
.col {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-height: 0;
}
.col-label {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    flex-shrink: 0;
}
textarea {
    flex: 1;
    min-height: 0;
    resize: none;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    padding: 6px 8px;
    font-family: var(--vscode-editor-font-family);
    font-size: var(--vscode-editor-font-size);
    border-radius: 3px;
}
.error {
    font-size: 11px;
    color: var(--vscode-errorForeground);
    flex-shrink: 0;
}
</style>
</head>
<body>
<div class="toolbar">
    <label>Dialect:</label>
    <select id="dialect" disabled>
        <option>Loading...</option>
    </select>
    <button id="convertBtn" onclick="convert()" disabled>Convert</button>
    <button id="copyBtn" onclick="copyResult()" disabled>Copy</button>
</div>
<div style="text-align:right;">
    <a class="report-link" href="https://forms.yandex.ru/u/697b4f569029021fd618b1f0/">Report issue</a>
</div>
<div class="columns">
    <div class="col">
        <span class="col-label">Source SQL</span>
        <textarea id="sqlInput" placeholder="Enter SQL query here..."></textarea>
    </div>
    <div class="col">
        <span class="col-label">Result (YQL)</span>
        <textarea id="sqlOutput" readonly placeholder="Converted YQL will appear here..."></textarea>
    </div>
</div>
<div id="errorMsg" class="error" style="display:none;"></div>
<script>
const vscode = acquireVsCodeApi();

vscode.postMessage({ type: 'getDialects' });

function convert() {
    const sql = document.getElementById('sqlInput').value.trim();
    const dialect = document.getElementById('dialect').value;
    if (!sql) return;

    document.getElementById('convertBtn').disabled = true;
    document.getElementById('convertBtn').textContent = 'Converting...';
    document.getElementById('errorMsg').style.display = 'none';
    document.getElementById('sqlOutput').value = '';
    document.getElementById('copyBtn').disabled = true;

    vscode.postMessage({ type: 'convert', sql, dialect });
}

function copyResult() {
    navigator.clipboard.writeText(document.getElementById('sqlOutput').value);
}

window.addEventListener('message', (event) => {
    const msg = event.data;

    if (msg.type === 'dialects') {
        const select = document.getElementById('dialect');
        select.innerHTML = '';
        for (const d of msg.dialects) {
            const opt = document.createElement('option');
            opt.value = d;
            opt.textContent = d;
            select.appendChild(opt);
        }
        select.disabled = false;
        document.getElementById('convertBtn').disabled = false;
    } else if (msg.type === 'dialectsError') {
        document.getElementById('errorMsg').textContent = 'Failed to load dialects: ' + msg.message;
        document.getElementById('errorMsg').style.display = '';
    } else if (msg.type === 'result') {
        document.getElementById('convertBtn').disabled = false;
        document.getElementById('convertBtn').textContent = 'Convert';
        document.getElementById('sqlOutput').value = msg.convertedSql;
        document.getElementById('copyBtn').disabled = false;
        document.getElementById('errorMsg').style.display = 'none';
    } else if (msg.type === 'error') {
        document.getElementById('convertBtn').disabled = false;
        document.getElementById('convertBtn').textContent = 'Convert';
        document.getElementById('errorMsg').textContent = 'Error: ' + msg.message;
        document.getElementById('errorMsg').style.display = '';
    }
});
</script>
</body>
</html>`;
}
