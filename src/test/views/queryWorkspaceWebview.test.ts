import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { extractTablePath, truncateCachedState, PersistedWorkspaceState, getScript } from '../../views/queryWorkspaceWebview';
import { buildConverterHtml } from '../../views/dialectConverterWebview';
import { buildFormHtml } from '../../views/connectionFormWebview';

describe('extractTablePath', () => {
    it('extracts backtick-quoted table path from simple SELECT', () => {
        expect(extractTablePath('SELECT * FROM `my_table`')).toBe('my_table');
    });

    it('extracts unquoted table path from simple SELECT', () => {
        expect(extractTablePath('SELECT * FROM my_table')).toBe('my_table');
    });

    it('extracts path with slashes', () => {
        expect(extractTablePath('SELECT * FROM `/Root/db/my_table`')).toBe('/Root/db/my_table');
    });

    it('handles extra whitespace', () => {
        expect(extractTablePath('  SELECT  *  FROM   `my_table`  LIMIT 100  ')).toBe('my_table');
    });

    it('returns undefined for JOIN queries', () => {
        expect(extractTablePath('SELECT * FROM `t1` JOIN `t2` ON t1.id = t2.id')).toBeUndefined();
    });

    it('returns undefined for subqueries', () => {
        expect(extractTablePath('SELECT * FROM (SELECT 1)')).toBeUndefined();
    });

    it('returns undefined for query without FROM', () => {
        expect(extractTablePath('SELECT 1')).toBeUndefined();
    });

    it('is case-insensitive for FROM keyword', () => {
        expect(extractTablePath('select * from `my_table`')).toBe('my_table');
    });

    it('extracts path after FROM with trailing clauses', () => {
        expect(extractTablePath('SELECT * FROM `my_table` WHERE id = 1 LIMIT 10')).toBe('my_table');
    });

    it('handles multiline query', () => {
        expect(extractTablePath('SELECT *\nFROM `my_table`\nLIMIT 100')).toBe('my_table');
    });
});

