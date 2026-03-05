import * as http from 'http';
import * as vscode from 'vscode';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { ConnectionManager } from './connectionManager';
import { QueryService } from './queryService';
import { SchemeService } from './schemeService';
import { SchemeEntryType } from '../models/types';
import { RagService, queryYdbVersion } from './ragService';
import type { Driver } from '@ydbjs/core';

/**
 * Embedded MCP server that exposes YDB connections configured in the plugin
 * to AI tools (Claude Code, etc.) via HTTP SSE transport.
 *
 * Each tool requires an explicit `connection` parameter (the profile name from
 * the Connections panel). The server does not follow the focused connection —
 * every call is unambiguous about which database it targets.
 *
 * Usage (after starting extension):
 *   claude mcp add --transport sse ydb http://localhost:3333/sse
 */
export class McpService implements vscode.Disposable {
    private httpServer: http.Server | undefined;
    /** Map from sessionId → SSEServerTransport (one per active SSE connection) */
    private transports = new Map<string, SSEServerTransport>();
    /** Cache of detected YDB versions per profile name to avoid repeated queries */
    private versionCache = new Map<string, string>();

    constructor(
        private readonly connectionManager: ConnectionManager,
        private readonly ragService?: RagService,
    ) {}

    /**
     * Looks up a connection profile by name and returns its Driver.
     * Throws with a descriptive message when the name is not found.
     */
    private async getDriverByName(connectionName: string): Promise<Driver> {
        const profiles = this.connectionManager.getProfiles();
        const profile = profiles.find(p => p.name === connectionName);
        if (!profile) {
            const available = profiles.map(p => `"${p.name}"`).join(', ');
            const hint = available ? `Available connections: ${available}` : 'No connections configured yet.';
            throw new Error(`Connection "${connectionName}" not found. ${hint}`);
        }
        return this.connectionManager.getDriver(profile.id);
    }

