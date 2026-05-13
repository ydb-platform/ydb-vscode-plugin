import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'http';
import { AddressInfo } from 'net';
import { fetchDashboardMetrics } from '../../commands/viewCommands';
import { MonitoringAuthClient } from '../../services/monitoringAuthClient';
import { QueryService } from '../../services/queryService';

function makeServer(
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ port: number; close: () => Promise<void> }> {
    const server = http.createServer((req, res) => handler(req, res));
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const port = (server.address() as AddressInfo).port;
            resolve({
                port,
                close: () => new Promise((r) => server.close(() => r())),
            });
        });
    });
}

const DATABASE = '/Root/my-db';

function tenantInfoPayload(extra: Record<string, unknown> = {}): string {
    return JSON.stringify({
        TenantInfo: [
            {
                Name: DATABASE,
                CoresUsed: 1.25,
                MemoryUsed: '1073741824',
                MemoryLimit: '8589934592',
                StorageAllocatedSize: '500',
                StorageAllocatedLimit: '1000',
                NetworkWriteThroughput: '0',
                PoolStats: [
                    { Name: 'System', Threads: 2, Usage: 0.1 },
                    { Name: 'User', Threads: 4, Usage: 0.3 },
                    { Name: 'Batch', Threads: 2, Usage: 0.0 },
                ],
                ...extra,
            },
        ],
    });
}

describe('fetchDashboardMetrics', () => {
    let teardown: Array<() => Promise<void>> = [];
    beforeEach(() => { teardown = []; });
    afterEach(async () => { for (const fn of teardown) {await fn();} });

    it('requests tenantinfo with database path and parses tenant-level metrics', async () => {
        let requestedUrl = '';
        const server = await makeServer((req, res) => {
            requestedUrl = req.url ?? '';
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(tenantInfoPayload());
        });
        teardown.push(server.close);

        const fakeQs = {
            executeQuery: async () => ({
                columns: [],
                rows: [{ Cnt: 7 }],
                truncated: false,
            }),
        } as unknown as QueryService;

        const base = `http://127.0.0.1:${server.port}`;
        const auth = new MonitoringAuthClient(base);
        const m = await fetchDashboardMetrics(base, DATABASE, auth, fakeQs);

        expect(requestedUrl).toBe(`/viewer/json/tenantinfo?path=${encodeURIComponent(DATABASE)}`);
        expect(m.cpuUsed).toBe(1.25);
        expect(m.cpuTotal).toBe(8); // sum of PoolStats.Threads (2+4+2)
        expect(m.memoryUsed).toBe(1073741824);
        expect(m.memoryTotal).toBe(8589934592);
        expect(m.storageUsed).toBe(500);
        expect(m.storageTotal).toBe(1000);
        expect(m.networkThroughput).toBe(0);
        expect(m.runningQueries).toBe(7);
    });

    it('picks tenant by Name when multiple tenants returned', async () => {
        const payload = JSON.stringify({
            TenantInfo: [
                {
                    Name: '/Root/other',
                    CoresUsed: 99,
                    PoolStats: [{ Name: 'User', Threads: 99 }],
                },
                {
                    Name: DATABASE,
                    CoresUsed: 2,
                    PoolStats: [{ Name: 'User', Threads: 4 }],
                },
            ],
        });
        const server = await makeServer((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(payload);
        });
        teardown.push(server.close);

        const base = `http://127.0.0.1:${server.port}`;
        const auth = new MonitoringAuthClient(base);
        const m = await fetchDashboardMetrics(base, DATABASE, auth);
        expect(m.cpuUsed).toBe(2);
        expect(m.cpuTotal).toBe(4);
    });

    it('returns zeros when TenantInfo is empty', async () => {
        const server = await makeServer((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ TenantInfo: [] }));
        });
        teardown.push(server.close);
        const base = `http://127.0.0.1:${server.port}`;
        const auth = new MonitoringAuthClient(base);
        const m = await fetchDashboardMetrics(base, DATABASE, auth);
        expect(m.cpuUsed).toBe(0);
        expect(m.cpuTotal).toBe(0);
        expect(m.memoryUsed).toBe(0);
        expect(m.storageUsed).toBe(0);
    });

    it('returns 0 runningQueries when queryService is undefined', async () => {
        const server = await makeServer((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(tenantInfoPayload());
        });
        teardown.push(server.close);
        const base = `http://127.0.0.1:${server.port}`;
        const auth = new MonitoringAuthClient(base);
        const m = await fetchDashboardMetrics(base, DATABASE, auth);
        expect(m.runningQueries).toBe(0);
    });

    it('returns 0 runningQueries when query throws', async () => {
        const server = await makeServer((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(tenantInfoPayload());
        });
        teardown.push(server.close);
        const fakeQs = {
            executeQuery: async () => { throw new Error('boom'); },
        } as unknown as QueryService;
        const base = `http://127.0.0.1:${server.port}`;
        const auth = new MonitoringAuthClient(base);
        const m = await fetchDashboardMetrics(base, DATABASE, auth, fakeQs);
        expect(m.runningQueries).toBe(0);
    });

    it('handles bigint Cnt value', async () => {
        const server = await makeServer((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(tenantInfoPayload());
        });
        teardown.push(server.close);
        const fakeQs = {
            executeQuery: async () => ({
                columns: [],
                rows: [{ Cnt: 3n as unknown as number }],
                truncated: false,
            }),
        } as unknown as QueryService;
        const base = `http://127.0.0.1:${server.port}`;
        const auth = new MonitoringAuthClient(base);
        const m = await fetchDashboardMetrics(base, DATABASE, auth, fakeQs);
        expect(m.runningQueries).toBe(3);
    });

    it('properly encodes special characters in database path', async () => {
        let requestedUrl = '';
        const server = await makeServer((req, res) => {
            requestedUrl = req.url ?? '';
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ TenantInfo: [] }));
        });
        teardown.push(server.close);
        const base = `http://127.0.0.1:${server.port}`;
        const auth = new MonitoringAuthClient(base);
        const db = '/Root/db with spaces&special';
        await fetchDashboardMetrics(base, db, auth);
        expect(requestedUrl).toBe(`/viewer/json/tenantinfo?path=${encodeURIComponent(db)}`);
    });
});
