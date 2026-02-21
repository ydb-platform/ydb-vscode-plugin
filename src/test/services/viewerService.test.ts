import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'http';
import { fetchEntities, fetchColumns } from '../../services/viewerService';

function createMockServer(responseBody: string, statusCode = 200): Promise<{ server: http.Server; port: number }> {
    return new Promise((resolve) => {
        const server = http.createServer((_req, res) => {
            res.writeHead(statusCode, { 'Content-Type': 'application/json' });
            res.end(responseBody);
        });
        server.listen(0, () => {
            const addr = server.address();
            const port = typeof addr === 'object' && addr ? addr.port : 0;
            resolve({ server, port });
        });
    });
}

describe('viewerService', () => {
    let server: http.Server | null = null;

    afterEach(() => {
        if (server) {
            server.close();
            server = null;
        }
    });

    describe('fetchEntities', () => {
        it('returns entities on success', async () => {
            const response = JSON.stringify({
                Success: true,
                Result: {
                    Entities: [
                        { Name: 'users', Type: 'table', Parent: '' },
                        { Name: 'orders', Type: 'table', Parent: '' },
                        { Name: 'logs', Type: 'dir', Parent: '' },
                    ],
                    Total: 3,
                },
            });

            const { server: s, port } = await createMockServer(response);
            server = s;

            const entities = await fetchEntities(`http://localhost:${port}`, '/mydb', '');
            expect(entities).toHaveLength(3);
            expect(entities[0].Name).toBe('users');
            expect(entities[1].Type).toBe('table');
        });

        it('returns empty array on failure response', async () => {
            const response = JSON.stringify({
                Success: false,
                Error: ['Not found'],
                Result: {},
            });

            const { server: s, port } = await createMockServer(response);
            server = s;

            const entities = await fetchEntities(`http://localhost:${port}`, '/mydb', '');
            expect(entities).toHaveLength(0);
        });

        it('returns empty array on HTTP error', async () => {
            const { server: s, port } = await createMockServer('Internal Error', 500);
            server = s;

            const entities = await fetchEntities(`http://localhost:${port}`, '/mydb', '');
            expect(entities).toHaveLength(0);
        });

        it('returns empty array on connection error', async () => {
            const entities = await fetchEntities('http://localhost:1', '/mydb', '');
            expect(entities).toHaveLength(0);
        });
    });

    describe('fetchColumns', () => {
        it('returns column entities on success', async () => {
            const response = JSON.stringify({
                Success: true,
                Result: {
                    Entities: [
                        { Name: 'id', Type: 'column', Parent: 'users', PKIndex: 0, NotNull: true },
                        { Name: 'name', Type: 'column', Parent: 'users' },
                    ],
                    Total: 2,
                },
            });

            const { server: s, port } = await createMockServer(response);
            server = s;

            const columns = await fetchColumns(`http://localhost:${port}`, '/mydb', ['users/']);
            expect(columns).toHaveLength(2);
            expect(columns[0].Name).toBe('id');
            expect(columns[0].PKIndex).toBe(0);
            expect(columns[1].Name).toBe('name');
        });

        it('returns empty array when no entities', async () => {
            const response = JSON.stringify({
                Success: true,
                Result: { Entities: [] },
            });

            const { server: s, port } = await createMockServer(response);
            server = s;

            const columns = await fetchColumns(`http://localhost:${port}`, '/mydb', ['missing/']);
            expect(columns).toHaveLength(0);
        });

        it('returns empty array on error', async () => {
            const columns = await fetchColumns('http://localhost:1', '/mydb', ['users/']);
            expect(columns).toHaveLength(0);
        });
    });
});
