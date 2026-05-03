import { describe, it, expect } from 'vitest';
// StreamingQueriesProvider is part of navigatorProvider, not a separate file.
// We test the streaming query data model here.
import type { StreamingQuery } from '../../models/types';
import { StreamingQueryItem } from '../../views/streamingQueriesProvider';
import { ThemeIcon } from 'vscode';

describe('StreamingQuery model', () => {
    it('has all required fields', () => {
        const query: StreamingQuery = {
            name: 'my_query',
            fullPath: 'folder/my_query',
            status: 'RUNNING',
            queryText: 'SELECT * FROM stream',
        };
        expect(query.name).toBe('my_query');
        expect(query.fullPath).toBe('folder/my_query');
        expect(query.status).toBe('RUNNING');
        expect(query.queryText).toBe('SELECT * FROM stream');
    });

    it('optional fields default to undefined', () => {
        const query: StreamingQuery = {
            name: 'q',
            fullPath: 'q',
            status: 'STOPPED',
            queryText: '',
        };
        expect(query.resourcePool).toBeUndefined();
        expect(query.retryCount).toBeUndefined();
        expect(query.lastFailAt).toBeUndefined();
        expect(query.suspendedUntil).toBeUndefined();
        expect(query.plan).toBeUndefined();
        expect(query.ast).toBeUndefined();
        expect(query.issues).toBeUndefined();
    });

    it('all optional fields can be set', () => {
        const query: StreamingQuery = {
            name: 'q',
            fullPath: 'q',
            status: 'RUNNING',
            queryText: 'SELECT 1',
            resourcePool: 'default',
            retryCount: 3,
            lastFailAt: '2024-01-01T00:00:00Z',
            suspendedUntil: '2024-01-02T00:00:00Z',
            plan: '{}',
            ast: 'ast-text',
            issues: 'some issue',
        };
        expect(query.resourcePool).toBe('default');
        expect(query.retryCount).toBe(3);
        expect(query.lastFailAt).toBeDefined();
        expect(query.issues).toBe('some issue');
    });
});

describe('StreamingQueryItem decoration', () => {
    it('RUNNING: play-circle icon, no error context', () => {
        const item = new StreamingQueryItem({
            name: 'q', fullPath: 'q', status: 'RUNNING', queryText: '',
        });
        expect(item.contextValue).toBe('streaming-query-running');
        expect((item.iconPath as ThemeIcon).id).toBe('play-circle');
    });
    it('error status gets error icon + error context + issues in tooltip', () => {
        const item = new StreamingQueryItem({
            name: 'q', fullPath: 'q', status: 'FAILED', queryText: '',
            issues: JSON.stringify([{ message: 'boom', severity: 3 }]),
        });
        expect(item.contextValue).toBe('streaming-query-error');
        expect((item.iconPath as ThemeIcon).id).toBe('error');
        expect(String(item.tooltip)).toContain('[ERROR] boom');
    });
    it('stopped (non-error, non-running) gets debug-stop icon', () => {
        const item = new StreamingQueryItem({
            name: 'q', fullPath: 'q', status: 'STOPPED', queryText: '',
        });
        expect(item.contextValue).toBe('streaming-query-stopped');
        expect((item.iconPath as ThemeIcon).id).toBe('debug-stop');
    });
});
