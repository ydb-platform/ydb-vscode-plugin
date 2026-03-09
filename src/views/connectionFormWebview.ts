import * as vscode from 'vscode';
import { ConnectionManager } from '../services/connectionManager';
import { AUTH_TYPE_LABELS, ConnectionProfile } from '../models/connectionProfile';
import { RagService, detectAndEnsureRag, checkOllamaAvailable } from '../services/ragService';

const panels: Map<string, vscode.WebviewPanel> = new Map();

export function showConnectionForm(connectionManager: ConnectionManager, editProfile?: ConnectionProfile, ragService?: RagService): void {
    const panelKey = editProfile ? `edit-${editProfile.id}` : 'new';

    const existing = panels.get(panelKey);
    if (existing) {
        existing.reveal(vscode.ViewColumn.One);
        return;
    }

    const title = editProfile ? 'Edit YDB Connection' : 'New YDB Connection';

    const panel = vscode.window.createWebviewPanel(
        'ydbConnectionForm',
        title,
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true },
    );

    panels.set(panelKey, panel);

    panel.webview.html = buildFormHtml(!!editProfile);

    setTimeout(() => {
        if (editProfile) {
            panel.webview.postMessage({ type: 'fillForm', profile: editProfile });
        }
        if (ragService) {
            panel.webview.postMessage({ type: 'ragRunning', running: ragService.isRunning });
        }
        const ollamaUrl = vscode.workspace.getConfiguration('ydb').get<string>('ragOllamaUrl', '');
        if (ollamaUrl) {
            checkOllamaAvailable(ollamaUrl).then(available => {
                panel.webview.postMessage({ type: 'ollamaStatus', available, url: ollamaUrl });
            });
        } else {
            panel.webview.postMessage({ type: 'ollamaStatus', available: false, url: '' });
        }
    }, 100);

    panel.webview.onDidReceiveMessage(async (message) => {
        switch (message.type) {
            case 'save': {
                const profile: Omit<ConnectionProfile, 'id'> = message.profile;
                if (editProfile) {
                    await connectionManager.updateProfile(editProfile.id, profile);
                    vscode.window.showInformationMessage(`Connection "${profile.name}" updated.`);
                } else {
                    const saved = await connectionManager.addProfile(profile);
                    vscode.window.showInformationMessage(`Connection "${saved.name}" added.`);
                }
                panel.dispose();
                break;
            }
            case 'testConnection': {
                const profile: Omit<ConnectionProfile, 'id'> = message.profile;
                try {
                    await connectionManager.testConnection(profile);
                    panel.webview.postMessage({ type: 'testResult', success: true });
                } catch (err: unknown) {
                    const errorMsg = err instanceof Error ? err.message : String(err);
                    panel.webview.postMessage({ type: 'testResult', success: false, error: errorMsg });
                }
                break;
            }
            case 'selectFile': {
                const fileUri = await vscode.window.showOpenDialog({
                    canSelectFiles: true,
                    canSelectFolders: false,
                    filters: { 'JSON files': ['json'] },
                    title: 'Select service account key file',
                });
                if (fileUri && fileUri.length > 0) {
                    panel.webview.postMessage({
                        type: 'fileSelected',
                        path: fileUri[0].fsPath,
                    });
                }
                break;
            }
            case 'selectCaFile': {
                const caFileUri = await vscode.window.showOpenDialog({
                    canSelectFiles: true,
                    canSelectFolders: false,
                    filters: { 'PEM files': ['pem', 'crt', 'cer'], 'All files': ['*'] },
                    title: 'Select CA certificate file',
                });
                if (caFileUri && caFileUri.length > 0) {
                    panel.webview.postMessage({
                        type: 'caFileSelected',
                        path: caFileUri[0].fsPath,
                    });
                }
                break;
            }
            case 'cancel': {
                panel.dispose();
                break;
            }
            case 'checkOllama': {
                const ollamaUrl = vscode.workspace.getConfiguration('ydb').get<string>('ragOllamaUrl', '');
                if (!ollamaUrl) {
                    panel.webview.postMessage({ type: 'ollamaStatus', available: false, url: '' });
                    break;
                }
                const available = await checkOllamaAvailable(ollamaUrl);
                panel.webview.postMessage({ type: 'ollamaStatus', available, url: ollamaUrl });
                break;
            }
            case 'detectRag':
            case 'downloadRag': {
                if (!ragService) {
                    panel.webview.postMessage({ type: 'ragStatus', error: 'RAG service not initialized' });
                    break;
                }
                const force = message.type === 'downloadRag';
                const profile: Omit<ConnectionProfile, 'id'> = message.profile;

                panel.webview.postMessage({ type: 'ragStatus', progress: 'Connecting to YDB...' });

                let driver;
                try {
                    driver = await connectionManager.createTemporaryDriver(profile);
                } catch (err) {
                    panel.webview.postMessage({
                        type: 'ragStatus',
                        error: `Connection failed: ${err instanceof Error ? err.message : String(err)}`,
                    });
                    break;
                }

                try {
                    await detectAndEnsureRag(driver, ragService, force, (msg) => {
                        panel.webview.postMessage({ type: 'ragStatus', progress: msg });
                    });
                    ragService.enable();
                    panel.webview.postMessage({ type: 'ragStatus', success: true });
                    panel.webview.postMessage({ type: 'ragRunning', running: ragService.isRunning, autoEnabled: true });
                } catch (err) {
                    panel.webview.postMessage({
                        type: 'ragStatus',
                        error: err instanceof Error ? err.message : String(err),
                    });
                } finally {
                    driver.close();
                }
                break;
            }
            case 'toggleRag': {
                if (!ragService) {
                    panel.webview.postMessage({ type: 'ragRunning', running: false });
                    break;
                }
                if (message.enabled) {
                    if (!ragService.findAnyCachedFile()) {
                        const toggleProfile: Omit<ConnectionProfile, 'id'> = message.profile;
                        panel.webview.postMessage({ type: 'ragStatus', progress: 'Connecting to YDB...' });
                        let toggleDriver;
                        try {
                            toggleDriver = await connectionManager.createTemporaryDriver(toggleProfile);
                        } catch (err) {
                            panel.webview.postMessage({
                                type: 'ragStatus',
                                error: `Connection failed: ${err instanceof Error ? err.message : String(err)}`,
                            });
                            panel.webview.postMessage({ type: 'ragRunning', running: false });
                            break;
                        }
                        let ok = true;
                        try {
                            await detectAndEnsureRag(toggleDriver, ragService, false, (msg) => {
                                panel.webview.postMessage({ type: 'ragStatus', progress: msg });
                            });
                        } catch (err) {
                            panel.webview.postMessage({
                                type: 'ragStatus',
                                error: err instanceof Error ? err.message : String(err),
                            });
                            ok = false;
                        } finally {
                            toggleDriver.close();
                        }
                        if (!ok) {
                            panel.webview.postMessage({ type: 'ragRunning', running: false });
                            break;
                        }
                    }
                    ragService.enable();
                    panel.webview.postMessage({ type: 'ragStatus', success: true });
                } else {
                    ragService.disable();
                    panel.webview.postMessage({ type: 'ragStatus', progress: 'RAG stopped.' });
                }
                panel.webview.postMessage({ type: 'ragRunning', running: ragService.isRunning });
                break;
            }
        }
    });

    panel.onDidDispose(() => {
        panels.delete(panelKey);
    });
}

