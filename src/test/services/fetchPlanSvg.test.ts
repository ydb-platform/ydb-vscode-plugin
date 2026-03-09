import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'http';
import { fetchPlanSvg, flattenIssues } from '../../services/queryService';

function createMockServer(
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ server: http.Server; port: number }> {
    return new Promise((resolve) => {
        const server = http.createServer(handler);
        server.listen(0, () => {
            const addr = server.address();
            const port = typeof addr === 'object' && addr ? addr.port : 0;
            resolve({ server, port });
        });
    });
}

describe('fetchPlanSvg', () => {
    let server: http.Server | null = null;

    afterEach(() => {
        if (server) {
            server.close();
            server = null;
        }
    });

    it('passes database as query parameter', async () => {
        let receivedUrl = '';
        const { server: s, port } = await createMockServer((req, res) => {
            receivedUrl = req.url ?? '';
            res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
            res.end('<svg></svg>');
        });
        server = s;

        await fetchPlanSvg(`http://localhost:${port}`, '{"plan":{}}', '/mydb');
        expect(receivedUrl).toContain('database=%2Fmydb');
    });

    it('sends Accept: image/svg+xml header', async () => {
        let receivedAccept = '';
        const { server: s, port } = await createMockServer((req, res) => {
            receivedAccept = req.headers['accept'] ?? '';
            res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
            res.end('<svg></svg>');
        });
        server = s;

        await fetchPlanSvg(`http://localhost:${port}`, '{}', '/db');
        expect(receivedAccept).toBe('image/svg+xml');
    });

    it('returns SVG content on success', async () => {
        const svgBody = '<svg><rect width="100" height="100"/></svg>';
        const { server: s, port } = await createMockServer((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
            res.end(svgBody);
        });
        server = s;

        const result = await fetchPlanSvg(`http://localhost:${port}`, '{}', '/db');
        expect(result).toBe(svgBody);
    });

    it('rejects on non-200 status', async () => {
        const { server: s, port } = await createMockServer((_req, res) => {
            res.writeHead(500);
            res.end('Internal Server Error');
        });
        server = s;

        await expect(fetchPlanSvg(`http://localhost:${port}`, '{}', '/db')).rejects.toThrow(
            /plan2svg returned HTTP 500/,
        );
    });

    it('sends POST body with plan JSON', async () => {
        let receivedBody = '';
        const { server: s, port } = await createMockServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on('data', (chunk: Buffer) => chunks.push(chunk));
            req.on('end', () => {
                receivedBody = Buffer.concat(chunks).toString('utf-8');
                res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
                res.end('<svg></svg>');
            });
        });
        server = s;

        const planJson = '{"tables":[]}';
        await fetchPlanSvg(`http://localhost:${port}`, planJson, '/db');
        expect(receivedBody).toBe(planJson);
    });

    it('sends Authorization header when authToken is provided', async () => {
        let receivedAuth = '';
        const { server: s, port } = await createMockServer((req, res) => {
            receivedAuth = req.headers['authorization'] ?? '';
            res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
            res.end('<svg></svg>');
        });
        server = s;

        await fetchPlanSvg(`http://localhost:${port}`, '{}', '/db', 'Bearer mytoken');
        expect(receivedAuth).toBe('Bearer mytoken');
    });
});

describe('flattenIssues', () => {
    it('returns empty string for empty array', () => {
        expect(flattenIssues([])).toBe('');
    });

    it('joins top-level messages', () => {
        expect(flattenIssues([
            { message: 'Error A' },
            { message: 'Error B' },
        ])).toBe('Error A; Error B');
    });

    it('collects nested issues recursively', () => {
        expect(flattenIssues([
            {
                message: 'Type annotation',
                issues: [
                    {
                        message: 'At function: KiReadTable!',
                        issues: [
                            { message: 'Cannot find table' },
                        ],
                    },
                ],
            },
        ])).toBe('Type annotation; At function: KiReadTable!; Cannot find table');
    });

    it('skips issues without message', () => {
        expect(flattenIssues([
            { issues: [{ message: 'nested' }] },
        ])).toBe('nested');
    });

    it('handles deeply nested issues', () => {
        expect(flattenIssues([
            { message: 'L1', issues: [
                { message: 'L2', issues: [
                    { message: 'L3', issues: [
                        { message: 'L4' },
                    ] },
                ] },
            ] },
        ])).toBe('L1; L2; L3; L4');
    });
});
