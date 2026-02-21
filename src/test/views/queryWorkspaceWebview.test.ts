import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { extractTablePath, truncateCachedState, PersistedWorkspaceState } from '../../views/queryWorkspaceWebview';

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