export function buildFormHtml(isEdit: boolean): string {
    const authOptions = Object.entries(AUTH_TYPE_LABELS)
        .map(([value, label]) => `<option value="${value}">${label}</option>`)
        .join('\n');

    const formTitle = isEdit ? 'Edit YDB Connection' : 'New YDB Connection';
    const saveLabel = isEdit ? 'Save Changes' : 'Save';

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
    body {
        font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
        font-size: var(--vscode-font-size, 13px);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        padding: 20px;
        margin: 0;
    }
    .form-container {
        max-width: 500px;
        margin: 0 auto;
    }
    h2 {
        margin: 0 0 20px;
        font-weight: 600;
    }
    .field {
        margin-bottom: 16px;
    }
    label {
        display: block;
        margin-bottom: 4px;
        font-weight: 500;
    }
    label .required {
        color: var(--vscode-errorForeground);
    }
    input[type="text"],
    input[type="password"],
    select {
        width: 100%;
        padding: 6px 8px;
        border: 1px solid var(--vscode-input-border, #3c3c3c);
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border-radius: 2px;
        font-size: var(--vscode-font-size, 13px);
        font-family: inherit;
        box-sizing: border-box;
    }
    input:focus, select:focus {
        outline: 1px solid var(--vscode-focusBorder);
        border-color: var(--vscode-focusBorder);
    }
    .checkbox-field {
        display: flex;
        align-items: center;
        gap: 8px;
    }
    .checkbox-field label {
        margin-bottom: 0;
        font-weight: normal;
    }
    .auth-fields {
        display: none;
        margin-top: 8px;
        padding: 12px;
        background: var(--vscode-textBlockQuote-background);
        border-radius: 4px;
    }
    .auth-fields.visible {
        display: block;
    }
    .auth-fields .field:last-child {
        margin-bottom: 0;
    }
    .file-picker {
        display: flex;
        gap: 8px;
    }
    .file-picker input {
        flex: 1;
    }
    .buttons {
        display: flex;
        gap: 8px;
        margin-top: 24px;
    }
    button {
        padding: 6px 14px;
        border: none;
        border-radius: 2px;
        font-size: var(--vscode-font-size, 13px);
        font-family: inherit;
        cursor: pointer;
    }
    button.primary {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
    }
    button.primary:hover {
        background: var(--vscode-button-hoverBackground);
    }
    button.secondary {
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
    }
    button.secondary:hover {
        background: var(--vscode-button-secondaryHoverBackground);
    }
    button:disabled {
        opacity: 0.5;
        cursor: default;
    }
    .test-result {
        margin-top: 12px;
        padding: 8px 12px;
        border-radius: 4px;
        display: none;
    }
    .test-result.success {
        display: block;
        background: var(--vscode-inputValidation-infoBackground, #063b49);
        border: 1px solid var(--vscode-inputValidation-infoBorder, #007acc);
    }
    .test-result.error {
        display: block;
        background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
        border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
    }
    .validation-error {
        color: var(--vscode-errorForeground);
        font-size: 12px;
        margin-top: 4px;
        display: none;
    }
    .separator {
        border: none;
        border-top: 1px solid var(--vscode-panel-border, #333);
        margin: 20px 0;
    }
    .rag-status {
        margin-top: 10px;
        padding: 8px 12px;
        border-radius: 4px;
        font-size: 12px;
        color: var(--vscode-descriptionForeground);
        background: var(--vscode-textBlockQuote-background);
        display: none;
    }
    .rag-status.visible { display: block; }
    .rag-status.success {
        color: var(--vscode-terminal-ansiGreen, #4ec9b0);
        background: var(--vscode-inputValidation-infoBackground, #063b49);
    }
    .rag-status.error {
        color: var(--vscode-errorForeground);
        background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
    }
    .rag-badge {
        font-size: 11px;
        padding: 2px 8px;
        border-radius: 10px;
        margin-left: 8px;
    }
    .rag-badge.running {
        color: var(--vscode-terminal-ansiGreen, #4ec9b0);
        background: rgba(78, 201, 176, 0.1);
    }
    .rag-badge.stopped {
        color: var(--vscode-descriptionForeground);
    }
    .rag-badge.unavailable {
        color: var(--vscode-errorForeground);
    }
</style>
</head>
<body>
<div class="form-container">
    <h2>${formTitle}</h2>

    <div class="field">
        <label>Connection Name <span class="required">*</span></label>
        <input type="text" id="name" placeholder="My YDB">
        <div class="validation-error" id="name-error">Name is required</div>
    </div>

    <div class="field">
        <label>Host <span class="required">*</span></label>
        <div style="display:flex;gap:8px;align-items:flex-start">
            <div style="flex:1">
                <input type="text" id="host" placeholder="localhost">
                <div class="validation-error" id="host-error">Host is required</div>
            </div>
            <div style="width:90px">
                <input type="text" id="port" placeholder="2135" value="2135" style="text-align:right">
                <div style="font-size:11px;color:var(--vscode-descriptionForeground);margin-top:2px">Port</div>
            </div>
        </div>
    </div>

    <div class="field">
        <label>Database <span class="required">*</span></label>
        <input type="text" id="database" placeholder="/local">
        <div class="validation-error" id="database-error">Database is required</div>
    </div>

    <hr class="separator">

    <div class="field">
        <label>Authentication</label>
        <select id="authType">
            ${authOptions}
        </select>
    </div>

    <div class="auth-fields" id="auth-static">
        <div class="field">
            <label>Username</label>
            <input type="text" id="username" placeholder="Username">
        </div>
        <div class="field">
            <label>Password</label>
            <input type="password" id="password" placeholder="Password">
        </div>
    </div>

    <div class="auth-fields" id="auth-token">
        <div class="field">
            <label>Access Token</label>
            <input type="password" id="token" placeholder="Token">
        </div>
    </div>

    <div class="auth-fields" id="auth-serviceAccount">
        <div class="field">
            <label>Service Account Key File</label>
            <div class="file-picker">
                <input type="text" id="serviceAccountKeyFile" placeholder="Path to JSON key file" readonly>
                <button class="secondary" onclick="selectFile()">Browse...</button>
            </div>
        </div>
    </div>

    <hr class="separator">

    <div class="field">
        <div class="checkbox-field">
            <input type="checkbox" id="secure" checked>
            <label for="secure">Secure connection (grpcs)</label>
        </div>
    </div>

    <div class="field">
        <label>Custom CA Certificate</label>
        <div class="file-picker">
            <input type="text" id="tlsCaCertFile" placeholder="Path to PEM file (optional, overrides built-in YC cert)" readonly>
            <button class="secondary" onclick="selectCaFile()">Browse...</button>
            <button class="secondary" onclick="clearCaFile()">Clear</button>
        </div>
        <div style="font-size:11px;color:var(--vscode-descriptionForeground);margin-top:2px">Optional. Overrides the built-in Yandex Cloud CA. Also configurable via <code>ydb.tlsCaCertFile</code> setting.</div>
    </div>

    <div class="field">
        <label>Monitoring URL</label>
        <input type="text" id="monitoringUrl" placeholder="http://localhost:8765 (optional)">
    </div>

    <div class="test-result" id="testResult"></div>

    <hr class="separator">

    <div style="font-size:12px;font-weight:600;margin-bottom:8px;color:var(--vscode-descriptionForeground)">YQL Reference (RAG)</div>
    <div style="font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:10px">
        Downloads a pre-built YQL documentation index for AI-assisted query writing via MCP.
    </div>
    <div class="field" style="margin-bottom:8px">
        <div class="checkbox-field">
            <input type="checkbox" id="useRag" checked>
            <label for="useRag">Use RAG</label>
            <span id="ragRunningBadge" class="rag-badge stopped">○ Not running</span>
        </div>
    </div>
    <div style="display:flex;align-items:center;gap:6px;margin-bottom:10px;font-size:11px;color:var(--vscode-descriptionForeground)">
        <span>Ollama:</span>
        <code id="ollamaUrlDisplay" style="font-size:11px">—</code>
        <span id="ollamaBadge" class="rag-badge stopped">○ Unknown</span>
        <button class="secondary" id="checkOllamaBtn" onclick="checkOllama()" style="padding:1px 8px;font-size:11px">Check</button>
        <span style="margin-left:2px;font-size:10px">(configure via <code>ydb.ragOllamaUrl</code>)</span>
    </div>
    <div class="buttons" style="margin-top:0">
        <button class="secondary" id="detectRagBtn" onclick="detectRag()">Detect &amp; Download RAG</button>
        <button class="secondary" id="downloadRagBtn" onclick="forceDownloadRag()">Download RAG</button>
    </div>
    <div class="rag-status" id="ragStatus"></div>

    <hr class="separator">

    <div class="buttons">
        <button class="primary" id="saveBtn" onclick="save()">${saveLabel}</button>
        <button class="secondary" id="testBtn" onclick="testConnection()">Test Connection</button>
        <button class="secondary" onclick="cancel()">Cancel</button>
    </div>
</div>

<script>
    const vscode = acquireVsCodeApi();

    const authType = document.getElementById('authType');
    authType.addEventListener('change', updateAuthFields);
    updateAuthFields();

    function updateAuthFields() {
        document.querySelectorAll('.auth-fields').forEach(el => el.classList.remove('visible'));
        const selected = authType.value;
        const target = document.getElementById('auth-' + selected);
        if (target) {
            target.classList.add('visible');
        }
    }

    function getProfile() {
        const host = document.getElementById('host').value.trim();
        const port = parseInt(document.getElementById('port').value.trim(), 10) || 2135;
        const profile = {
            name: document.getElementById('name').value.trim(),
            host: host,
            port: port,
            endpoint: host + ':' + port,
            database: document.getElementById('database').value.trim(),
            authType: authType.value,
            secure: document.getElementById('secure').checked,
            useRag: document.getElementById('useRag').checked,
        };

        const monitoringUrl = document.getElementById('monitoringUrl').value.trim();
        if (monitoringUrl) {
            profile.monitoringUrl = monitoringUrl;
        }

        const tlsCaCertFile = document.getElementById('tlsCaCertFile').value.trim();
        if (tlsCaCertFile) {
            profile.tlsCaCertFile = tlsCaCertFile;
        }

        switch (profile.authType) {
            case 'static':
                profile.username = document.getElementById('username').value;
                profile.password = document.getElementById('password').value;
                break;
            case 'token':
                profile.token = document.getElementById('token').value;
                break;
            case 'serviceAccount':
                profile.serviceAccountKeyFile = document.getElementById('serviceAccountKeyFile').value;
                break;
        }

        return profile;
    }

    function validate() {
        let valid = true;
        ['name', 'host', 'database'].forEach(id => {
            const input = document.getElementById(id);
            const error = document.getElementById(id + '-error');
            if (!input.value.trim()) {
                error.style.display = 'block';
                valid = false;
            } else {
                error.style.display = 'none';
            }
        });
        return valid;
    }

    function save() {
        if (!validate()) return;
        vscode.postMessage({ type: 'save', profile: getProfile() });
    }

    function testConnection() {
        if (!validate()) return;
        const testBtn = document.getElementById('testBtn');
        const resultEl = document.getElementById('testResult');
        testBtn.disabled = true;
        testBtn.textContent = 'Testing...';
        resultEl.style.display = 'none';
        resultEl.className = 'test-result';
        vscode.postMessage({ type: 'testConnection', profile: getProfile() });
    }

    function selectFile() {
        vscode.postMessage({ type: 'selectFile' });
    }

    function selectCaFile() {
        vscode.postMessage({ type: 'selectCaFile' });
    }

    function clearCaFile() {
        document.getElementById('tlsCaCertFile').value = '';
    }

    function cancel() {
        vscode.postMessage({ type: 'cancel' });
    }

    function setRagStatus(text, cls) {
        const el = document.getElementById('ragStatus');
        el.textContent = text;
        el.className = 'rag-status visible' + (cls ? ' ' + cls : '');
    }

    function setRagButtonsDisabled(disabled) {
        document.getElementById('detectRagBtn').disabled = disabled;
        document.getElementById('downloadRagBtn').disabled = disabled;
    }

    function updateRagRunningBadge(running) {
        const badge = document.getElementById('ragRunningBadge');
        if (running) {
            badge.textContent = '● Running';
            badge.className = 'rag-badge running';
        } else {
            badge.textContent = '○ Not running';
            badge.className = 'rag-badge stopped';
        }
    }

    function updateOllamaBadge(state, url) {
        const badge = document.getElementById('ollamaBadge');
        const display = document.getElementById('ollamaUrlDisplay');
        display.textContent = url || '—';
        if (!url) {
            badge.textContent = '○ Not configured';
            badge.className = 'rag-badge stopped';
        } else if (state === 'available') {
            badge.textContent = '● Available';
            badge.className = 'rag-badge running';
        } else if (state === 'unavailable') {
            badge.textContent = '✗ Unavailable';
            badge.className = 'rag-badge unavailable';
        } else {
            badge.textContent = '○ Unknown';
            badge.className = 'rag-badge stopped';
        }
    }

    function checkOllama() {
        const badge = document.getElementById('ollamaBadge');
        badge.textContent = '… Checking';
        badge.className = 'rag-badge stopped';
        document.getElementById('checkOllamaBtn').disabled = true;
        vscode.postMessage({ type: 'checkOllama' });
    }

    document.getElementById('useRag').addEventListener('change', function() {
        if (this.checked) {
            const host = document.getElementById('host').value.trim();
            const database = document.getElementById('database').value.trim();
            if (!host || !database) {
                setRagStatus('Fill in host and database to enable RAG', 'error');
                this.checked = false;
                return;
            }
            setRagButtonsDisabled(true);
            setRagStatus('Starting RAG...', '');
        } else {
            setRagStatus('Stopping RAG...', '');
        }
        vscode.postMessage({ type: 'toggleRag', enabled: this.checked, profile: getProfile() });
    });

    function detectRag() {
        if (!validate()) return;
        setRagButtonsDisabled(true);
        setRagStatus('Starting...', '');
        vscode.postMessage({ type: 'detectRag', profile: getProfile() });
    }

    function forceDownloadRag() {
        if (!validate()) return;
        setRagButtonsDisabled(true);
        setRagStatus('Starting download...', '');
        vscode.postMessage({ type: 'downloadRag', profile: getProfile() });
    }

    function fillForm(profile) {
        document.getElementById('name').value = profile.name || '';
        // Support both new host/port fields and legacy endpoint
        if (profile.host) {
            document.getElementById('host').value = profile.host;
            document.getElementById('port').value = profile.port || 2135;
        } else {
            const ep = profile.endpoint || 'localhost:2135';
            const lastColon = ep.lastIndexOf(':');
            if (lastColon > 0) {
                document.getElementById('host').value = ep.substring(0, lastColon);
                document.getElementById('port').value = ep.substring(lastColon + 1) || '2135';
            } else {
                document.getElementById('host').value = ep;
                document.getElementById('port').value = '2135';
            }
        }
        document.getElementById('database').value = profile.database || '';
        document.getElementById('authType').value = profile.authType || 'anonymous';
        document.getElementById('secure').checked = !!profile.secure;
        document.getElementById('monitoringUrl').value = profile.monitoringUrl || '';
        document.getElementById('username').value = profile.username || '';
        document.getElementById('password').value = profile.password || '';
        document.getElementById('token').value = profile.token || '';
        document.getElementById('serviceAccountKeyFile').value = profile.serviceAccountKeyFile || '';
        document.getElementById('tlsCaCertFile').value = profile.tlsCaCertFile || '';
        document.getElementById('useRag').checked = profile.useRag !== false;
        updateAuthFields();
    }

    window.addEventListener('message', event => {
        const message = event.data;
        switch (message.type) {
            case 'testResult': {
                const resultEl = document.getElementById('testResult');
                const testBtn = document.getElementById('testBtn');
                testBtn.disabled = false;
                testBtn.textContent = 'Test Connection';
                resultEl.style.display = '';
                if (message.success) {
                    resultEl.className = 'test-result success';
                    resultEl.textContent = 'Connection successful!';
                } else {
                    resultEl.className = 'test-result error';
                    resultEl.textContent = 'Connection failed: ' + (message.error || 'Unknown error');
                }
                break;
            }
            case 'fileSelected': {
                document.getElementById('serviceAccountKeyFile').value = message.path;
                break;
            }
            case 'caFileSelected': {
                document.getElementById('tlsCaCertFile').value = message.path;
                break;
            }
            case 'fillForm': {
                fillForm(message.profile);
                break;
            }
            case 'ragStatus': {
                setRagButtonsDisabled(false);
                if (message.progress) {
                    setRagStatus(message.progress, '');
                } else if (message.success) {
                    setRagStatus('RAG downloaded successfully.', 'success');
                } else if (message.error) {
                    setRagStatus('Error: ' + message.error, 'error');
                }
                break;
            }
            case 'ragRunning': {
                setRagButtonsDisabled(false);
                updateRagRunningBadge(message.running);
                if (message.autoEnabled) {
                    document.getElementById('useRag').checked = true;
                }
                break;
            }
            case 'ollamaStatus': {
                document.getElementById('checkOllamaBtn').disabled = false;
                updateOllamaBadge(message.available ? 'available' : 'unavailable', message.url);
                break;
            }

        }
    });
</script>
</body>
</html>`;
}
