import { describe, it, expect } from 'vitest';
import {
    isStreamingQueryErrorStatus,
    parseIssues,
    buildStreamingQueryTooltip,
} from '../../utils/streamingQueryStatus';
import type { StreamingQuery } from '../../models/types';

describe('isStreamingQueryErrorStatus', () => {
    it('returns false for RUNNING', () => {
        expect(isStreamingQueryErrorStatus('RUNNING')).toBe(false);
    });
    it('returns false for empty/undefined', () => {
        expect(isStreamingQueryErrorStatus(undefined)).toBe(false);
        expect(isStreamingQueryErrorStatus('')).toBe(false);
    });
    it('detects error/failed/suspended case-insensitively', () => {
        expect(isStreamingQueryErrorStatus('ERROR')).toBe(true);
        expect(isStreamingQueryErrorStatus('Failed')).toBe(true);
        expect(isStreamingQueryErrorStatus('suspended')).toBe(true);
        expect(isStreamingQueryErrorStatus('SOME_ERROR_STATE')).toBe(true);
    });
});

describe('parseIssues', () => {
    it('returns [] for empty input', () => {
        expect(parseIssues(undefined)).toEqual([]);
        expect(parseIssues('')).toEqual([]);
        expect(parseIssues('   ')).toEqual([]);
    });
    it('wraps non-JSON text as single ERROR issue', () => {
        expect(parseIssues('plain text issue')).toEqual([
            { message: 'plain text issue', severity: 'ERROR' },
        ]);
    });
    it('parses flat JSON issue', () => {
        const json = JSON.stringify([{ message: 'oops', severity: 2 }]);
        expect(parseIssues(json)).toEqual([{ message: 'oops', severity: 'WARNING' }]);
    });
    it('parses nested issues recursively', () => {
        const json = JSON.stringify([
            { message: 'outer', severity: 3, issues: [{ message: 'inner', severity: 1 }] },
        ]);
        expect(parseIssues(json)).toEqual([
            { message: 'outer', severity: 'ERROR' },
            { message: 'inner', severity: 'INFO' },
        ]);
    });
});

describe('buildStreamingQueryTooltip', () => {
    it('includes path and status', () => {
        const q: StreamingQuery = {
            name: 'q', fullPath: 'a/b/q', status: 'RUNNING', queryText: '',
        };
        const t = buildStreamingQueryTooltip(q);
        expect(t).toContain('a/b/q');
        expect(t).toContain('Status: RUNNING');
    });
    it('includes issues section when present', () => {
        const q: StreamingQuery = {
            name: 'q', fullPath: 'q', status: 'FAILED', queryText: '',
            issues: JSON.stringify([{ message: 'boom', severity: 3 }]),
        };
        const t = buildStreamingQueryTooltip(q);
        expect(t).toContain('Issues:');
        expect(t).toContain('[ERROR] boom');
    });
});
