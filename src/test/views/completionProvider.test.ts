import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { YqlCompletionProvider } from '../../completionProvider';
import { CompletionItemKind } from 'vscode';
import * as viewerService from '../../services/viewerService';

vi.mock('../../services/viewerService', () => ({
    fetchEntities: vi.fn(),
    fetchColumns: vi.fn(),
}));

function makeDoc(text: string) {
    return {
        getText: () => text,
        uri: { fsPath: 'test.yql' },
        languageId: 'yql',
    } as never;
}

function makePos(line: number, character: number) {
    return { line, character } as never;
}

describe('YqlCompletionProvider', () => {
    const mockNavigatorProvider = {
        getTableNames: () => ['path/to/users', 'path/to/orders'],
        ensureTableNamesLoaded: async () => ['path/to/users', 'path/to/orders'],
    } as never;

    const provider = new YqlCompletionProvider(mockNavigatorProvider);

    it('provides YQL keywords for empty query', async () => {
        const items = await provider.provideCompletionItems(makeDoc(''), makePos(0, 0));
        const keywords = items.filter(i => i.kind === CompletionItemKind.Keyword);
        expect(keywords.length).toBeGreaterThan(0);
    });

    it('suggests keywords after SELECT', async () => {
        const items = await provider.provideCompletionItems(makeDoc('SELECT '), makePos(0, 7));
        const keywords = items.filter(i => i.kind === CompletionItemKind.Keyword);
        // After SELECT, should suggest things like FROM, DISTINCT, etc.
        expect(keywords.length).toBeGreaterThan(0);
        // Functions should also be suggested after SELECT
        const functions = items.filter(i => i.kind === CompletionItemKind.Function);
        expect(functions.length).toBeGreaterThan(0);
    });

    it('suggests entities after FROM', async () => {
        const items = await provider.provideCompletionItems(
            makeDoc('SELECT * FROM '),
            makePos(0, 14),
        );
        // Should suggest tables from navigator
        const tableItems = items.filter(i => i.kind === CompletionItemKind.Value);
        expect(tableItems.length).toBeGreaterThanOrEqual(2);
        const labels = tableItems.map(i => i.label as string);
        expect(labels).toContain('path/to/users');
        expect(labels).toContain('path/to/orders');
    });

    it('suggests types after CAST AS', async () => {
        const items = await provider.provideCompletionItems(
            makeDoc('SELECT CAST(x AS '),
            makePos(0, 17),
        );
        const types = items.filter(i => i.kind === CompletionItemKind.TypeParameter);
        expect(types.length).toBeGreaterThan(0);
        const labels = types.map(t => t.label as string);
        expect(labels).toContain('Int32');
        expect(labels).toContain('String');
    });

    it('suggests functions in SELECT context', async () => {
        const items = await provider.provideCompletionItems(
            makeDoc('SELECT '),
            makePos(0, 7),
        );
        const functions = items.filter(i => i.kind === CompletionItemKind.Function);
        expect(functions.length).toBeGreaterThan(0);
        const labels = functions.map(f => f.label as string);
        expect(labels).toContain('CAST');
        expect(labels).toContain('COALESCE');
    });

    it('suggests UDFs when functions are suggested', async () => {
        const items = await provider.provideCompletionItems(
            makeDoc('SELECT '),
            makePos(0, 7),
        );
        const udfs = items.filter(i =>
            i.kind === CompletionItemKind.Function &&
            i.detail === 'UDF',
        );
        expect(udfs.length).toBeGreaterThan(0);
        const labels = udfs.map(u => u.label as string);
        expect(labels.some(l => l.includes('::'))).toBe(true);
    });

    it('suggests pragmas after PRAGMA', async () => {
        const items = await provider.provideCompletionItems(
            makeDoc('PRAGMA '),
            makePos(0, 7),
        );
        const pragmas = items.filter(i => i.kind === CompletionItemKind.Property && i.detail === 'Pragma');
        expect(pragmas.length).toBeGreaterThan(0);
        const labels = pragmas.map(p => p.label as string);
        expect(labels).toContain('TablePathPrefix');
    });

    it('sets insertText with backticks for tables', async () => {
        const items = await provider.provideCompletionItems(
            makeDoc('SELECT * FROM '),
            makePos(0, 14),
        );
        const tableItems = items.filter(i => i.kind === CompletionItemKind.Value);
        const usersItem = tableItems.find(i => i.label === 'path/to/users');
        expect(usersItem?.insertText).toBe('`path/to/users`');
    });

    it('handles empty table names', async () => {
        const emptyProvider = new YqlCompletionProvider({
            getTableNames: () => [],
            ensureTableNamesLoaded: async () => [],
        } as never);
        const items = await emptyProvider.provideCompletionItems(
            makeDoc('SELECT * FROM '),
            makePos(0, 14),
        );
        const tableItems = items.filter(i => i.kind === CompletionItemKind.Value);
        expect(tableItems).toHaveLength(0);
    });

    it('returns empty array for invalid query parse', async () => {
        // Even with unparseable queries, the parser should still return some suggestions
        const items = await provider.provideCompletionItems(
            makeDoc(';;;'),
            makePos(0, 3),
        );
        expect(Array.isArray(items)).toBe(true);
    });

    it('suggests aggregate functions in proper context', async () => {
        const items = await provider.provideCompletionItems(
            makeDoc('SELECT '),
            makePos(0, 7),
        );
        const aggFunctions = items.filter(i =>
            i.kind === CompletionItemKind.Function &&
            i.detail === 'Aggregate function',
        );
        expect(aggFunctions.length).toBeGreaterThan(0);
        const labels = aggFunctions.map(f => f.label as string);
        expect(labels).toContain('COUNT');
        expect(labels).toContain('SUM');
        expect(labels).toContain('AVG');
    });

    it('suggests window functions in proper context', async () => {
        const items = await provider.provideCompletionItems(
            makeDoc('SELECT '),
            makePos(0, 7),
        );
        const windowFunctions = items.filter(i =>
            i.kind === CompletionItemKind.Function &&
            i.detail === 'Window function',
        );
        expect(windowFunctions.length).toBeGreaterThan(0);
        const labels = windowFunctions.map(f => f.label as string);
        expect(labels).toContain('ROW_NUMBER');
        expect(labels).toContain('LAG');
    });
});

