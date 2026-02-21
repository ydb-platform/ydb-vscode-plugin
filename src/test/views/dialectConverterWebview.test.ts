import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('https', () => ({
    default: { request: vi.fn() },
    request: vi.fn(),
}));

import * as https from 'https';
import { buildConverterHtml, convertSql, fetchDialects } from '../../views/dialectConverterWebview';

function makeHttpsMock(statusCode: number, responseBody: string, captureWrite?: { value: string }) {
    vi.mocked(https.request).mockImplementation((_options: unknown, callback: unknown) => {
        const cb = callback as (res: unknown) => void;
        const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
        const res = {
            statusCode,
            on(event: string, handler: (...args: unknown[]) => void) {
                listeners[event] = listeners[event] ?? [];
                listeners[event].push(handler);
                return res;
            },
        };
        cb(res);
        const req = {
            on: () => req,
            setTimeout: () => req,
            destroy: vi.fn(),
            write: (body: string) => {
                if (captureWrite) { captureWrite.value += body; }
            },
            end: () => {
                (listeners['data'] ?? []).forEach(h => h(Buffer.from(responseBody)));
                (listeners['end'] ?? []).forEach(h => h());
            },
        };
        return req as unknown as ReturnType<typeof https.request>;
    });
}

describe('buildConverterHtml', () => {
    it('returns valid HTML document', () => {
        const html = buildConverterHtml();
        expect(html).toContain('<!DOCTYPE html>');
        expect(html).toContain('id="convertBtn"');
    });

    it('has dialect select initially disabled', () => {
        const html = buildConverterHtml();
        expect(html).toContain('id="dialect" disabled');
    });

    it('has convert button initially disabled', () => {
        const html = buildConverterHtml();
        expect(html).toContain('id="convertBtn"');
        expect(html).toMatch(/id="convertBtn"[^>]*disabled/);
    });

    it('has copy button initially disabled', () => {
        const html = buildConverterHtml();
        expect(html).toContain('id="copyBtn"');
        expect(html).toMatch(/id="copyBtn"[^>]*disabled/);
    });

    it('requests dialects on load via postMessage', () => {
        const html = buildConverterHtml();
        expect(html).toContain("vscode.postMessage({ type: 'getDialects' })");
    });

    it('has source SQL textarea', () => {
        const html = buildConverterHtml();
        expect(html).toContain('id="sqlInput"');
    });

    it('has result textarea (readonly)', () => {
        const html = buildConverterHtml();
        expect(html).toContain('id="sqlOutput"');
        expect(html).toContain('readonly');
    });

    it('has error message element', () => {
        const html = buildConverterHtml();
        expect(html).toContain('id="errorMsg"');
    });
});

describe('fetchDialects', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('resolves with dialects array on success', async () => {
        makeHttpsMock(200, JSON.stringify({ dialects: ['postgres', 'mysql', 'bigquery'] }));

        const dialects = await fetchDialects();
        expect(dialects).toEqual(['postgres', 'mysql', 'bigquery']);
    });

    it('uses GET /dialects path', async () => {
        let capturedOpts: unknown;
        vi.mocked(https.request).mockImplementation((opts: unknown, callback: unknown) => {
            capturedOpts = opts;
            const cb = callback as (res: unknown) => void;
            const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
            const res = {
                statusCode: 200,
                on(event: string, handler: (...args: unknown[]) => void) {
                    listeners[event] = listeners[event] ?? [];
                    listeners[event].push(handler);
                    return res;
                },
            };
            cb(res);
            const req = {
                on: () => req,
                setTimeout: () => req,
                destroy: vi.fn(),
                write: () => {},
                end: () => {
                    (listeners['data'] ?? []).forEach(h => h(Buffer.from(JSON.stringify({ dialects: [] }))));
                    (listeners['end'] ?? []).forEach(h => h());
                },
            };
            return req as unknown as ReturnType<typeof https.request>;
        });

        await fetchDialects();
        expect((capturedOpts as { method: string }).method).toBe('GET');
        expect((capturedOpts as { path: string }).path).toContain('?action=dialects');
    });

    it('rejects on HTTP error status', async () => {
        makeHttpsMock(500, 'Internal Server Error');

        await expect(fetchDialects()).rejects.toThrow('HTTP 500');
    });

    it('rejects when response has no dialects field', async () => {
        makeHttpsMock(200, JSON.stringify({ other: 'data' }));

        await expect(fetchDialects()).rejects.toThrow('missing dialects field');
    });

    it('rejects on invalid JSON', async () => {
        makeHttpsMock(200, 'not json');

        await expect(fetchDialects()).rejects.toThrow('Invalid response');
    });
});

describe('convertSql', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('resolves with convertedSql on success', async () => {
        makeHttpsMock(200, JSON.stringify({ convertedSql: 'SELECT * FROM table' }));

        const result = await convertSql('SELECT * FROM table', 'postgres');
        expect(result).toBe('SELECT * FROM table');
    });

    it('sends POST with correct body', async () => {
        const bodyCapture = { value: '' };
        let capturedOpts: unknown;
        vi.mocked(https.request).mockImplementation((opts: unknown, callback: unknown) => {
            capturedOpts = opts;
            const cb = callback as (res: unknown) => void;
            const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
            const res = {
                statusCode: 200,
                on(event: string, handler: (...args: unknown[]) => void) {
                    listeners[event] = listeners[event] ?? [];
                    listeners[event].push(handler);
                    return res;
                },
            };
            cb(res);
            const req = {
                on: () => req,
                setTimeout: () => req,
                destroy: vi.fn(),
                write: (body: string) => { bodyCapture.value += body; },
                end: () => {
                    (listeners['data'] ?? []).forEach(h => h(Buffer.from(JSON.stringify({ convertedSql: 'result' }))));
                    (listeners['end'] ?? []).forEach(h => h());
                },
            };
            return req as unknown as ReturnType<typeof https.request>;
        });

        await convertSql('SELECT 1', 'mysql');

        expect((capturedOpts as { method: string }).method).toBe('POST');
        expect(bodyCapture.value).toBe(JSON.stringify({ sql: 'SELECT 1', dialect: 'mysql' }));
    });

    it('rejects on HTTP error status', async () => {
        makeHttpsMock(400, 'Bad Request');

        await expect(convertSql('SELECT 1', 'postgres')).rejects.toThrow('HTTP 400');
    });

    it('rejects on invalid JSON response', async () => {
        makeHttpsMock(200, 'not json');

        await expect(convertSql('SELECT 1', 'postgres')).rejects.toThrow('Invalid response');
    });

    it('returns empty string when convertedSql is missing', async () => {
        makeHttpsMock(200, JSON.stringify({}));

        const result = await convertSql('SELECT 1', 'postgres');
        expect(result).toBe('');
    });
});
