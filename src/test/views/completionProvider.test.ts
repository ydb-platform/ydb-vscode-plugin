import { describe, it, expect } from 'vitest';
import { YqlCompletionProvider } from '../../completionProvider';
import { CompletionItemKind } from 'vscode';

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
        expect(labels).toContain('users');
        expect(labels).toContain('orders');
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
        const usersItem = tableItems.find(i => i.label === 'users');
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
