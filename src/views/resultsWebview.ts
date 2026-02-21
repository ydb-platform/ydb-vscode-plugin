import * as vscode from 'vscode';
import { QueryResult, ExplainResult, PlanNode } from '../models/types';

let currentPanel: vscode.WebviewPanel | undefined;

export function showQueryResults(result: QueryResult, queryText: string): void {
    const tableName = extractTableName(queryText);
    const title = tableName ? `YDB Results: ${tableName}` : 'YDB Results';
    const panel = getOrCreatePanel(title);
    panel.webview.html = buildResultsHtml(result, queryText);
}

export function showExplainResults(result: ExplainResult, queryText: string): void {
    const panel = getOrCreatePanel('YDB Explain');
    panel.webview.html = buildExplainHtml(result, queryText);
}

function extractTableName(queryText: string): string | undefined {
    const match = queryText.match(/\bFROM\s+`([^`]+)`/i)
        || queryText.match(/\bFROM\s+([\w/.]+)/i);
    return match?.[1];
}

function getOrCreatePanel(title: string): vscode.WebviewPanel {
    if (currentPanel) {
        currentPanel.title = title;
        currentPanel.reveal(vscode.ViewColumn.Active);
        return currentPanel;
    }

    currentPanel = vscode.window.createWebviewPanel(
        'ydbResults',
        title,
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true },
    );

    currentPanel.onDidDispose(() => {
        currentPanel = undefined;
    });

    return currentPanel;
}

function buildResultsHtml(result: QueryResult, queryText: string): string {
    const { columns, rows } = result;

    if (columns.length === 0) {
        return wrapHtml(`
            <div class="info">Query executed successfully. No result set returned.</div>
            <div class="query">${escapeHtml(queryText)}</div>
        `);
    }

    const headerCells = columns.map((c, i) =>
        `<th class="sortable" data-sort="${i}">${escapeHtml(c.name)}<br><span class="type">${escapeHtml(c.type)}</span></th>`
    ).join('');

    const MAX_CELL_WIDTH = 200;
    const fullValues: string[] = [];

    const bodyRows = rows.map(row => {
        const cells = columns.map(c => {
            const val = row[c.name];
            if (val === null || val === undefined) {
                return `<td><span class="null">NULL</span></td>`;
            }
            const formatted = formatValue(val);
            if (formatted.length > MAX_CELL_WIDTH) {
                const idx = fullValues.length;
                fullValues.push(formatted);
                const truncated = formatted.substring(0, MAX_CELL_WIDTH);
                return `<td>${escapeHtml(truncated)}<span class="ellipsis" data-cellidx="${idx}">...</span></td>`;
            }
            return `<td>${escapeHtml(formatted)}</td>`;
        }).join('');
        return `<tr>${cells}</tr>`;
    }).join('');

    // Escape </ sequences to prevent breaking script tags in HTML
    const fullValuesJson = JSON.stringify(fullValues).replace(/</g, '\\u003c');

    return wrapHtml(`
        <div class="stats">${rows.length} row(s)${result.truncated ? ' (truncated)' : ''}</div>
        <div class="table-container">
            <table id="results">
                <thead><tr>${headerCells}</tr></thead>
                <tbody>${bodyRows}</tbody>
            </table>
        </div>
        <div id="cellModal" class="modal-overlay">
            <div class="modal">
                <div class="modal-header">
                    <span class="modal-title">Содержимое ячейки</span>
                    <button id="modalCloseX" class="modal-close">&times;</button>
                </div>
                <pre id="cellModalContent" class="modal-body"></pre>
                <div class="modal-footer">
                    <button id="modalCopyBtn" class="modal-btn">Копировать</button>
                    <button id="modalCloseBtn" class="modal-btn modal-btn-secondary">Закрыть</button>
                </div>
            </div>
        </div>
        <script>
            (function() {
                var fullValues = ${fullValuesJson};
                var sortCol = -1;
                var sortAsc = true;
                var modal = document.getElementById('cellModal');
                var modalContent = document.getElementById('cellModalContent');
                var copyBtn = document.getElementById('modalCopyBtn');

                // Sort table by clicking headers
                document.querySelector('#results thead').addEventListener('click', function(e) {
                    var th = e.target.closest('th[data-sort]');
                    if (!th) return;
                    var col = parseInt(th.dataset.sort, 10);
                    var table = document.getElementById('results');
                    var tbody = table.querySelector('tbody');
                    var rows = Array.from(tbody.querySelectorAll('tr'));
                    if (sortCol === col) { sortAsc = !sortAsc; } else { sortCol = col; sortAsc = true; }
                    rows.sort(function(a, b) {
                        var aText = a.cells[col].textContent || '';
                        var bText = b.cells[col].textContent || '';
                        var aNum = parseFloat(aText);
                        var bNum = parseFloat(bText);
                        if (!isNaN(aNum) && !isNaN(bNum)) {
                            return sortAsc ? aNum - bNum : bNum - aNum;
                        }
                        return sortAsc ? aText.localeCompare(bText) : bText.localeCompare(aText);
                    });
                    rows.forEach(function(r) { tbody.appendChild(r); });
                });

                // Column resize via drag on right edge of th
                (function() {
                    console.log('[YDB] Column resize script loaded');
                    var table = document.getElementById('results');
                    var thead = table.querySelector('thead');
                    var dragging = false;
                    var startX = 0;
                    var startWidth = 0;
                    var dragTh = null;
                    var EDGE = 8; // pixels from right border to trigger resize

                    // Visual resize line
                    var resizeLine = document.createElement('div');
                    resizeLine.className = 'resize-line';
                    document.body.appendChild(resizeLine);

                    function isNearRightEdge(th, clientX) {
                        var rect = th.getBoundingClientRect();
                        return clientX >= rect.right - EDGE && clientX <= rect.right + 2;
                    }

                    function findThNearEdge(e) {
                        var ths = thead.querySelectorAll('th');
                        for (var i = 0; i < ths.length; i++) {
                            if (isNearRightEdge(ths[i], e.clientX)) return ths[i];
                        }
                        return null;
                    }

                    // Change cursor on hover near right edge
                    thead.addEventListener('mousemove', function(e) {
                        if (dragging) return;
                        var th = findThNearEdge(e);
                        thead.style.cursor = th ? 'col-resize' : '';
                    });

                    thead.addEventListener('mouseleave', function() {
                        if (!dragging) thead.style.cursor = '';
                    });

                    // Freeze table layout on first resize
                    function freezeLayout() {
                        if (table.dataset.frozen) return;
                        var ths = table.querySelectorAll('thead th');
                        var widths = [];
                        for (var i = 0; i < ths.length; i++) widths.push(ths[i].offsetWidth);
                        table.style.tableLayout = 'fixed';
                        table.style.width = table.offsetWidth + 'px';
                        for (var i = 0; i < ths.length; i++) ths[i].style.width = widths[i] + 'px';
                        table.dataset.frozen = '1';
                    }

                    thead.addEventListener('mousedown', function(e) {
                        console.log('[YDB] thead mousedown', e.clientX);
                        var th = findThNearEdge(e);
                        if (!th) { console.log('[YDB] no th near edge'); return; }
                        console.log('[YDB] resize start on th:', th.textContent.trim());
                        e.preventDefault();
                        e.stopPropagation();
                        freezeLayout();
                        dragging = true;
                        dragTh = th;
                        startX = e.clientX;
                        startWidth = th.offsetWidth;
                        resizeLine.style.left = e.clientX + 'px';
                        resizeLine.style.display = 'block';
                        document.body.style.cursor = 'col-resize';
                        document.body.style.userSelect = 'none';
                    });

                    document.addEventListener('mousemove', function(e) {
                        if (!dragging) return;
                        resizeLine.style.left = e.clientX + 'px';
                    });

                    document.addEventListener('mouseup', function(e) {
                        if (!dragging) return;
                        var diff = e.clientX - startX;
                        var newWidth = Math.max(30, startWidth + diff);
                        dragTh.style.width = newWidth + 'px';
                        dragging = false;
                        dragTh = null;
                        resizeLine.style.display = 'none';
                        document.body.style.cursor = '';
                        document.body.style.userSelect = '';
                    });
                })();

                // Open modal on ellipsis click
                document.querySelector('#results tbody').addEventListener('click', function(e) {
                    var el = e.target.closest('.ellipsis[data-cellidx]');
                    if (!el) return;
                    var idx = parseInt(el.dataset.cellidx, 10);
                    var text = fullValues[idx];
                    modalContent.textContent = '';
                    modalContent.appendChild(highlightText(text));
                    modal.classList.add('visible');
                });

                // Close modal
                function closeModal() { modal.classList.remove('visible'); }
                document.getElementById('modalCloseX').addEventListener('click', closeModal);
                document.getElementById('modalCloseBtn').addEventListener('click', closeModal);
                modal.addEventListener('click', function(e) { if (e.target === modal) closeModal(); });
                document.addEventListener('keydown', function(e) { if (e.key === 'Escape') closeModal(); });

                // Copy
                copyBtn.addEventListener('click', function() {
                    var text = modalContent.textContent;
                    navigator.clipboard.writeText(text).then(function() {
                        copyBtn.textContent = 'Скопировано!';
                        setTimeout(function() { copyBtn.textContent = 'Копировать'; }, 1500);
                    });
                });

                // Syntax highlighting
                function highlightText(text) {
                    var frag = document.createDocumentFragment();
                    var trimmed = text.trim();
                    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
                        try {
                            var formatted = JSON.stringify(JSON.parse(trimmed), null, 2);
                            highlightJson(formatted, frag);
                            return frag;
                        } catch(e) {}
                    }
                    highlightPlain(text, frag);
                    return frag;
                }
                function highlightJson(text, parent) {
                    var regex = /("(?:[^"\\\\]|\\\\.)*")\\s*(:?)|(\\b(?:true|false|null)\\b)|(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)/g;
                    var last = 0, match;
                    while ((match = regex.exec(text)) !== null) {
                        if (match.index > last) parent.appendChild(document.createTextNode(text.slice(last, match.index)));
                        var span = document.createElement('span');
                        if (match[1]) { span.className = match[2] ? 'hl-key' : 'hl-string'; span.textContent = match[1] + match[2]; }
                        else if (match[3]) { span.className = 'hl-keyword'; span.textContent = match[3]; }
                        else if (match[4]) { span.className = 'hl-number'; span.textContent = match[4]; }
                        parent.appendChild(span);
                        last = regex.lastIndex;
                    }
                    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
                }
                function highlightPlain(text, parent) {
                    var regex = /("(?:[^"\\\\]|\\\\.)*")|('(?:[^'\\\\]|\\\\.)*')|(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)/g;
                    var last = 0, match;
                    while ((match = regex.exec(text)) !== null) {
                        if (match.index > last) parent.appendChild(document.createTextNode(text.slice(last, match.index)));
                        var span = document.createElement('span');
                        span.className = (match[1] || match[2]) ? 'hl-string' : 'hl-number';
                        span.textContent = match[0];
                        parent.appendChild(span);
                        last = regex.lastIndex;
                    }
                    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
                }
            })();
        </script>
    `);
}

function buildExplainHtml(result: ExplainResult, queryText: string): string {
    return wrapHtml(`
        <h2>Execution Plan</h2>
        <div class="query">${escapeHtml(queryText)}</div>
        <div class="plan-tree">${renderPlanNode(result.plan, 0)}</div>
    `);
}

function renderPlanNode(node: PlanNode, depth: number): string {
    const indent = depth * 20;
    const propsHtml = Object.entries(node.properties)
        .map(([k, v]) => `<span class="prop-key">${escapeHtml(k)}</span>: <span class="prop-val">${escapeHtml(v)}</span>`)
        .join('<br>');
    const childrenHtml = node.children.map(c => renderPlanNode(c, depth + 1)).join('');

    return `
        <div class="plan-node" style="margin-left: ${indent}px">
            <div class="node-name">${escapeHtml(node.name)}</div>
            ${propsHtml ? `<div class="node-props">${propsHtml}</div>` : ''}
        </div>
        ${childrenHtml}
    `;
}

function wrapHtml(body: string): string {
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
        padding: 10px;
        margin: 0;
    }
    .stats { margin-bottom: 8px; color: var(--vscode-descriptionForeground); }
    .info { padding: 12px; background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 4px; margin-bottom: 8px; }
    .query { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; color: var(--vscode-descriptionForeground); margin-bottom: 12px; white-space: pre-wrap; padding: 8px; background: var(--vscode-textBlockQuote-background); border-radius: 4px; }
    .table-container { overflow: auto; max-height: calc(100vh - 80px); }
    table { border-collapse: collapse; width: max-content; min-width: 100%; table-layout: auto; }
    th, td { border: 1px solid var(--vscode-panel-border, #333); padding: 4px 8px; text-align: left; white-space: nowrap; }
    td { overflow: hidden; text-overflow: ellipsis; }
    th { background: var(--vscode-editor-selectionBackground); position: sticky; top: 0; z-index: 1; }
    th.sortable { cursor: pointer; }
    .resize-line { position: fixed; top: 0; width: 2px; height: 100vh; background: var(--vscode-focusBorder, #007fd4); z-index: 1000; pointer-events: none; display: none; }
    th .type { font-size: 10px; color: var(--vscode-descriptionForeground); font-weight: normal; }
    tr:nth-child(even) { background: var(--vscode-list-hoverBackground); }
    .null { color: var(--vscode-descriptionForeground); font-style: italic; }
    .ellipsis { color: var(--vscode-textLink-foreground); cursor: pointer; font-weight: bold; margin-left: 2px; }
    .ellipsis:hover { text-decoration: underline; }
    .modal-overlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 100; justify-content: center; align-items: center; }
    .modal-overlay.visible { display: flex; }
    .modal { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border, #444); border-radius: 6px; width: 80%; max-width: 800px; max-height: 80vh; display: flex; flex-direction: column; box-shadow: 0 8px 32px rgba(0,0,0,0.4); }
    .modal-header { display: flex; justify-content: space-between; align-items: center; padding: 10px 16px; border-bottom: 1px solid var(--vscode-panel-border, #333); }
    .modal-title { font-weight: 600; }
    .modal-close { background: none; border: none; color: var(--vscode-foreground); font-size: 20px; cursor: pointer; padding: 0 4px; line-height: 1; }
    .modal-close:hover { color: var(--vscode-errorForeground); }
    .modal-body { flex: 1; overflow: auto; padding: 16px; margin: 0; font-family: var(--vscode-editor-font-family, monospace); font-size: 13px; white-space: pre-wrap; word-break: break-all; line-height: 1.5; user-select: text; }
    .modal-footer { display: flex; gap: 8px; justify-content: flex-end; padding: 10px 16px; border-top: 1px solid var(--vscode-panel-border, #333); }
    .modal-btn { padding: 4px 14px; border: none; border-radius: 3px; cursor: pointer; font-size: 13px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .modal-btn:hover { background: var(--vscode-button-hoverBackground); }
    .modal-btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .modal-btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .hl-key { color: var(--vscode-symbolIcon-propertyForeground, #9cdcfe); }
    .hl-string { color: var(--vscode-debugTokenExpression-string, #ce9178); }
    .hl-number { color: var(--vscode-debugTokenExpression-number, #b5cea8); }
    .hl-keyword { color: var(--vscode-debugTokenExpression-boolean, #569cd6); }
    .plan-node { padding: 4px 0; }
    .node-name { font-weight: bold; color: var(--vscode-symbolIcon-classForeground); }
    .node-props { font-size: 12px; color: var(--vscode-descriptionForeground); margin-left: 16px; }
    .prop-key { color: var(--vscode-symbolIcon-propertyForeground); }
    h2 { margin: 0 0 8px; }
</style>
</head>
<body>${body}</body>
</html>`;
}

function formatValue(val: unknown): string {
    if (val === null || val === undefined) {return 'NULL';}
    if (typeof val === 'object') {return JSON.stringify(val);}
    return String(val);
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
