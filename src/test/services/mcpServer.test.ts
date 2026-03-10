import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpService } from '../../services/mcpServer';
import { ConnectionManager } from '../../services/connectionManager';
import { MockMemento } from '../helpers/mockMemento';
import { QueryService } from '../../services/queryService';
import { SchemeService } from '../../services/schemeService';

// ---------------------------------------------------------------------------
// Unit tests for McpService static helpers (no HTTP, no mocks needed)
// ---------------------------------------------------------------------------

describe('McpService.resolveTablePath', () => {
    it('returns absolute path unchanged', () => {
        expect(McpService.resolveTablePath('/mydb', '/mydb/my_table')).toBe('/mydb/my_table');
    });

    it('prepends database to relative path', () => {
        expect(McpService.resolveTablePath('/mydb', 'my_table')).toBe('/mydb/my_table');
    });

    it('handles relative path with subdirectory', () => {
        expect(McpService.resolveTablePath('/mydb', 'subdir/my_table')).toBe('/mydb/subdir/my_table');
    });

    it('strips trailing slash from database before joining', () => {
        expect(McpService.resolveTablePath('/mydb/', 'my_table')).toBe('/mydb/my_table');
    });

    it('returns root-based absolute path unchanged even when database differs', () => {
        expect(McpService.resolveTablePath('/other', '/mydb/my_table')).toBe('/mydb/my_table');
    });
});

// Helpers -----------------------------------------------------------------------

function getRandomPort(): number {
    return 40000 + Math.floor(Math.random() * 10000);
}

/** Fetch only response headers — safe for SSE (stream never ends). */
function httpGetHeaders(url: string): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
            res.destroy();
            resolve({ statusCode: res.statusCode ?? 0, headers: res.headers });
        });
        req.on('error', (err: NodeJS.ErrnoException) => {
            if (err.code !== 'ECONNRESET') { reject(err); }
        });
        req.setTimeout(5000, () => req.destroy(new Error('timeout')));
    });
}

/** Fetch with full body (for short responses like 404). */
function httpGet(url: string): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
            let body = '';
            res.on('data', (c: Buffer) => { body += c.toString(); });
            res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body }));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(5000, () => req.destroy(new Error('timeout')));
    });
}

function httpPost(url: string, body: string): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const req = http.request(
            { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
            (res) => {
                let b = '';
                res.on('data', (c: Buffer) => { b += c.toString(); });
                res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: b }));
                res.on('error', reject);
            },
        );
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// Setup -------------------------------------------------------------------------

