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

const clusterPayload = JSON.stringify({
    CoresUsed: '4.5',
    CoresTotal: '8',
    MemoryUsed: '1073741824',
    MemoryTotal: '8589934592',
    StorageUsed: '500',
    StorageTotal: '1000',
    NetworkWriteThroughput: '0',
});

describe('fetchDashboardMetrics', () => {
    let teardown: Array<() => Promise<void>> = [];
    beforeEach(() => { teardown = []; });
    afterEach(async () => { for (const fn of teardown) {await fn();} });

    it('returns runningQueries from queryService', async () => {
        const server = await makeServer((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(clusterPayload);
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
        const m = await fetchDashboardMetrics(base, auth, fakeQs);
        expect(m.runningQueries).toBe(7);
        expect(m.cpuUsed).toBe(4.5);
        expect(m.cpuTotal).toBe(8);
    });

    it('returns 0 runningQueries when queryService is undefined', async () => {
        const server = await makeServer((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(clusterPayload);
        });
        teardown.push(server.close);
        const base = `http://127.0.0.1:${server.port}`;
        const auth = new MonitoringAuthClient(base);
        const m = await fetchDashboardMetrics(base, auth);
        expect(m.runningQueries).toBe(0);
    });

    it('returns 0 runningQueries when query throws', async () => {
        const server = await makeServer((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(clusterPayload);
        });
        teardown.push(server.close);
        const fakeQs = {
            executeQuery: async () => { throw new Error('boom'); },
        } as unknown as QueryService;
        const base = `http://127.0.0.1:${server.port}`;
        const auth = new MonitoringAuthClient(base);
        const m = await fetchDashboardMetrics(base, auth, fakeQs);
        expect(m.runningQueries).toBe(0);
    });

    it('handles bigint Cnt value', async () => {
        const server = await makeServer((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(clusterPayload);
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
        const m = await fetchDashboardMetrics(base, auth, fakeQs);
        expect(m.runningQueries).toBe(3);
    });
});