describe('YqlCompletionProvider — path autocomplete via viewer API', () => {
    const mockFetchEntities = vi.mocked(viewerService.fetchEntities);
    const mockFetchColumns = vi.mocked(viewerService.fetchColumns);

    const mockConnectionManager = {
        getActiveProfile: () => ({
            endpoint: 'grpc://localhost:2136',
            database: '/root',
            monitoringUrl: 'http://localhost:8765',
            authType: 'anonymous' as const,
        }),
    };

    const mockNavigatorProvider = {
        getTableNames: () => [],
        ensureTableNamesLoaded: async () => [],
    } as never;

    beforeEach(() => {
        mockFetchColumns.mockResolvedValue([]);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('passes empty prefix to fetchEntities when no backtick context', async () => {
        mockFetchEntities.mockResolvedValue([
            { Name: 'table1', Type: 'table', Parent: '' },
        ]);
        const prov = new YqlCompletionProvider(mockNavigatorProvider, mockConnectionManager as never);
        // column = text.length + 1 so cursor is at end of text
        const text = 'SELECT * FROM ';
        await prov.getCompletionItemsForText(text, 1, text.length + 1);
        expect(mockFetchEntities).toHaveBeenCalledWith(
            'http://localhost:8765',
            '/root',
            '',
            undefined,
        );
    });

    it('passes path prefix to fetchEntities when inside backtick', async () => {
        mockFetchEntities.mockResolvedValue([
            { Name: 'dir/table1', Type: 'table', Parent: '' },
        ]);
        const prov = new YqlCompletionProvider(mockNavigatorProvider, mockConnectionManager as never);
        const text = 'SELECT * FROM `dir/tab';
        await prov.getCompletionItemsForText(text, 1, text.length + 1);
        expect(mockFetchEntities).toHaveBeenCalledWith(
            'http://localhost:8765',
            '/root',
            'dir/tab',
            undefined,
        );
    });

    it('strips leading slash and database prefix from path prefix', async () => {
        mockFetchEntities.mockResolvedValue([]);
        const prov = new YqlCompletionProvider(mockNavigatorProvider, mockConnectionManager as never);
        // /root/dir/tab — database is /root, so normalized prefix is dir/tab
        const text = 'SELECT * FROM `/root/dir/tab';
        await prov.getCompletionItemsForText(text, 1, text.length + 1);
        expect(mockFetchEntities).toHaveBeenCalledWith(
            'http://localhost:8765',
            '/root',
            'dir/tab',
            undefined,
        );
    });

    it('returns short name as label/insertText when inside backtick', async () => {
        mockFetchEntities.mockResolvedValue([
            { Name: 'dir/table1', Type: 'table', Parent: '' },
            { Name: 'dir/table2', Type: 'table', Parent: '' },
        ]);
        const prov = new YqlCompletionProvider(mockNavigatorProvider, mockConnectionManager as never);
        const text = 'SELECT * FROM `dir/';
        const items = await prov.getCompletionItemsForText(text, 1, text.length + 1);
        const values = items.filter(i => i.kind === CompletionItemKind.Value);
        expect(values.length).toBe(2);
        expect(values.map(i => i.label as string)).toContain('table1');
        expect(values.map(i => i.label as string)).toContain('table2');
        const t1 = values.find(i => i.label === 'table1');
        expect(t1?.insertText).toBe('table1');
    });

    it('appends trailing slash to directory suggestions inside backtick', async () => {
        mockFetchEntities.mockResolvedValue([
            { Name: 'subdir', Type: 'dir', Parent: '' },
        ]);
        const prov = new YqlCompletionProvider(mockNavigatorProvider, mockConnectionManager as never);
        const text = 'SELECT * FROM `';
        const items = await prov.getCompletionItemsForText(text, 1, text.length + 1);
        const folders = items.filter(i => i.kind === CompletionItemKind.Folder);
        expect(folders.length).toBe(1);
        expect(folders[0].label as string).toBe('subdir/');
        expect(folders[0].insertText as string).toBe('subdir/');
    });

    it('wraps entity name in backticks when NOT inside backtick', async () => {
        mockFetchEntities.mockResolvedValue([
            { Name: 'table1', Type: 'table', Parent: '' },
        ]);
        const prov = new YqlCompletionProvider(mockNavigatorProvider, mockConnectionManager as never);
        const text = 'SELECT * FROM ';
        const items = await prov.getCompletionItemsForText(text, 1, text.length + 1);
        const values = items.filter(i => i.kind === CompletionItemKind.Value);
        const t1 = values.find(i => i.label === 'table1');
        expect(t1?.insertText).toBe('`table1`');
    });
});

describe('YqlCompletionProvider — SchemeService fallback backtick behavior', () => {
    const mockFetchEntities = vi.mocked(viewerService.fetchEntities);
    const mockFetchColumns = vi.mocked(viewerService.fetchColumns);

    const mockConnectionManager = {
        getActiveProfile: () => ({
            endpoint: 'grpc://localhost:2136',
            database: '/root',
            monitoringUrl: undefined,
            authType: 'anonymous' as const,
        }),
    };

    const mockNavigatorProvider = {
        getTableNames: () => ['path/to/users', 'path/to/orders'],
        ensureTableNamesLoaded: async () => ['path/to/users', 'path/to/orders'],
    } as never;

    beforeEach(() => {
        mockFetchEntities.mockRejectedValue(new Error('unavailable'));
        mockFetchColumns.mockResolvedValue([]);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('inside backtick with no prefix — label = full path, insertText = full path', async () => {
        const prov = new YqlCompletionProvider(mockNavigatorProvider, mockConnectionManager as never);
        const text = 'SELECT * FROM `';
        const items = await prov.getCompletionItemsForText(text, 1, text.length + 1);
        const values = items.filter(i => i.kind === CompletionItemKind.Value);
        const labels = values.map(i => i.label as string);
        expect(labels).toContain('path/to/users');
        expect(labels).toContain('path/to/orders');
        const usersItem = values.find(i => i.label === 'path/to/users');
        expect(usersItem?.insertText).toBe('path/to/users');
    });

    it('inside backtick with prefix path/to/ — label = users, insertText = users', async () => {
        const prov = new YqlCompletionProvider(mockNavigatorProvider, mockConnectionManager as never);
        const text = 'SELECT * FROM `path/to/';
        const items = await prov.getCompletionItemsForText(text, 1, text.length + 1);
        const values = items.filter(i => i.kind === CompletionItemKind.Value);
        const labels = values.map(i => i.label as string);
        expect(labels).toContain('users');
        expect(labels).toContain('orders');
        const usersItem = values.find(i => i.label === 'users');
        expect(usersItem?.insertText).toBe('users');
    });

    it('inside backtick with partial prefix path/to/u — label = users, insertText = users', async () => {
        const prov = new YqlCompletionProvider(mockNavigatorProvider, mockConnectionManager as never);
        const text = 'SELECT * FROM `path/to/u';
        const items = await prov.getCompletionItemsForText(text, 1, text.length + 1);
        const values = items.filter(i => i.kind === CompletionItemKind.Value);
        const labels = values.map(i => i.label as string);
        expect(labels).toContain('users');
        expect(labels).not.toContain('orders');
        const usersItem = values.find(i => i.label === 'users');
        expect(usersItem?.insertText).toBe('users');
    });
});
