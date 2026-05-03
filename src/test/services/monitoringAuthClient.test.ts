import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'http';
import { AddressInfo } from 'net';
import {
    MonitoringAuthClient,
    buildMonitoringAuthClient,
    extractSessionCookie,
} from '../../services/monitoringAuthClient';
import { ConnectionProfile } from '../../models/connectionProfile';

describe('extractSessionCookie', () => {
    it('returns the value of ydb_session_id', () => {
        expect(
            extractSessionCookie('ydb_session_id=abc123; Max-Age=43199'),
        ).toBe('abc123');
    });

    it('finds the cookie when not first', () => {
        expect(
            extractSessionCookie('foo=bar; ydb_session_id=xyz; path=/'),
        ).toBe('xyz');
    });

    it('returns undefined when cookie is missing', () => {
        expect(extractSessionCookie('foo=bar')).toBeUndefined();
    });

    it('returns undefined for null-like header', () => {
        expect(extractSessionCookie('')).toBeUndefined();
    });
});

describe('buildMonitoringAuthClient', () => {
    const baseProfile = {
        id: 'p',
        name: 'Test',
        endpoint: 'h:2135',
        database: '/db',
        secure: false,
    } as Pick<ConnectionProfile, 'id' | 'name' | 'endpoint' | 'database' | 'secure'>;

    it('returns a client for token auth', () => {
        const c = buildMonitoringAuthClient('http://m:8765', {
            ...baseProfile,
            authType: 'token',
            token: 't',
        } as ConnectionProfile);
        expect(c).toBeInstanceOf(MonitoringAuthClient);
    });

    it('returns a client for static auth', () => {
        const c = buildMonitoringAuthClient('http://m:8765', {
            ...baseProfile,
            authType: 'static',
            username: 'root1',
            password: 'pw',
        } as ConnectionProfile);
        expect(c).toBeInstanceOf(MonitoringAuthClient);
    });

    it('returns an unauthenticated client for anonymous', () => {
        const c = buildMonitoringAuthClient('http://m:8765', {
            ...baseProfile,
            authType: 'anonymous',
        } as ConnectionProfile);
        expect(c).toBeInstanceOf(MonitoringAuthClient);
    });
});

interface CapturedRequest {
    method: string;
    path: string;
    headers: http.IncomingHttpHeaders;
    body: string;
}

function makeServer(
    handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void,
): Promise<{ port: number; close: () => Promise<void>; requests: CapturedRequest[] }> {
    const requests: CapturedRequest[] = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk.toString(); });
        req.on('end', () => {
            requests.push({
                method: req.method ?? '',
                path: req.url ?? '',
                headers: req.headers,
                body,
            });
            handler(req, body, res);
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const port = (server.address() as AddressInfo).port;
            resolve({
                port,
                requests,
                close: () => new Promise((r) => server.close(() => r())),
            });
        });
    });
}