describe('webview HTML: explainQuery hides non-plan tabs', () => {
    const src = readFileSync(resolve(__dirname, '../../views/queryWorkspaceWebview.ts'), 'utf8');

    function extractFunctionBody(name: string): string {
        const match = src.match(new RegExp(`function ${name}\\(\\)\\s*\\{([\\s\\S]*?)\\n\\}`));
        expect(match).not.toBeNull();
        return match![1];
    }

    it('explainQuery hides tabResults', () => {
        expect(extractFunctionBody('explainQuery')).toMatch(/tabResults.*style.*display.*=.*['"]none['"]/);
    });

    it('explainQuery hides tabChart', () => {
        expect(extractFunctionBody('explainQuery')).toMatch(/tabChart.*style.*display.*=.*['"]none['"]/);
    });

    it('explainQuery hides tabStatistics', () => {
        expect(extractFunctionBody('explainQuery')).toMatch(/tabStatistics.*style.*display.*=.*['"]none['"]/);
    });

    it('executeQuery restores tabResults and tabChart', () => {
        const body = extractFunctionBody('executeQuery');
        expect(body).toMatch(/tabResults.*style.*display.*=.*['"]{2}/);
        expect(body).toMatch(/tabChart.*style.*display.*=.*['"]{2}/);
    });

    it('executeWithStats restores tabResults and tabChart', () => {
        const body = extractFunctionBody('executeWithStats');
        expect(body).toMatch(/tabResults.*style.*display.*=.*['"]{2}/);
        expect(body).toMatch(/tabChart.*style.*display.*=.*['"]{2}/);
    });

    it('executeWithStats does not hide tabStatistics', () => {
        expect(extractFunctionBody('executeWithStats')).not.toMatch(/tabStatistics.*style.*display.*=.*['"]none['"]/);
    });
});

describe('webview HTML: statsResult renders results and plan toggle', () => {
    const src = readFileSync(resolve(__dirname, '../../views/queryWorkspaceWebview.ts'), 'utf8');

    it('backend statsResult message includes rows', () => {
        expect(src).toMatch(/type:\s*'statsResult'[\s\S]{0,200}rows:\s*result\.rows/);
    });

    it('onStatsResult calls onQueryResult with rows', () => {
        const match = src.match(/function onStatsResult\(msg\)\s*\{([\s\S]*?)\n\}/);
        expect(match).not.toBeNull();
        expect(match![1]).toMatch(/onQueryResult/);
    });

    it('plan toggle buttons use data-plan-view instead of inline onclick', () => {
        const match = src.match(/function onStatsResult\(msg\)\s*\{([\s\S]*?)\n\}/);
        expect(match).not.toBeNull();
        const body = match![1];
        expect(body).toMatch(/data-plan-view/);
        expect(body).not.toMatch(/onclick=/);
    });

    it('plan toggle buttons get addEventListener after innerHTML', () => {
        const match = src.match(/function onStatsResult\(msg\)\s*\{([\s\S]*?)\n\}/);
        expect(match).not.toBeNull();
        expect(match![1]).toMatch(/addEventListener.*click[\s\S]*showStatsPlanView/);
    });
});

describe('webview HTML: plan sub-tabs and views', () => {
    const src = readFileSync(resolve(__dirname, '../../views/queryWorkspaceWebview.ts'), 'utf8');

    it('has plan sub-tab buttons for graph, table, and json', () => {
        expect(src).toMatch(/data-plan-tab="graph"/);
        expect(src).toMatch(/data-plan-tab="table"/);
        expect(src).toMatch(/data-plan-tab="json"/);
    });

    it('has zoom control buttons', () => {
        expect(src).toMatch(/id="planZoomIn"/);
        expect(src).toMatch(/id="planZoomOut"/);
        expect(src).toMatch(/id="planFitView"/);
    });

    it('has plan table with correct columns', () => {
        expect(src).toMatch(/id="planTable"/);
        expect(src).toMatch(/>Operation</);
        expect(src).toMatch(/>A-Cpu</);
        expect(src).toMatch(/>A-Rows</);
        expect(src).toMatch(/>E-Cost</);
        expect(src).toMatch(/>E-Rows</);
        expect(src).toMatch(/>E-Size</);
    });

    it('has JSON view toolbar buttons', () => {
        expect(src).toMatch(/id="planJsonExpandAll"/);
        expect(src).toMatch(/id="planJsonCollapseAll"/);
        expect(src).toMatch(/id="planJsonCopy"/);
    });

    it('has JSON view container', () => {
        expect(src).toMatch(/id="planJsonContainer"/);
    });
});

describe('webview: handleExplainQuery sends rawJson', () => {
    const src = readFileSync(resolve(__dirname, '../../views/queryWorkspaceWebview.ts'), 'utf8');

    it('includes rawJson in explain result message', () => {
        expect(src).toMatch(/type:\s*'explainResult'[\s\S]{0,100}rawJson:\s*result\.rawJson/);
    });
});

describe('webview JS: plan view rendering functions', () => {
    const src = readFileSync(resolve(__dirname, '../../views/queryWorkspaceWebview.ts'), 'utf8');

    it('onExplainResult stores rawJson and calls renderPlanTable', () => {
        const match = src.match(/function onExplainResult\(msg\)\s*\{([\s\S]*?)\n\}/);
        expect(match).not.toBeNull();
        expect(match![1]).toMatch(/planRawJson\s*=\s*msg\.rawJson/);
        expect(match![1]).toMatch(/renderPlanTable/);
        expect(match![1]).toMatch(/renderPlanJson/);
    });

    it('onExplainResult resets zoom level', () => {
        const match = src.match(/function onExplainResult\(msg\)\s*\{([\s\S]*?)\n\}/);
        expect(match).not.toBeNull();
        expect(match![1]).toMatch(/planZoomLevel\s*=\s*1/);
    });

    it('has renderPlanTable function', () => {
        expect(src).toMatch(/function renderPlanTable\(planRoot\)/);
    });

    it('has renderPlanJson function', () => {
        expect(src).toMatch(/function renderPlanJson\(rawJson\)/);
    });

    it('has zoom update function', () => {
        expect(src).toMatch(/function updatePlanZoom\(\)/);
    });

    it('has formatMetricNumber helper for table view', () => {
        expect(src).toMatch(/function formatMetricNumber\(val\)/);
    });

    it('has formatCpuTime helper for A-Cpu column', () => {
        expect(src).toMatch(/function formatCpuTime\(val\)/);
    });

    it('collectOperatorMetrics checks operatorDetails for A-Cpu and A-Rows', () => {
        expect(src).toMatch(/op\.properties\['A-Cpu'\]/);
        expect(src).toMatch(/op\.properties\['A-Rows'\]/);
    });
});

// ==================== Persistence tests ====================

describe('truncateCachedState', () => {
    it('returns full state when under size limit', () => {
        const cached = {
            queryResult: { type: 'queryResult', columns: [], rows: [{ a: 1 }] },
            explainResult: { type: 'explainResult', plan: {} },
        };
        const result = truncateCachedState(cached, 1024 * 1024);
        expect(result.queryResult).toEqual(cached.queryResult);
        expect(result.explainResult).toEqual(cached.explainResult);
    });

    it('drops largest entries when over size limit', () => {
        const largeData = 'x'.repeat(1000);
        const cached = {
            queryResult: { type: 'queryResult', data: largeData },
            allRows: { type: 'allRows', data: largeData + largeData },
            explainResult: { type: 'explainResult', plan: { a: 1 } },
        };
        // Set very small limit so something gets dropped
        const result = truncateCachedState(cached, 200);
        // allRows is largest and should be dropped first
        expect(result.allRows).toBeUndefined();
    });

    it('handles empty cached state', () => {
        const result = truncateCachedState({});
        expect(result).toEqual({});
    });

    it('handles undefined fields gracefully', () => {
        const cached = {
            queryResult: undefined,
            statsResult: undefined,
            explainResult: { type: 'explainResult' },
            allRows: undefined,
        };
        const result = truncateCachedState(cached);
        expect(result.explainResult).toEqual({ type: 'explainResult' });
    });
});

describe('PersistedWorkspaceState round-trip serialization', () => {
    it('serializes and deserializes correctly', () => {
        const state: PersistedWorkspaceState = {
            pairKey: 'workspace-3',
            title: 'Query 3',
            queryText: 'SELECT * FROM `my_table`',
            connectionProfileId: 'profile-abc',
            cachedColumns: [{ name: 'id', type: 'Int32' }, { name: 'name', type: 'Utf8' }],
            cached: {
                queryResult: { type: 'queryResult', columns: [], rows: [{ id: 1, name: 'test' }] },
            },
            viewColumn: 1,
        };

        const json = JSON.stringify(state);
        const restored: PersistedWorkspaceState = JSON.parse(json);

        expect(restored.pairKey).toBe('workspace-3');
        expect(restored.title).toBe('Query 3');
        expect(restored.queryText).toBe('SELECT * FROM `my_table`');
        expect(restored.connectionProfileId).toBe('profile-abc');
        expect(restored.cachedColumns).toHaveLength(2);
        expect(restored.cached.queryResult).toBeDefined();
        expect(restored.viewColumn).toBe(1);
    });

    it('handles state without optional fields', () => {
        const state: PersistedWorkspaceState = {
            pairKey: 'workspace-1',
            title: 'Query 1',
            queryText: '',
            cachedColumns: [],
            cached: {},
        };

        const json = JSON.stringify(state);
        const restored: PersistedWorkspaceState = JSON.parse(json);

        expect(restored.connectionProfileId).toBeUndefined();
        expect(restored.viewColumn).toBeUndefined();
        expect(restored.cached).toEqual({});
    });
});

describe('webview JS: persistence messages', () => {
    const src = readFileSync(resolve(__dirname, '../../views/queryWorkspaceWebview.ts'), 'utf8');

    it('sends webviewReady message after Monaco init', () => {
        expect(src).toMatch(/postMessage\(\s*\{\s*type:\s*'webviewReady'\s*\}/);
    });

    it('sends contentChanged message on editor content change', () => {
        expect(src).toMatch(/postMessage\(\s*\{\s*type:\s*'contentChanged'/);
    });

    it('debounces contentChanged with setTimeout', () => {
        expect(src).toMatch(/contentChangeTimer\s*=\s*setTimeout/);
    });

    it('sets pairKey in vscode state for serializer', () => {
        expect(src).toMatch(/vscode\.setState\(\s*\{\s*pairKey:\s*_pairKey\s*\}/);
    });

    it('handles contentChanged message in setupMessageHandlers', () => {
        expect(src).toMatch(/case\s*'contentChanged'/);
    });

    it('handles webviewReady message in setupMessageHandlers', () => {
        expect(src).toMatch(/case\s*'webviewReady'/);
    });

    it('calls scheduleSaveWorkspaceStates after query handlers', () => {
        // Check that scheduleSaveWorkspaceStates is called in the executeQuery case block
        const handlerMatch = src.match(/case\s*'executeQuery'[\s\S]*?scheduleSaveWorkspaceStates[\s\S]*?break;\s*\}/);
        expect(handlerMatch).not.toBeNull();
    });

    it('registers WebviewPanelSerializer for ydbQueryWorkspace', () => {
        expect(src).toMatch(/registerWebviewPanelSerializer\s*\(\s*'ydbQueryWorkspace'/);
    });
});

describe('workspace state persistence keys', () => {
    const src = readFileSync(resolve(__dirname, '../../views/queryWorkspaceWebview.ts'), 'utf8');

    it('defines WORKSPACE_STATES_KEY', () => {
        expect(src).toMatch(/WORKSPACE_STATES_KEY\s*=\s*'ydb\.workspaceStates'/);
    });

    it('defines WORKSPACE_COUNTER_KEY', () => {
        expect(src).toMatch(/WORKSPACE_COUNTER_KEY\s*=\s*'ydb\.workspaceCounter'/);
    });

    it('exports saveAllWorkspaceStates', () => {
        expect(src).toMatch(/export function saveAllWorkspaceStates/);
    });

    it('deactivate calls saveAllWorkspaceStates', () => {
        const extSrc = readFileSync(resolve(__dirname, '../../extension.ts'), 'utf8');
        expect(extSrc).toMatch(/saveAllWorkspaceStates\(\)/);
    });
});

describe('webview JS: formatDatePrimitive', () => {
    const src = readFileSync(resolve(__dirname, '../../views/queryWorkspaceWebview.ts'), 'utf8');

    // Extract DATE_PRIMITIVES + formatDatePrimitive from source and eval them
    function getFormatDatePrimitive(): (value: unknown, typeName: string) => string | null {
        const mapMatch = src.match(/var DATE_PRIMITIVES\s*=\s*\{[\s\S]*?\};/);
        const fnMatch = src.match(/function formatDatePrimitive\(value,\s*typeName\)\s*\{[\s\S]*?\n\}/);
        expect(mapMatch).not.toBeNull();
        expect(fnMatch).not.toBeNull();
        // eslint-disable-next-line no-new-func
        const fn = new Function(`${mapMatch![0]}\n${fnMatch![0]}\nreturn formatDatePrimitive;`)();
        return fn;
    }

    it('converts DATE days to ISO date string', () => {
        const fmt = getFormatDatePrimitive();
        // 20522 days since epoch = 2026-03-10
        expect(fmt(20522, 'DATE')).toBe('2026-03-10');
    });

    it('converts DATE32 same as DATE', () => {
        const fmt = getFormatDatePrimitive();
        expect(fmt(20522, 'DATE32')).toBe('2026-03-10');
    });

    it('converts DATETIME seconds to ISO datetime string', () => {
        const fmt = getFormatDatePrimitive();
        // 20522 * 86400 = 1773100800 seconds since epoch
        const result = fmt(20522 * 86400, 'DATETIME');
        expect(result).toBe('2026-03-10 00:00:00.000');
    });

    it('converts TIMESTAMP microseconds to ISO datetime string', () => {
        const fmt = getFormatDatePrimitive();
        // 20522 * 86400 seconds * 1000000 microseconds
        const result = fmt(20522 * 86400 * 1000000, 'TIMESTAMP');
        expect(result).toBe('2026-03-10 00:00:00.000');
    });

    it('returns null for non-date primitive names', () => {
        const fmt = getFormatDatePrimitive();
        expect(fmt(42, 'INT32')).toBeNull();
        expect(fmt(42, 'UTF8')).toBeNull();
    });

    it('returns null for non-numeric value', () => {
        const fmt = getFormatDatePrimitive();
        expect(fmt('2026-03-15', 'DATE')).toBeNull();
    });

    it('epoch 0 gives 1970-01-01 for DATE', () => {
        const fmt = getFormatDatePrimitive();
        expect(fmt(0, 'DATE')).toBe('1970-01-01');
    });
});

describe('webview JS: formatByType date handling', () => {
    const src = readFileSync(resolve(__dirname, '../../views/queryWorkspaceWebview.ts'), 'utf8');

    function getFormatByType(): (value: unknown, node: unknown) => unknown {
        const mapMatch = src.match(/var DATE_PRIMITIVES\s*=\s*\{[\s\S]*?\};/);
        const fmtPrimMatch = src.match(/function formatDatePrimitive\(value,\s*typeName\)\s*\{[\s\S]*?\n\}/);
        const fmtByTypeMatch = src.match(/function formatByType\(value,\s*node\)\s*\{[\s\S]*?\n\}/);
        expect(mapMatch).not.toBeNull();
        expect(fmtPrimMatch).not.toBeNull();
        expect(fmtByTypeMatch).not.toBeNull();
        // eslint-disable-next-line no-new-func
        return new Function(
            `${mapMatch![0]}\n${fmtPrimMatch![0]}\n${fmtByTypeMatch![0]}\nreturn formatByType;`
        )();
    }

    it('formats DATE primitive', () => {
        const fmt = getFormatByType();
        expect(fmt(20522, { kind: 'primitive', name: 'DATE' })).toBe('2026-03-10');
    });

    it('formats Optional<DATE>', () => {
        const fmt = getFormatByType();
        expect(fmt(20522, { kind: 'optional', item: { kind: 'primitive', name: 'DATE' } })).toBe('2026-03-10');
    });

    it('passes non-date primitives through unchanged', () => {
        const fmt = getFormatByType();
        expect(fmt(42, { kind: 'primitive', name: 'INT32' })).toBe(42);
    });

    it('formats List<DATE>', () => {
        const fmt = getFormatByType();
        expect(fmt([20522, 0], { kind: 'list', item: { kind: 'primitive', name: 'DATE' } }))
            .toEqual(['2026-03-10', '1970-01-01']);
    });

    it('handles null value', () => {
        const fmt = getFormatByType();
        expect(fmt(null, { kind: 'primitive', name: 'DATE' })).toBeNull();
    });
});

describe('webview JS: performCopy', () => {
    const src = readFileSync(resolve(__dirname, '../../views/queryWorkspaceWebview.ts'), 'utf8');

    function extractPerformCopy(): (sel: unknown, model: unknown, navigator: unknown) => void {
        // Extract performCopy function body and wrap it for testing
        const fnMatch = src.match(/function performCopy\(\)\s*\{([\s\S]*?)\n {4}\}/);
        expect(fnMatch).not.toBeNull();
        const body = fnMatch![1]
            .replace(/window\.monacoEditor\.getSelection\(\)/g, '_sel')
            .replace(/window\.monacoEditor\.getModel\(\)/g, '_model');
        // eslint-disable-next-line no-new-func
        return new Function('_sel', '_model', 'navigator', body) as (sel: unknown, model: unknown, navigator: unknown) => void;
    }

    it('copies selected text to clipboard when selection is non-empty', async () => {
        const written: string[] = [];
        const navigator = { clipboard: { writeText: (t: string) => { written.push(t); return Promise.resolve(); } } };
        const sel = { isEmpty: () => false, startLineNumber: 1 };
        const model = { getLineContent: (_n: number) => 'full line', getValueInRange: (_s: unknown) => 'selected text' };
        const fn = extractPerformCopy();
        fn(sel, model, navigator);
        expect(written).toEqual(['selected text']);
    });

    it('copies current line when selection is empty (cursor on line)', async () => {
        const written: string[] = [];
        const navigator = { clipboard: { writeText: (t: string) => { written.push(t); return Promise.resolve(); } } };
        const sel = { isEmpty: () => true, startLineNumber: 3 };
        const model = { getLineContent: (n: number) => `line ${n}`, getValueInRange: (_s: unknown) => '' };
        const fn = extractPerformCopy();
        fn(sel, model, navigator);
        expect(written).toEqual(['line 3']);
    });

    it('does not modify the model on copy', () => {
        const written: string[] = [];
        const navigator = { clipboard: { writeText: (t: string) => { written.push(t); return Promise.resolve(); } } };
        const sel = { isEmpty: () => false, startLineNumber: 1 };
        let editsApplied = false;
        const model = {
            getLineContent: (_n: number) => 'full line',
            getValueInRange: (_s: unknown) => 'hello',
            executeEdits: () => { editsApplied = true; },
        };
        const fn = extractPerformCopy();
        fn(sel, model, navigator);
        expect(editsApplied).toBe(false);
        expect(written).toEqual(['hello']);
    });

    it('registers Ctrl+C command for performCopy', () => {
        expect(src).toMatch(/addCommand.*KeyC.*performCopy/);
    });

    it('registers clipboardCopyAction for performCopy', () => {
        expect(src).toMatch(/id:\s*'editor\.action\.clipboardCopyAction'/);
        expect(src).toMatch(/label:\s*'Copy'/);
    });
});

// Helper: extract all <script>...</script> blocks from HTML and check JS syntax
function extractScriptBlocks(html: string): string[] {
    const blocks: string[] = [];
    const re = /<script[^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        const code = m[1].trim();
        if (code) {
            blocks.push(code);
        }
    }
    return blocks;
}

function assertValidJs(code: string, label: string): void {
    try {
        // new Function() parses the code as a function body — catches SyntaxError
        new Function(code);
    } catch (e) {
        const err = e as SyntaxError;
        // Find the offending line for a helpful message
        const lines = code.split('\n');
        let context = '';
        if (err.stack) {
            const stackLineMatch = err.stack.match(/<anonymous>:(\d+):(\d+)/);
            if (stackLineMatch) {
                const lineNum = parseInt(stackLineMatch[1], 10) - 2; // Function wrapper offset
                const start = Math.max(0, lineNum - 2);
                const end = Math.min(lines.length, lineNum + 3);
                context = lines.slice(start, end).map((l, i) => {
                    const num = start + i + 1;
                    const marker = num === lineNum ? ' >>>' : '    ';
                    return `${marker} ${num}: ${l}`;
                }).join('\n');
            }
        }
        throw new Error(
            `${label}: generated JS has syntax error: ${err.message}\n${context}`,
        );
    }
}

describe('webview inline JS syntax validity', () => {
    it('getScript() produces syntactically valid JavaScript', () => {
        const script = getScript(JSON.stringify('SELECT 1'), 'vs-dark', JSON.stringify('workspace-1'));
        assertValidJs(script, 'getScript');
    });

    it('getScript() with empty content produces valid JavaScript', () => {
        const script = getScript(JSON.stringify(''), 'vs', JSON.stringify(''));
        assertValidJs(script, 'getScript (empty)');
    });

    it('getScript() with special characters in content produces valid JavaScript', () => {
        const script = getScript(JSON.stringify("SELECT * FROM `table` WHERE x = '\\n'"), 'vs-dark', JSON.stringify('ws-2'));
        assertValidJs(script, 'getScript (special chars)');
    });

    it('buildConverterHtml() inline scripts are syntactically valid', () => {
        const html = buildConverterHtml();
        const blocks = extractScriptBlocks(html);
        expect(blocks.length).toBeGreaterThan(0);
        blocks.forEach((code, i) => assertValidJs(code, `buildConverterHtml script#${i}`));
    });

    it('buildFormHtml(false) inline scripts are syntactically valid', () => {
        const html = buildFormHtml(false);
        const blocks = extractScriptBlocks(html);
        expect(blocks.length).toBeGreaterThan(0);
        blocks.forEach((code, i) => assertValidJs(code, `buildFormHtml(false) script#${i}`));
    });

    it('buildFormHtml(true) inline scripts are syntactically valid', () => {
        const html = buildFormHtml(true);
        const blocks = extractScriptBlocks(html);
        expect(blocks.length).toBeGreaterThan(0);
        blocks.forEach((code, i) => assertValidJs(code, `buildFormHtml(true) script#${i}`));
    });
});