describe('McpService', () => {
    let manager: ConnectionManager;
    let service: McpService;
    let port: number;

    beforeEach(() => {
        manager = ConnectionManager.getInstance();
        manager.initialize(new MockMemento());
        service = new McpService(manager);
        port = getRandomPort();
    });

    afterEach(() => {
        service.dispose();
        vi.restoreAllMocks();
    });

    // --- HTTP lifecycle ---

    describe('lifecycle', () => {
        it('starts on a port and responds to GET /sse with 200', async () => {
            await service.start(port);
            const res = await httpGetHeaders(`http://127.0.0.1:${port}/sse`);
            expect(res.statusCode).toBe(200);
        });

        it('GET /sse returns text/event-stream content-type', async () => {
            await service.start(port);
            const res = await httpGetHeaders(`http://127.0.0.1:${port}/sse`);
            expect(res.headers['content-type']).toContain('text/event-stream');
        });

        it('returns 404 for unknown paths', async () => {
            await service.start(port);
            const res = await httpGet(`http://127.0.0.1:${port}/unknown`);
            expect(res.statusCode).toBe(404);
        });

        it('returns 404 for POST /message with unknown sessionId', async () => {
            await service.start(port);
            const res = await httpPost(
                `http://127.0.0.1:${port}/message?sessionId=no-such-session`,
                JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
            );
            expect(res.statusCode).toBe(404);
        });

        it('stops cleanly on dispose()', async () => {
            await service.start(port);
            expect(() => service.dispose()).not.toThrow();
        });

        it('dispose() before start() does not throw', () => {
            expect(() => service.dispose()).not.toThrow();
        });

        it('does not throw when port is already in use', async () => {
            const blocker = http.createServer().listen(port, '127.0.0.1');
            await new Promise<void>(r => blocker.on('listening', r));
            try {
                await expect(service.start(port)).resolves.not.toThrow();
            } finally {
                blocker.close();
            }
        });
    });

    // --- ydb_list_connections ---

    describe('ydb_list_connections tool', () => {
        it('returns "no connections" message when list is empty', async () => {
            const result = await invokeTool(manager, 'ydb_list_connections', {});
            expect(result).toContain('No connections configured');
        });

        it('returns all configured connections with metadata', async () => {
            await manager.addProfile({ name: 'prod', endpoint: 'grpcs://ydb.example.com:2135', database: '/production', authType: 'token', secure: true });
            await manager.addProfile({ name: 'local', endpoint: 'grpc://localhost:2135', database: '/local', authType: 'anonymous', secure: false });

            const result = await invokeTool(manager, 'ydb_list_connections', {});
            const parsed = JSON.parse(result);
            expect(parsed).toHaveLength(2);
            expect(parsed.map((p: { name: string }) => p.name)).toEqual(['prod', 'local']);
            expect(parsed[0].database).toBe('/production');
            expect(parsed[1].connected).toBe(false);
        });
    });

    // --- ydb_query ---

    describe('ydb_query tool', () => {
        it('returns error when connection name is not found', async () => {
            const result = await invokeTool(manager, 'ydb_query', { connection: 'ghost', sql: 'SELECT 1' });
            expect(result).toContain('Error:');
            expect(result).toContain('"ghost" not found');
        });

        it('error message lists available connections', async () => {
            await manager.addProfile({ name: 'dev', endpoint: 'grpc://localhost:2135', database: '/dev', authType: 'anonymous', secure: false });
            const result = await invokeTool(manager, 'ydb_query', { connection: 'ghost', sql: 'SELECT 1' });
            expect(result).toContain('"dev"');
        });

        it('returns query results on success', async () => {
            await manager.addProfile({ name: 'dev', endpoint: 'grpc://localhost:2135', database: '/dev', authType: 'anonymous', secure: false });
            vi.spyOn(manager, 'getDriver').mockResolvedValue({ options: {}, isSecure: false } as never);
            vi.spyOn(QueryService.prototype, 'executeQuery').mockResolvedValue({
                columns: [{ name: 'id', type: 'Int32' }],
                rows: [{ id: 42 }],
                truncated: false,
            });

            const result = await invokeTool(manager, 'ydb_query', { connection: 'dev', sql: 'SELECT id FROM t' });
            const parsed = JSON.parse(result);
            expect(parsed.columns[0].name).toBe('id');
            expect(parsed.rows[0].id).toBe(42);
        });

        it('returns error text when query fails', async () => {
            await manager.addProfile({ name: 'dev', endpoint: 'grpc://localhost:2135', database: '/dev', authType: 'anonymous', secure: false });
            vi.spyOn(manager, 'getDriver').mockResolvedValue({ options: {}, isSecure: false } as never);
            vi.spyOn(QueryService.prototype, 'executeQuery').mockRejectedValue(new Error('network timeout'));

            const result = await invokeTool(manager, 'ydb_query', { connection: 'dev', sql: 'SELECT 1' });
            expect(result).toBe('Error: network timeout');
        });
    });

    // --- ydb_describe_table ---

    describe('ydb_describe_table tool', () => {
        it('returns error when connection is not found', async () => {
            const result = await invokeTool(manager, 'ydb_describe_table', { connection: 'ghost', path: '/db/t' });
            expect(result).toContain('Error:');
        });

        it('returns table schema on success with absolute path', async () => {
            await manager.addProfile({ name: 'dev', endpoint: 'grpc://localhost:2135', database: '/dev', authType: 'anonymous', secure: false });
            vi.spyOn(manager, 'getDriver').mockResolvedValue({ options: {}, isSecure: false } as never);
            vi.spyOn(QueryService.prototype, 'describeTable').mockResolvedValue({
                columns: [{ name: 'id', type: 'Int32', notNull: true }, { name: 'val', type: 'Utf8', notNull: false }],
                primaryKeys: ['id'],
                partitionBy: [],
                isColumnTable: false,
            });

            const result = await invokeTool(manager, 'ydb_describe_table', { connection: 'dev', path: '/dev/my_table' });
            const parsed = JSON.parse(result);
            expect(parsed.primaryKeys).toEqual(['id']);
            expect(parsed.columns).toHaveLength(2);
        });

        it('resolves relative path by prepending the database root', async () => {
            await manager.addProfile({ name: 'dev', endpoint: 'grpc://localhost:2135', database: '/dev', authType: 'anonymous', secure: false });
            vi.spyOn(manager, 'getDriver').mockResolvedValue({ options: {}, isSecure: false } as never);
            const spy = vi.spyOn(QueryService.prototype, 'describeTable').mockResolvedValue({
                columns: [{ name: 'id', type: 'Int32', notNull: true }],
                primaryKeys: ['id'],
                partitionBy: [],
                isColumnTable: false,
            });

            await invokeTool(manager, 'ydb_describe_table', { connection: 'dev', path: 'my_table' });
            expect(spy).toHaveBeenCalledWith('/dev/my_table');
        });

        it('resolves relative path with subdirectory', async () => {
            await manager.addProfile({ name: 'dev', endpoint: 'grpc://localhost:2135', database: '/dev', authType: 'anonymous', secure: false });
            vi.spyOn(manager, 'getDriver').mockResolvedValue({ options: {}, isSecure: false } as never);
            const spy = vi.spyOn(QueryService.prototype, 'describeTable').mockResolvedValue({
                columns: [],
                primaryKeys: [],
                partitionBy: [],
                isColumnTable: false,
            });

            await invokeTool(manager, 'ydb_describe_table', { connection: 'dev', path: 'subdir/my_table' });
            expect(spy).toHaveBeenCalledWith('/dev/subdir/my_table');
        });

        it('does not double-prepend when absolute path matches database', async () => {
            await manager.addProfile({ name: 'dev', endpoint: 'grpc://localhost:2135', database: '/dev', authType: 'anonymous', secure: false });
            vi.spyOn(manager, 'getDriver').mockResolvedValue({ options: {}, isSecure: false } as never);
            const spy = vi.spyOn(QueryService.prototype, 'describeTable').mockResolvedValue({
                columns: [],
                primaryKeys: [],
                partitionBy: [],
                isColumnTable: false,
            });

            await invokeTool(manager, 'ydb_describe_table', { connection: 'dev', path: '/dev/my_table' });
            expect(spy).toHaveBeenCalledWith('/dev/my_table');
        });
    });

    // --- ydb_list_directory ---

    describe('ydb_list_directory tool', () => {
        it('returns error when connection is not found', async () => {
            const result = await invokeTool(manager, 'ydb_list_directory', { connection: 'ghost', path: '' });
            expect(result).toContain('Error:');
        });

        it('returns directory entries with string type names', async () => {
            await manager.addProfile({ name: 'dev', endpoint: 'grpc://localhost:2135', database: '/dev', authType: 'anonymous', secure: false });
            vi.spyOn(manager, 'getDriver').mockResolvedValue({ options: {}, isSecure: false } as never);
            vi.spyOn(SchemeService.prototype, 'listDirectory').mockResolvedValue([
                { name: 'orders', type: 2 },   // TABLE
                { name: 'archive', type: 1 },   // DIRECTORY
                { name: 'ext', type: 18 },      // EXTERNAL_TABLE
            ] as never);

            const result = await invokeTool(manager, 'ydb_list_directory', { connection: 'dev', path: '' });
            const parsed = JSON.parse(result);
            expect(parsed).toHaveLength(3);
            expect(parsed[0]).toEqual({ name: 'orders', type: 'TABLE' });
            expect(parsed[1]).toEqual({ name: 'archive', type: 'DIRECTORY' });
            expect(parsed[2]).toEqual({ name: 'ext', type: 'EXTERNAL_TABLE' });
        });

        it('filters out entries whose names start with "."', async () => {
            await manager.addProfile({ name: 'dev', endpoint: 'grpc://localhost:2135', database: '/dev', authType: 'anonymous', secure: false });
            vi.spyOn(manager, 'getDriver').mockResolvedValue({ options: {}, isSecure: false } as never);
            vi.spyOn(SchemeService.prototype, 'listDirectory').mockResolvedValue([
                { name: 'orders', type: 2 },
                { name: '.sys', type: 1 },
                { name: '.metadata', type: 1 },
                { name: 'users', type: 2 },
            ] as never);

            const result = await invokeTool(manager, 'ydb_list_directory', { connection: 'dev', path: '' });
            const parsed = JSON.parse(result);
            expect(parsed).toHaveLength(2);
            expect(parsed.map((e: { name: string }) => e.name)).toEqual(['orders', 'users']);
        });

        it('passes empty string when path is omitted', async () => {
            await manager.addProfile({ name: 'dev', endpoint: 'grpc://localhost:2135', database: '/dev', authType: 'anonymous', secure: false });
            vi.spyOn(manager, 'getDriver').mockResolvedValue({ options: {}, isSecure: false } as never);
            const spy = vi.spyOn(SchemeService.prototype, 'listDirectory').mockResolvedValue([]);

            await invokeTool(manager, 'ydb_list_directory', { connection: 'dev' });
            expect(spy).toHaveBeenCalledWith('');
        });
    });

    // --- ydb_connection_params ---

    describe('ydb_connection_params tool', () => {
        it('returns error when connection is not found', async () => {
            const result = await invokeTool(manager, 'ydb_connection_params', { connection: 'ghost' });
            expect(result).toContain('"ghost" not found');
        });

        it('returns raw params for anonymous connection', async () => {
            await manager.addProfile({ name: 'local', endpoint: 'localhost:2135', database: '/local', authType: 'anonymous', secure: false });
            const result = await invokeTool(manager, 'ydb_connection_params', { connection: 'local' });
            const parsed = JSON.parse(result);
            expect(parsed.raw.endpoint).toBe('grpc://localhost:2135');
            expect(parsed.raw.database).toBe('/local');
            expect(parsed.raw.authType).toBe('anonymous');
            expect(parsed.raw.secure).toBe(false);
        });

        it('returns grpcs scheme for secure connection', async () => {
            await manager.addProfile({ name: 'prod', endpoint: 'ydb.example.com:2135', database: '/prod', authType: 'anonymous', secure: true });
            const result = await invokeTool(manager, 'ydb_connection_params', { connection: 'prod' });
            const parsed = JSON.parse(result);
            expect(parsed.raw.endpoint).toMatch(/^grpcs:\/\//);
        });

        it('includes serviceAccountKeyFile in raw for serviceAccount auth', async () => {
            await manager.addProfile({
                name: 'sa', endpoint: 'ydb.example.com:2135', database: '/db',
                authType: 'serviceAccount', secure: true,
                serviceAccountKeyFile: '/home/user/key.json',
            });
            const result = await invokeTool(manager, 'ydb_connection_params', { connection: 'sa' });
            const parsed = JSON.parse(result);
            expect(parsed.raw.serviceAccountKeyFile).toBe('/home/user/key.json');
        });

        it('includes username but not password for static auth', async () => {
            await manager.addProfile({
                name: 'static', endpoint: 'ydb.example.com:2135', database: '/db',
                authType: 'static', secure: false,
                username: 'alice', password: 'secret',
            });
            const result = await invokeTool(manager, 'ydb_connection_params', { connection: 'static' });
            const parsed = JSON.parse(result);
            expect(parsed.raw.username).toBe('alice');
            expect(JSON.stringify(parsed)).not.toContain('secret');
        });

        it('does not include token value for token auth', async () => {
            await manager.addProfile({
                name: 'tok', endpoint: 'ydb.example.com:2135', database: '/db',
                authType: 'token', secure: true, token: 'super-secret-token',
            });
            const result = await invokeTool(manager, 'ydb_connection_params', { connection: 'tok' });
            expect(result).not.toContain('super-secret-token');
            const parsed = JSON.parse(result);
            expect(parsed.raw.tokenNote).toBeDefined();
        });

        it('builds correct ydb CLI command with sa-key-file', async () => {
            await manager.addProfile({
                name: 'cloud', endpoint: 'lb.example.ydb.mdb.yandexcloud.net:2135', database: '/ru/prod/mydb',
                authType: 'serviceAccount', secure: true,
                serviceAccountKeyFile: '/home/user/key.json',
            });
            const result = await invokeTool(manager, 'ydb_connection_params', { connection: 'cloud' });
            const parsed = JSON.parse(result);
            expect(parsed.ydbCli).toContain('ydb');
            expect(parsed.ydbCli).toContain('-e grpcs://lb.example.ydb.mdb.yandexcloud.net:2135');
            expect(parsed.ydbCli).toContain('-d /ru/prod/mydb');
            expect(parsed.ydbCli).toContain('--sa-key-file /home/user/key.json');
            expect(parsed.ydbCli).toContain('yql -s');
        });

        it('builds correct ydb CLI command for metadata auth', async () => {
            await manager.addProfile({ name: 'vm', endpoint: 'internal:2135', database: '/db', authType: 'metadata', secure: false });
            const result = await invokeTool(manager, 'ydb_connection_params', { connection: 'vm' });
            const parsed = JSON.parse(result);
            expect(parsed.ydbCli).toContain('--use-metadata-credentials');
        });

        it('includes tlsCaCertFile in raw when set', async () => {
            await manager.addProfile({
                name: 'tls', endpoint: 'ydb.example.com:2135', database: '/db',
                authType: 'anonymous', secure: true,
                tlsCaCertFile: '/etc/ssl/custom-ca.pem',
            });
            const result = await invokeTool(manager, 'ydb_connection_params', { connection: 'tls' });
            const parsed = JSON.parse(result);
            expect(parsed.raw.tlsCaCertFile).toBe('/etc/ssl/custom-ca.pem');
        });
    });

    // --- ydb_list_all ---

    describe('ydb_list_all tool', () => {
        it('returns error when connection is not found', async () => {
            const result = await invokeTool(manager, 'ydb_list_all', { connection: 'ghost' });
            expect(result).toContain('Error:');
        });

        it('recursively collects all non-directory entries with string types', async () => {
            await manager.addProfile({ name: 'dev', endpoint: 'grpc://localhost:2135', database: '/dev', authType: 'anonymous', secure: false });
            vi.spyOn(manager, 'getDriver').mockResolvedValue({ options: {}, isSecure: false } as never);
            vi.spyOn(SchemeService.prototype, 'listDirectory').mockImplementation(async (path: string) => {
                if (path === '') {
                    return [
                        { name: 'orders', type: 2 },    // TABLE — leaf
                        { name: 'archive', type: 1 },   // DIRECTORY — recurse
                    ] as never;
                }
                if (path === 'archive') {
                    return [{ name: 'old_orders', type: 2 }] as never;
                }
                return [] as never;
            });

            const result = await invokeTool(manager, 'ydb_list_all', { connection: 'dev' });
            const parsed = JSON.parse(result);
            expect(parsed.total).toBe(2);
            expect(parsed.items.map((e: { path: string }) => e.path)).toEqual(['orders', 'archive/old_orders']);
            expect(parsed.items[0].type).toBe('TABLE');
        });

        it('filters out entries whose names start with "."', async () => {
            await manager.addProfile({ name: 'dev', endpoint: 'grpc://localhost:2135', database: '/dev', authType: 'anonymous', secure: false });
            vi.spyOn(manager, 'getDriver').mockResolvedValue({ options: {}, isSecure: false } as never);
            vi.spyOn(SchemeService.prototype, 'listDirectory').mockResolvedValue([
                { name: '.sys', type: 1 },
                { name: 'orders', type: 2 },
                { name: '.metadata', type: 2 },
            ] as never);

            const result = await invokeTool(manager, 'ydb_list_all', { connection: 'dev' });
            const parsed = JSON.parse(result);
            expect(parsed.total).toBe(1);
            expect(parsed.items[0].path).toBe('orders');
        });

        it('respects limit and offset', async () => {
            await manager.addProfile({ name: 'dev', endpoint: 'grpc://localhost:2135', database: '/dev', authType: 'anonymous', secure: false });
            vi.spyOn(manager, 'getDriver').mockResolvedValue({ options: {}, isSecure: false } as never);
            vi.spyOn(SchemeService.prototype, 'listDirectory').mockResolvedValue([
                { name: 't1', type: 2 },
                { name: 't2', type: 2 },
                { name: 't3', type: 2 },
                { name: 't4', type: 2 },
                { name: 't5', type: 2 },
            ] as never);

            const result = await invokeTool(manager, 'ydb_list_all', { connection: 'dev', limit: 2, offset: 1 });
            const parsed = JSON.parse(result);
            expect(parsed.total).toBe(5);
            expect(parsed.offset).toBe(1);
            expect(parsed.items).toHaveLength(2);
            expect(parsed.items.map((e: { path: string }) => e.path)).toEqual(['t2', 't3']);
        });

        it('returns error text when SchemeService throws', async () => {
            await manager.addProfile({ name: 'dev', endpoint: 'grpc://localhost:2135', database: '/dev', authType: 'anonymous', secure: false });
            vi.spyOn(manager, 'getDriver').mockResolvedValue({ options: {}, isSecure: false } as never);
            vi.spyOn(SchemeService.prototype, 'listDirectory').mockRejectedValue(new Error('permission denied'));

            const result = await invokeTool(manager, 'ydb_list_all', { connection: 'dev' });
            expect(result).toBe('Error: permission denied');
        });
    });
});

// ---------------------------------------------------------------------------
// Test helper: invoke a tool by name without an HTTP round-trip
// ---------------------------------------------------------------------------

type ToolRecord = Record<string, {
    handler: (args: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }>;
}>;

async function invokeTool(manager: ConnectionManager, toolName: string, args: Record<string, unknown>): Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mcpServer: McpServer = (new McpService(manager) as any).createMcpServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = (mcpServer as any)._registeredTools as ToolRecord;
    const tool = tools[toolName];
    if (!tool) {
        throw new Error(`Tool "${toolName}" not registered. Available: ${Object.keys(tools).join(', ')}`);
    }
    const result = await tool.handler(args);
    return result.content[0]?.text ?? '';
}