describe('MonitoringAuthClient', () => {
    let teardown: Array<() => Promise<void>> = [];

    beforeEach(() => {
        teardown = [];
    });

    afterEach(async () => {
        for (const fn of teardown) {await fn();}
    });

    it('sends Authorization: OAuth <token> for token auth', async () => {
        const server = await makeServer((_, __, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"ok":true}');
        });
        teardown.push(server.close);
        const base = `http://127.0.0.1:${server.port}`;
        const client = new MonitoringAuthClient(base, 'TKN');

        const data = await client.httpGet(`${base}/viewer/json/cluster`);
        expect(data).toBe('{"ok":true}');
        expect(server.requests).toHaveLength(1);
        expect(server.requests[0].headers.authorization).toBe('OAuth TKN');
    });

    it('logs in with user/password and reuses the cookie', async () => {
        const server = await makeServer((req, body, res) => {
            if (req.url === '/login' && req.method === 'POST') {
                expect(JSON.parse(body)).toEqual({ user: 'root1', password: 'pw' });
                res.writeHead(200, {
                    'Set-Cookie': 'ydb_session_id=cookie-A; Max-Age=43199; Path=/',
                });
                res.end();
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"ok":1}');
        });
        teardown.push(server.close);
        const base = `http://127.0.0.1:${server.port}`;
        const client = new MonitoringAuthClient(base, undefined, 'root1', 'pw');

        await client.httpGet(`${base}/viewer/json/cluster`);
        await client.httpGet(`${base}/viewer/json/cluster`);

        // 1 login + 2 viewer calls = 3 requests
        expect(server.requests).toHaveLength(3);
        expect(server.requests[0].method).toBe('POST');
        expect(server.requests[0].path).toBe('/login');
        expect(server.requests[1].headers.cookie).toBe('ydb_session_id=cookie-A');
        expect(server.requests[2].headers.cookie).toBe('ydb_session_id=cookie-A');
    });

    it('logs in with empty password when password is undefined', async () => {
        const server = await makeServer((req, body, res) => {
            if (req.url === '/login') {
                expect(JSON.parse(body)).toEqual({ user: 'root1', password: '' });
                res.writeHead(200, { 'Set-Cookie': 'ydb_session_id=c; Path=/' });
                res.end();
                return;
            }
            res.writeHead(200);
            res.end('{}');
        });
        teardown.push(server.close);
        const base = `http://127.0.0.1:${server.port}`;
        const client = new MonitoringAuthClient(base, undefined, 'root1');
        await client.httpGet(`${base}/viewer/json/cluster`);
        expect(server.requests[0].path).toBe('/login');
    });

    it('on 401 invalidates session, re-logs in, and retries once', async () => {
        let loginCount = 0;
        const server = await makeServer((req, _body, res) => {
            if (req.url === '/login') {
                loginCount++;
                const cookie = loginCount === 1 ? 'cookie-old' : 'cookie-new';
                res.writeHead(200, { 'Set-Cookie': `ydb_session_id=${cookie}; Path=/` });
                res.end();
                return;
            }
            const sentCookie = req.headers.cookie ?? '';
            if (sentCookie.includes('cookie-old')) {
                res.writeHead(401);
                res.end();
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"ok":true}');
        });
        teardown.push(server.close);
        const base = `http://127.0.0.1:${server.port}`;
        const client = new MonitoringAuthClient(base, undefined, 'root1', 'pw');

        const data = await client.httpGet(`${base}/viewer/json/cluster`);
        expect(data).toBe('{"ok":true}');

        const paths = server.requests.map((r) => r.path);
        expect(paths.filter((p) => p === '/login')).toHaveLength(2);
        expect(paths.filter((p) => p === '/viewer/json/cluster')).toHaveLength(2);
    });

    it('rejects when login response has no ydb_session_id cookie', async () => {
        const server = await makeServer((req, _body, res) => {
            if (req.url === '/login') {
                res.writeHead(200, { 'Set-Cookie': 'foo=bar; Path=/' });
                res.end();
                return;
            }
            res.writeHead(200);
            res.end('{}');
        });
        teardown.push(server.close);
        const base = `http://127.0.0.1:${server.port}`;
        const client = new MonitoringAuthClient(base, undefined, 'root1', 'pw');

        await expect(client.httpGet(`${base}/viewer/json/cluster`)).rejects.toThrow(/ydb_session_id/);
    });

    it('rejects when login returns non-200', async () => {
        const server = await makeServer((req, _body, res) => {
            if (req.url === '/login') {
                res.writeHead(403);
                res.end();
                return;
            }
            res.writeHead(200);
            res.end('{}');
        });
        teardown.push(server.close);
        const base = `http://127.0.0.1:${server.port}`;
        const client = new MonitoringAuthClient(base, undefined, 'root1', 'pw');
        await expect(client.httpGet(`${base}/viewer/json/cluster`)).rejects.toThrow(/Login failed/);
    });

    it('does not send any auth headers for anonymous client', async () => {
        const server = await makeServer((_, __, res) => {
            res.writeHead(200);
            res.end('{}');
        });
        teardown.push(server.close);
        const base = `http://127.0.0.1:${server.port}`;
        const client = new MonitoringAuthClient(base);
        await client.httpGet(`${base}/viewer/json/cluster`);
        expect(server.requests[0].headers.authorization).toBeUndefined();
        expect(server.requests[0].headers.cookie).toBeUndefined();
    });

    it('coalesces concurrent login requests', async () => {
        let loginCount = 0;
        const server = await makeServer((req, _body, res) => {
            if (req.url === '/login') {
                loginCount++;
                setTimeout(() => {
                    res.writeHead(200, { 'Set-Cookie': 'ydb_session_id=c; Path=/' });
                    res.end();
                }, 30);
                return;
            }
            res.writeHead(200);
            res.end('{"k":1}');
        });
        teardown.push(server.close);
        const base = `http://127.0.0.1:${server.port}`;
        const client = new MonitoringAuthClient(base, undefined, 'root1', 'pw');
        await Promise.all([
            client.httpGet(`${base}/a`),
            client.httpGet(`${base}/b`),
            client.httpGet(`${base}/c`),
        ]);
        expect(loginCount).toBe(1);
    });
});
