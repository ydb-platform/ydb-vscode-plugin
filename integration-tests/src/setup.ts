/**
 * Shared setup for integration tests.
 * Connects to a real YDB instance using environment variables:
 *   YDB_ENDPOINT  — e.g. "grpc://localhost:2136" (default)
 *   YDB_DATABASE  — e.g. "/local" (default)
 *   S3_ENDPOINT   — e.g. "http://localhost:9000" (for external table / S3 tests)
 */
import { Driver } from '@ydbjs/core';
import { AnonymousCredentialsProvider } from '@ydbjs/auth/anonymous';
import { QueryService } from '../../src/services/queryService.js';
import { SchemeService } from '../../src/services/schemeService.js';
import { ConnectionManager } from '../../src/services/connectionManager.js';
import { McpService } from '../../src/services/mcpServer.js';
import { MockMemento } from '../../src/test/helpers/mockMemento.js';

const YDB_ENDPOINT = process.env.YDB_ENDPOINT ?? 'grpc://localhost:2136';
const YDB_DATABASE = process.env.YDB_DATABASE ?? '/local';

export const S3_ENDPOINT = process.env.S3_ENDPOINT ?? 'http://localhost:9000';
export const S3_BUCKET = 'test-bucket';

let driver: Driver;
let queryService: QueryService;
let schemeService: SchemeService;

export function getConnectionString(): string {
    return `${YDB_ENDPOINT}${YDB_DATABASE}`;
}

export function getDatabase(): string {
    return YDB_DATABASE;
}

export async function getDriver(): Promise<Driver> {
    if (!driver) {
        const connectionString = getConnectionString();
        driver = new Driver(connectionString, {
            credentialsProvider: new AnonymousCredentialsProvider(),
        });
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);
        try {
            await driver.ready(controller.signal);
        } finally {
            clearTimeout(timeout);
        }
    }
    return driver;
}

export async function getQueryService(): Promise<QueryService> {
    if (!queryService) {
        queryService = new QueryService(await getDriver());
    }
    return queryService;
}

export async function getSchemeService(): Promise<SchemeService> {
    if (!schemeService) {
        schemeService = new SchemeService(await getDriver());
    }
    return schemeService;
}

export async function executeQuery(sql: string): Promise<import('../../src/models/types.js').QueryResult> {
    const qs = await getQueryService();
    return qs.executeQuery(sql);
}

export async function closeDriver(): Promise<void> {
    if (driver) {
        driver.close();
    }
}

// ---------------------------------------------------------------------------
// MCP helpers
// ---------------------------------------------------------------------------

export const MCP_CONNECTION_NAME = 'integration-test';

let mcpManager: ConnectionManager | undefined;

async function getMcpManager(): Promise<ConnectionManager> {
    if (!mcpManager) {
        mcpManager = ConnectionManager.getInstance();
        mcpManager.initialize(new MockMemento());
        await mcpManager.addProfile({
            name: MCP_CONNECTION_NAME,
            // ConnectionManager.buildConnectionString prepends grpc:// based on secure flag,
            // so strip the scheme from the endpoint env var.
            endpoint: YDB_ENDPOINT.replace(/^grpcs?:\/\//, ''),
            database: YDB_DATABASE,
            authType: 'anonymous',
            secure: YDB_ENDPOINT.startsWith('grpcs://'),
        });
    }
    return mcpManager;
}

type ToolRecord = Record<string, {
    handler: (args: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }>;
}>;

export async function invokeMcpTool(toolName: string, args: Record<string, unknown>): Promise<string> {
    const manager = await getMcpManager();
    const mcpService = new McpService(manager);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mcpServer = (mcpService as any).createMcpServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = (mcpServer as any)._registeredTools as ToolRecord;
    const tool = tools[toolName];
    if (!tool) {
        throw new Error(`Tool "${toolName}" not registered. Available: ${Object.keys(tools).join(', ')}`);
    }
    const result = await tool.handler(args);
    return result.content[0]?.text ?? '';
}

/**
 * Set up MinIO bucket for S3 tests.
 * Uses fetch (Node 18+) to create bucket via MinIO S3 API.
 */
export async function ensureS3Bucket(): Promise<string> {
    const url = `${S3_ENDPOINT}/${S3_BUCKET}`;

    // Check if bucket exists
    const headResp = await fetch(url, { method: 'HEAD' }).catch(() => null);
    if (!headResp || headResp.status === 404) {
        // Create bucket via PUT
        await fetch(url, {
            method: 'PUT',
            headers: {
                'Authorization': `AWS4-HMAC-SHA256 Credential=minioadmin/20000101/us-east-1/s3/aws4_request`,
            },
        });
    }

    // Set public policy
    const policy = JSON.stringify({
        Version: '2012-10-17',
        Statement: [{
            Effect: 'Allow',
            Principal: '*',
            Action: ['s3:GetObject', 's3:ListBucket'],
            Resource: [`arn:aws:s3:::${S3_BUCKET}`, `arn:aws:s3:::${S3_BUCKET}/*`],
        }],
    });

    await fetch(`${S3_ENDPOINT}/${S3_BUCKET}/?policy`, {
        method: 'PUT',
        body: policy,
        headers: { 'Content-Type': 'application/json' },
    }).catch(() => { /* best effort */ });

    return `${S3_ENDPOINT}/${S3_BUCKET}/`;
}