    /** Creates and registers all YDB tools on a new McpServer instance. */
    private createMcpServer(): McpServer {
        const server = new McpServer({
            name: 'ydb-vscode',
            version: '1.0.0',
        });

        const connectionParam = z.string().describe(
            'Connection name as shown in the YDB Connections panel (use ydb_list_connections to see available names)',
        );

        // Tool: ydb_list_connections — lists all configured connections
        server.tool(
            'ydb_list_connections',
            'Lists all YDB connections configured in the VS Code plugin',
            async () => {
                const profiles = this.connectionManager.getProfiles();
                if (profiles.length === 0) {
                    return {
                        content: [{ type: 'text' as const, text: 'No connections configured. Add a connection in the YDB panel.' }],
                    };
                }
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify(
                            profiles.map(p => ({
                                name: p.name,
                                endpoint: p.endpoint,
                                database: p.database,
                                connected: this.connectionManager.isConnected(p.id),
                                authType: p.authType,
                            })),
                            null,
                            2,
                        ),
                    }],
                };
            },
        );

        // Tool: ydb_query — executes a YQL query on the specified connection
        server.tool(
            'ydb_query',
            'Executes a YQL query against the specified YDB connection and returns results as JSON',
            {
                connection: connectionParam,
                sql: z.string().describe('YQL query to execute'),
            },
            async ({ connection, sql }) => {
                try {
                    const driver = await this.getDriverByName(connection);
                    const queryService = new QueryService(driver);
                    const result = await queryService.executeQuery(sql);
                    return {
                        content: [{
                            type: 'text' as const,
                            text: JSON.stringify({
                                columns: result.columns,
                                rows: result.rows,
                                truncated: result.truncated,
                            }, null, 2),
                        }],
                    };
                } catch (err) {
                    return {
                        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
                    };
                }
            },
        );

        // Tool: ydb_describe_table — returns schema of a table
        server.tool(
            'ydb_describe_table',
            'Describes a YDB table schema: columns with types and primary keys',
            {
                connection: connectionParam,
                path: z.string().describe('Full path to the table (e.g. /Root/mydb/my_table)'),
            },
            async ({ connection, path }) => {
                try {
                    const driver = await this.getDriverByName(connection);
                    const queryService = new QueryService(driver);
                    const desc = await queryService.describeTable(path);
                    return {
                        content: [{
                            type: 'text' as const,
                            text: JSON.stringify({
                                columns: desc.columns,
                                primaryKeys: desc.primaryKeys,
                                partitionBy: desc.partitionBy,
                                isColumnTable: desc.isColumnTable,
                            }, null, 2),
                        }],
                    };
                } catch (err) {
                    return {
                        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
                    };
                }
            },
        );

        // Tool: ydb_list_directory — lists entries in a database directory
        server.tool(
            'ydb_list_directory',
            'Lists entries (tables, folders, topics, etc.) in a YDB directory path',
            {
                connection: connectionParam,
                path: z.string().optional().describe('Directory path relative to the database root. Omit to list the root.'),
            },
            async ({ connection, path }) => {
                try {
                    const driver = await this.getDriverByName(connection);
                    const schemeService = new SchemeService(driver);
                    const entries = await schemeService.listDirectory(path ?? '');
                    return {
                        content: [{
                            type: 'text' as const,
                            text: JSON.stringify(
                                entries
                                    .filter(e => !e.name.startsWith('.'))
                                    .map(e => ({ name: e.name, type: SchemeEntryType[e.type] ?? e.type })),
                                null,
                                2,
                            ),
                        }],
                    };
                } catch (err) {
                    return {
                        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
                    };
                }
            },
        );

        // Tool: ydb_list_all — recursive listing of all non-system objects
        server.tool(
            'ydb_list_all',
            'Recursively lists all objects (tables, views, topics, etc.) in a YDB database. ' +
            'Skips system entries (names starting with "."). Use limit/offset for pagination.',
            {
                connection: connectionParam,
                path: z.string().optional().describe('Start path (relative to database root). Omit to start from the root.'),
                limit: z.number().optional().describe('Maximum number of entries to return (default: 1000)'),
                offset: z.number().optional().describe('Number of entries to skip (default: 0)'),
            },
            async ({ connection, path, limit, offset }) => {
                try {
                    const driver = await this.getDriverByName(connection);
                    const schemeService = new SchemeService(driver);
                    const results: Array<{ path: string; type: string | number }> = [];
                    const queue: string[] = [path ?? ''];

                    while (queue.length > 0) {
                        const current = queue.shift() as string; // safe: length > 0 checked
                        const entries = await schemeService.listDirectory(current);
                        for (const entry of entries) {
                            if (entry.name.startsWith('.')) { continue; }
                            const entryPath = current ? `${current}/${entry.name}` : entry.name;
                            if (entry.type === SchemeEntryType.DIRECTORY) {
                                queue.push(entryPath);
                            } else {
                                results.push({ path: entryPath, type: SchemeEntryType[entry.type] ?? entry.type });
                            }
                        }
                    }

                    const start = offset ?? 0;
                    const end = start + (limit ?? 1000);
                    const page = results.slice(start, end);

                    return {
                        content: [{
                            type: 'text' as const,
                            text: JSON.stringify({
                                total: results.length,
                                offset: start,
                                items: page,
                            }, null, 2),
                        }],
                    };
                } catch (err) {
                    return {
                        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
                    };
                }
            },
        );

        // Tool: ydb_yql_help — searches YQL documentation RAG index
        server.tool(
            'ydb_yql_help',
            'Searches the YQL documentation index and returns relevant syntax reference for writing YDB queries. ' +
            'Call this before writing complex YQL to get accurate syntax guidance.',
            {
                query: z.string().describe('Natural language question or keyword about YQL syntax (e.g. "JOIN syntax", "window functions", "UPSERT")'),
                connection: connectionParam.optional().describe(
                    'Connection name to select the version-appropriate RAG. Omit to use any available index.',
                ),
            },
            async ({ query, connection }) => {
                if (!this.ragService) {
                    return {
                        content: [{ type: 'text' as const, text: 'RAG service not initialized. Download a RAG index via the connection form.' }],
                    };
                }
                if (!this.ragService.isEnabled) {
                    return {
                        content: [{ type: 'text' as const, text: 'RAG is disabled. Enable "Use RAG" in the connection settings.' }],
                    };
                }

                try {
                    // Find the RAG file to use
                    let ragFilePath: string | undefined;

                    if (connection) {
                        // Try to get version-specific RAG for this connection
                        let version = this.versionCache.get(connection);
                        if (!version) {
                            try {
                                const driver = await this.getDriverByName(connection);
                                const detected = await queryYdbVersion(driver);
                                if (detected) {
                                    version = detected;
                                    this.versionCache.set(connection, detected);
                                }
                            } catch {
                                // Driver unavailable — fall through
                            }
                        }
                        if (version && this.ragService.isCached(version)) {
                            ragFilePath = this.ragService.getCacheFilePath(version);
                        }
                    }

                    // Fallback: use any cached file
                    if (!ragFilePath) {
                        ragFilePath = this.ragService.findAnyCachedFile();
                    }

                    if (!ragFilePath) {
                        return {
                            content: [{
                                type: 'text' as const,
                                text: 'No YQL RAG index found. Open a connection in VS Code and click "Detect & Download RAG" in the connection form.',
                            }],
                        };
                    }

                    const ollamaUrl = vscode.workspace.getConfiguration('ydb').get<string>('ragOllamaUrl', '');
                    const ollamaModel = vscode.workspace.getConfiguration('ydb').get<string>('ragOllamaModel', 'nomic-embed-text');

                    const { results, method } = await this.ragService.search(
                        query,
                        ragFilePath,
                        3,
                        ollamaUrl || undefined,
                        ollamaModel,
                    );

                    if (results.length === 0) {
                        return { content: [{ type: 'text' as const, text: `No relevant YQL documentation found for: "${query}"` }] };
                    }

                    const searchNote = method === 'vector'
                        ? `[Search method: Ollama vector search (${ollamaModel})]`
                        : `[Search method: keyword search${ollamaUrl ? ' (Ollama unavailable, fell back to keyword)' : ''}]`;

                    return {
                        content: [{
                            type: 'text' as const,
                            text: `${searchNote}\n\n${results.join('\n\n---\n\n')}`,
                        }],
                    };
                } catch (err) {
                    return {
                        content: [{ type: 'text' as const, text: `RAG search error: ${err instanceof Error ? err.message : String(err)}` }],
                    };
                }
            },
        );

        return server;
    }

    async start(port: number): Promise<void> {
        return new Promise((resolve, reject) => {
            const server = http.createServer((req, res) => {
                this.handleRequest(req, res).catch(err => {
                    if (!res.headersSent) {
                        res.writeHead(500).end(String(err));
                    }
                });
            });

            server.on('error', (err: NodeJS.ErrnoException) => {
                if (err.code === 'EADDRINUSE') {
                    vscode.window.showWarningMessage(
                        `YDB MCP server: port ${port} is already in use. MCP features will be unavailable. Change the port via the ydb.mcpPort setting.`,
                    );
                    resolve(); // extension continues without MCP
                } else {
                    reject(err);
                }
            });

            server.listen(port, '127.0.0.1', () => {
                this.httpServer = server;
                resolve();
            });
        });
    }

    private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const url = req.url ?? '/';

        if (req.method === 'GET' && url === '/sse') {
            const mcpServer = this.createMcpServer();
            const transport = new SSEServerTransport('/message', res);
            this.transports.set(transport.sessionId, transport);
            transport.onclose = () => {
                this.transports.delete(transport.sessionId);
            };
            await mcpServer.connect(transport);
            return;
        }

        if (req.method === 'POST' && url.startsWith('/message')) {
            const sessionId = new URL(url, 'http://localhost').searchParams.get('sessionId');
            const transport = sessionId ? this.transports.get(sessionId) : undefined;
            if (!transport) {
                res.writeHead(404).end('Session not found');
                return;
            }
            await transport.handlePostMessage(req, res);
            return;
        }

        res.writeHead(404).end('Not found');
    }

    dispose(): void {
        if (this.httpServer) {
            for (const transport of this.transports.values()) {
                transport.close().catch(() => {});
            }
            this.transports.clear();
            this.httpServer.close();
            this.httpServer = undefined;
        }
    }
}
