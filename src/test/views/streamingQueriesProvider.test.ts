import { describe, it, expect } from 'vitest';
// StreamingQueriesProvider is part of navigatorProvider, not a separate file.
// We test the streaming query data model here.
import type { StreamingQuery } from '../../models/types';

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
