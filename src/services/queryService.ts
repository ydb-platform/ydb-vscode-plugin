import * as vscode from 'vscode';
import * as grpc from '@grpc/grpc-js';
import * as tls from 'tls';
import * as http from 'http';
import * as https from 'https';
import { Driver } from '@ydbjs/core';
import { QueryServiceDefinition, ExecMode, Syntax, StatsMode } from '@ydbjs/api/query';
import type { ExecuteQueryResponsePart } from '@ydbjs/api/query';
import { TableServiceDefinition, DescribeTableResultSchema } from '@ydbjs/api/table';
import type { DescribeTableResult } from '@ydbjs/api/table';
import { StatusIds_StatusCode } from '@ydbjs/api/operation';
import type { Type, TypedValue } from '@ydbjs/api/value';
import { anyUnpack } from '@bufbuild/protobuf/wkt';
import { QueryResult, ColumnInfo, ExplainResult, QueryStatistics, StreamingQuery, TableDescription, ExternalDataSourceDescription, ExternalTableDescription, TransferDescription, ResourcePool } from '../models/types.js';
import { formatType } from '../utils/typeFormatter.js';
import { extractValue } from '../utils/valueExtractor.js';
import { parsePlanRoot } from '../utils/planParser.js';
import { encodeVarint, readProtobufField, readAllProtobufFields, readProtobufVarint, readProtobufString } from '../utils/protobufReader.js';

export class CancellationError extends Error {
    constructor() {
        super('Operation cancelled');
        this.name = 'CancellationError';
    }
}

const VIEW_SERVICE_PATH = '/Ydb.View.V1.ViewService';
const TABLE_SERVICE_PATH = '/Ydb.Table.V1.TableService';
const REPLICATION_SERVICE_PATH = '/Ydb.Replication.V1.ReplicationService';

const PLAN2SVG_TIMEOUT_MS = 30_000;

interface YdbIssue {
    message?: string;
    issues?: YdbIssue[];
}

export function flattenIssues(issues: YdbIssue[]): string {
    const messages: string[] = [];
    function collect(list: YdbIssue[]) {
        for (const issue of list) {
            if (issue.message) {
                messages.push(issue.message);
            }
            if (issue.issues?.length) {
                collect(issue.issues);
            }
        }
    }
    collect(issues);
    return messages.join('; ');
}

export function fetchPlanSvg(monitoringUrl: string, planJson: string, database: string, authToken?: string): Promise<string> {
    const base = monitoringUrl.endsWith('/') ? monitoringUrl : monitoringUrl + '/';
    const url = new URL('viewer/plan2svg', base);
    if (database) {
        url.searchParams.set('database', database);
    }
    const transport = url.protocol === 'https:' ? https : http;

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'image/svg+xml',
    };
    if (authToken) {
        headers['Authorization'] = authToken;
    }

    return new Promise<string>((resolve, reject) => {
        const req = transport.request(url, {
            method: 'POST',
            headers,
            timeout: PLAN2SVG_TIMEOUT_MS,
        }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf-8');
                if (res.statusCode !== 200) {
                    reject(new Error(`plan2svg returned HTTP ${res.statusCode}: ${body}`));
                } else {
                    resolve(body);
                }
            });
        });

        req.on('error', (err) => reject(new Error(`plan2svg request failed: ${err.message}`)));
        req.on('timeout', () => { req.destroy(); reject(new Error('plan2svg request timed out')); });
        req.write(planJson);
        req.end();
    });
}

export class QueryService {
    private driver: Driver;
    private rawGrpcCredentials: grpc.ChannelCredentials;

    constructor(driver: Driver) {
        this.driver = driver;
        // Build gRPC credentials once, reusing the same CA bundle as the Driver
        const secureOptions = driver.options.secureOptions;
        if (!driver.isSecure) {
            this.rawGrpcCredentials = grpc.credentials.createInsecure();
        } else if (secureOptions) {
            const secureContext = tls.createSecureContext(secureOptions);
            this.rawGrpcCredentials = grpc.credentials.createFromSecureContext(secureContext);
        } else {
            this.rawGrpcCredentials = grpc.credentials.createSsl();
        }
    }

    async executeQuery(
        queryText: string,
        token?: vscode.CancellationToken,
        parameters?: Record<string, TypedValue>,
    ): Promise<QueryResult> {
        return this.withSession(async (queryClient, sessionId) => {
            const parts = await this.streamExecuteQuery(queryClient, sessionId, {
                execMode: ExecMode.EXECUTE,
                queryContent: { syntax: Syntax.YQL_V1, text: queryText },
                txControl: {
                    commitTx: true,
                    txSelector: {
                        case: 'beginTx',
                        value: { txMode: { case: 'serializableReadWrite', value: {} } },
                    },
                },
                parameters,
            }, undefined, token);
            return this.parseResponseParts(parts);
        }, token);
    }

    async executeWithStats(queryText: string, token?: vscode.CancellationToken): Promise<{ result: QueryResult; stats: QueryStatistics }> {
        return this.withSession(async (queryClient, sessionId) => {
            const parts = await this.streamExecuteQuery(queryClient, sessionId, {
                execMode: ExecMode.EXECUTE,
                queryContent: { syntax: Syntax.YQL_V1, text: queryText },
                txControl: {
                    commitTx: true,
                    txSelector: {
                        case: 'beginTx',
                        value: { txMode: { case: 'serializableReadWrite', value: {} } },
                    },
                },
                statsMode: StatsMode.PROFILE,
            }, undefined, token);
            const result = this.parseResponseParts(parts);
            const execStats = parts.find(p => p.execStats)?.execStats;
            const stats: QueryStatistics = {
                totalDurationUs: execStats ? Number(execStats.totalDurationUs ?? 0) : 0,
                totalCpuTimeUs: execStats ? Number(execStats.totalCpuTimeUs ?? 0) : 0,
                planJson: execStats?.queryPlan ?? '',
            };
            return { result, stats };
        }, token);
    }

    async executePagedQuery(queryText: string, limit: number, offset: number, token?: vscode.CancellationToken): Promise<QueryResult> {
        const maxRows = offset + limit;
        return this.withSession(async (queryClient, sessionId) => {
            const parts = await this.streamExecuteQuery(queryClient, sessionId, {
                execMode: ExecMode.EXECUTE,
                queryContent: { syntax: Syntax.YQL_V1, text: queryText },
                txControl: {
                    commitTx: true,
                    txSelector: {
                        case: 'beginTx',
                        value: { txMode: { case: 'serializableReadWrite', value: {} } },
                    },
                },
            }, maxRows, token);
            const result = this.parseResponseParts(parts);
            return {
                columns: result.columns,
                rows: result.rows.slice(offset, offset + limit),
                truncated: result.truncated || result.rows.length > offset + limit,
            };
        }, token);
    }

    async executeScanQuery(queryText: string, token?: vscode.CancellationToken): Promise<QueryResult> {
        return this.executeQuery(queryText, token);
    }

    async loadStreamingQueries(database: string): Promise<StreamingQuery[]> {
        try {
            const result = await this.executeQuery('SELECT * FROM `.sys/streaming_queries`');
            return result.rows.map(row => {
                const path = String(row['Path'] ?? row['path'] ?? '');
                const dbPrefix = database.endsWith('/') ? database : database + '/';
                const relativePath = path.startsWith(dbPrefix) ? path.slice(dbPrefix.length) : path;

                return {
                    name: relativePath.split('/').pop() ?? relativePath,
                    fullPath: relativePath,
                    status: String(row['Status'] ?? row['status'] ?? 'UNKNOWN'),
                    queryText: String(row['QueryText'] ?? row['query_text'] ?? ''),
                    resourcePool: row['ResourcePool'] ?? row['resource_pool'] ? String(row['ResourcePool'] ?? row['resource_pool']) : undefined,
                    retryCount: row['RetryCount'] ?? row['retry_count'] ? Number(row['RetryCount'] ?? row['retry_count']) : undefined,
                    lastFailAt: row['LastFailAt'] ?? row['last_fail_at'] ? String(row['LastFailAt'] ?? row['last_fail_at']) : undefined,
                    suspendedUntil: row['SuspendedUntil'] ?? row['suspended_until'] ? String(row['SuspendedUntil'] ?? row['suspended_until']) : undefined,
                    plan: row['Plan'] ?? row['plan'] ? String(row['Plan'] ?? row['plan']) : undefined,
                    ast: row['Ast'] ?? row['ast'] ? String(row['Ast'] ?? row['ast']) : undefined,
                    issues: row['Issues'] ?? row['issues'] ? String(row['Issues'] ?? row['issues']) : undefined,
                };
            });
        } catch {
            return [];
        }
    }

    async loadResourcePoolByName(name: string): Promise<ResourcePool | undefined> {
        const pools = await this.loadResourcePools();
        return pools.find(p => p.name === name);
    }

    async loadResourcePools(): Promise<ResourcePool[]> {
        try {
            const result = await this.executeQuery('SELECT * FROM `.sys/resource_pools`');
            return result.rows.map(row => ({
                name: String(row['Name'] ?? row['name'] ?? ''),
                concurrentQueryLimit: Number(row['ConcurrentQueryLimit'] ?? row['concurrent_query_limit'] ?? -1),
                queueSize: Number(row['QueueSize'] ?? row['queue_size'] ?? -1),
                databaseLoadCpuThreshold: Number(row['DatabaseLoadCpuThreshold'] ?? row['database_load_cpu_threshold'] ?? -1),
                resourceWeight: Number(row['ResourceWeight'] ?? row['resource_weight'] ?? -1),
                totalCpuLimitPercentPerNode: Number(row['TotalCpuLimitPercentPerNode'] ?? row['total_cpu_limit_percent_per_node'] ?? -1),
                queryCpuLimitPercentPerNode: Number(row['QueryCpuLimitPercentPerNode'] ?? row['query_cpu_limit_percent_per_node'] ?? -1),
                queryMemoryLimitPercentPerNode: Number(row['QueryMemoryLimitPercentPerNode'] ?? row['query_memory_limit_percent_per_node'] ?? -1),
            }));
        } catch {
            return [];
        }
    }

    async explainQuery(queryText: string, token?: vscode.CancellationToken): Promise<ExplainResult> {
        return this.withSession(async (queryClient, sessionId) => {
            const parts = await this.streamExecuteQuery(queryClient, sessionId, {
                execMode: ExecMode.EXPLAIN,
                queryContent: { syntax: Syntax.YQL_V1, text: queryText },
            }, undefined, token);
            const execStats = parts.find(p => p.execStats)?.execStats;
            const planStr = execStats?.queryPlan ?? '';
            if (planStr) {
                try {
                    const parsed = JSON.parse(planStr);
                    return { plan: parsePlanRoot(parsed), rawJson: planStr };
                } catch {
                    return { plan: { name: 'Plan', properties: { raw: planStr }, children: [] }, rawJson: planStr };
                }
            }
            return { plan: { name: 'Empty Plan', properties: {}, children: [] } };
        }, token);
    }

    async describeTable(tablePath: string, isColumnTable = false): Promise<TableDescription> {
        const tableClient = this.driver.createClient(TableServiceDefinition);

        // DescribeTable requires a Table API session
        const createResp = await tableClient.createSession({});
        const createOp = createResp.operation;
        if (!createOp || (createOp.status !== StatusIds_StatusCode.SUCCESS && createOp.status !== StatusIds_StatusCode.STATUS_CODE_UNSPECIFIED)) {
            const issues = (createOp?.issues ?? []).map((i: { message?: string }) => i.message).join('; ');
            throw new Error(`Table CreateSession failed: ${issues || 'unknown error'}`);
        }

        // Unpack CreateSessionResult to get sessionId
        const createResultBytes = createOp.result;
        if (!createResultBytes) {
            throw new Error('Table CreateSession returned empty result');
        }
        // CreateSessionResult has sessionId field - extract from Any
        const { CreateSessionResultSchema } = await import('@ydbjs/api/table');
        const createResult = anyUnpack(createResultBytes, CreateSessionResultSchema) as { sessionId?: string } | undefined;
        if (!createResult?.sessionId) {
            throw new Error('Table CreateSession returned empty sessionId');
        }
        const sessionId = createResult.sessionId;

        try {
            const response = await tableClient.describeTable({
                sessionId,
                path: tablePath,
            });

            const op = response.operation;
            if (!op || (op.status !== StatusIds_StatusCode.SUCCESS && op.status !== StatusIds_StatusCode.STATUS_CODE_UNSPECIFIED)) {
                const issues = (op?.issues ?? []).map((i: { message?: string }) => i.message).join('; ');
                throw new Error(`DescribeTable failed: ${issues || 'unknown error'}`);
            }

            const resultAny = op.result;
            if (!resultAny) {
                throw new Error('DescribeTable returned empty result');
            }
            const result = anyUnpack(resultAny, DescribeTableResultSchema) as DescribeTableResult | undefined;
            if (!result) {
                throw new Error('DescribeTable: failed to unpack result');
            }

            return {
                columns: (result.columns ?? []).map((c: { name?: string; type?: Type }) => {
                    const isOptional = c.type?.type?.case === 'optionalType';
                    const displayType = isOptional && c.type?.type?.value
                        ? formatType((c.type.type.value as { item?: Type }).item ?? null)
                        : c.type ? formatType(c.type) : 'Unknown';
                    return {
                        name: c.name ?? '',
                        type: displayType,
                        notNull: !isOptional,
                    };
                }),
                primaryKeys: (result.primaryKey ?? []) as string[],
                partitionBy: (result.partitioningSettings?.partitionBy ?? []) as string[],
                isColumnTable,
            };
        } finally {
            await tableClient.deleteSession({ sessionId }).catch(() => {});
        }
    }

    async describeView(viewPath: string): Promise<string> {
        // View service may not have typed clients in @ydbjs/api, use raw gRPC
        const client = this.createRawGrpcClient();
        try {
            const metadata = await this.getRawMetadata();

            // Manually encode DescribeViewRequest: field 2 (path) = viewPath
            const pathBytes = Buffer.from(viewPath, 'utf-8');
            const tagByte = 0x12; // field 2, wire type 2
            const varintBytes = encodeVarint(pathBytes.length);
            const requestBuffer = Buffer.concat([
                Buffer.from([tagByte]),
                varintBytes,
                pathBytes,
            ]);

            const responseBuffer = await new Promise<Buffer>((resolve, reject) => {
                client.makeUnaryRequest(
                    `${VIEW_SERVICE_PATH}/DescribeView`,
                    (arg: Buffer) => arg,
                    (buf: Buffer) => buf,
                    requestBuffer,
                    metadata,
                    (err, resp) => {
                        if (err) {reject(err);}
                        else if (!resp) {reject(new Error('Empty DescribeView response'));}
                        else {resolve(Buffer.from(resp));}
                    },
                );
            });

            const operation = readProtobufField(responseBuffer, 1);
            if (!operation) {
                throw new Error('DescribeView: no operation in response');
            }

            const statusField = readProtobufVarint(operation, 3);
            if (statusField !== undefined && statusField !== 0 && statusField !== 400000) {
                const issuesBytes = readProtobufField(operation, 4);
                const issueText = issuesBytes ? readProtobufString(issuesBytes, 1) : undefined;
                throw new Error(`DescribeView failed: ${issueText || 'status ' + statusField}`);
            }

            const anyField = readProtobufField(operation, 5);
            if (!anyField) {
                throw new Error('DescribeView: no result in operation');
            }

            const resultBytes = readProtobufField(anyField, 2);
            if (!resultBytes) {
                throw new Error('DescribeView: no value in Any');
            }

            const queryText = readProtobufString(resultBytes, 2);
            if (!queryText) {
                throw new Error('DescribeView: no query_text in result');
            }

            return queryText;
        } finally {
            client.close();
        }
    }

    async describeExternalDataSource(path: string): Promise<ExternalDataSourceDescription> {
        const client = this.createRawGrpcClient();
        try {
            const metadata = await this.getRawMetadata();

            const pathBytes = Buffer.from(path, 'utf-8');
            const tagByte = 0x12;
            const varintBytes = encodeVarint(pathBytes.length);
            const requestBuffer = Buffer.concat([
                Buffer.from([tagByte]),
                varintBytes,
                pathBytes,
            ]);

            const responseBuffer = await new Promise<Buffer>((resolve, reject) => {
                client.makeUnaryRequest(
                    `${TABLE_SERVICE_PATH}/DescribeExternalDataSource`,
                    (arg: Buffer) => arg,
                    (buf: Buffer) => buf,
                    requestBuffer,
                    metadata,
                    (err, resp) => {
                        if (err) {reject(err);}
                        else if (!resp) {reject(new Error('Empty DescribeExternalDataSource response'));}
                        else {resolve(Buffer.from(resp));}
                    },
                );
            });

            const operation = readProtobufField(responseBuffer, 1);
            if (!operation) {
                throw new Error('DescribeExternalDataSource: no operation in response');
            }

            const statusField = readProtobufVarint(operation, 3);
            if (statusField !== undefined && statusField !== 0 && statusField !== 400000) {
                const issuesBytes = readProtobufField(operation, 4);
                const issueText = issuesBytes ? readProtobufString(issuesBytes, 1) : undefined;
                throw new Error(`DescribeExternalDataSource failed: ${issueText || 'status ' + statusField}`);
            }

            const anyField = readProtobufField(operation, 5);
            if (!anyField) {
                throw new Error('DescribeExternalDataSource: no result in operation');
            }
            const resultBytes = readProtobufField(anyField, 2);
            if (!resultBytes) {
                throw new Error('DescribeExternalDataSource: no value in Any');
            }

            const sourceType = readProtobufString(resultBytes, 2);
            const location = readProtobufString(resultBytes, 3);

            const properties: Record<string, string> = {};
            const mapEntries = readAllProtobufFields(resultBytes, 4);
            for (const entry of mapEntries) {
                const key = readProtobufString(entry, 1);
                const value = readProtobufString(entry, 2);
                if (key) {
                    properties[key] = value ?? '';
                }
            }

            return {
                sourceType: sourceType ?? undefined,
                location: location ?? undefined,
                properties,
            };
        } finally {
            client.close();
        }
    }

    async describeExternalTable(path: string): Promise<ExternalTableDescription> {
        const client = this.createRawGrpcClient();
        try {
            const metadata = await this.getRawMetadata();

            const pathBytes = Buffer.from(path, 'utf-8');
            const tagByte = 0x12;
            const varintBytes = encodeVarint(pathBytes.length);
            const requestBuffer = Buffer.concat([
                Buffer.from([tagByte]),
                varintBytes,
                pathBytes,
            ]);

            const responseBuffer = await new Promise<Buffer>((resolve, reject) => {
                client.makeUnaryRequest(
                    `${TABLE_SERVICE_PATH}/DescribeExternalTable`,
                    (arg: Buffer) => arg,
                    (buf: Buffer) => buf,
                    requestBuffer,
                    metadata,
                    (err, resp) => {
                        if (err) {reject(err);}
                        else if (!resp) {reject(new Error('Empty DescribeExternalTable response'));}
                        else {resolve(Buffer.from(resp));}
                    },
                );
            });

            const operation = readProtobufField(responseBuffer, 1);
            if (!operation) {
                throw new Error('DescribeExternalTable: no operation in response');
            }

            const statusField = readProtobufVarint(operation, 3);
            if (statusField !== undefined && statusField !== 0 && statusField !== 400000) {
                const issuesBytes = readProtobufField(operation, 4);
                const issueText = issuesBytes ? readProtobufString(issuesBytes, 1) : undefined;
                throw new Error(`DescribeExternalTable failed: ${issueText || 'status ' + statusField}`);
            }

            const anyField = readProtobufField(operation, 5);
            if (!anyField) {
                throw new Error('DescribeExternalTable: no result in operation');
            }
            const resultBytes = readProtobufField(anyField, 2);
            if (!resultBytes) {
                throw new Error('DescribeExternalTable: no value in Any');
            }

            const sourceType = readProtobufString(resultBytes, 2);
            const dataSourcePath = readProtobufString(resultBytes, 3);
            const location = readProtobufString(resultBytes, 4);

            // Parse content map (field 6) for FORMAT, COMPRESSION, etc.
            const contentEntries = readAllProtobufFields(resultBytes, 6);
            const contentMap: Record<string, string> = {};
            for (const entry of contentEntries) {
                const key = readProtobufString(entry, 1);
                const value = readProtobufString(entry, 2);
                if (key) {
                    contentMap[key] = value ?? '';
                }
            }

            const columnEntries = readAllProtobufFields(resultBytes, 5);
            const columns: { name: string; type: string; notNull: boolean }[] = [];
            for (const entry of columnEntries) {
                const name = readProtobufString(entry, 1) ?? '';
                const typeBytes = readProtobufField(entry, 2);
                let type = 'Unknown';
                let notNull = true;
                if (typeBytes) {
                    try {
                        const { fromBinary } = await import('@bufbuild/protobuf');
                        const { TypeSchema } = await import('@ydbjs/api/value');
                        const ydbType = fromBinary(TypeSchema, typeBytes) as Type;
                        const isOptional = ydbType?.type?.case === 'optionalType';
                        if (isOptional && ydbType.type.value) {
                            type = formatType((ydbType.type.value as { item?: Type }).item ?? null);
                            notNull = false;
                        } else {
                            type = formatType(ydbType);
                        }
                    } catch {
                        type = 'Unknown';
                    }
                }
                columns.push({ name, type, notNull });
            }

            const unwrapJsonArray = (val: string | undefined): string | undefined => {
                if (!val) {return undefined;}
                const trimmed = val.trim();
                if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
                    const inner = trimmed.slice(1, -1).trim();
                    if (inner.startsWith('"') && inner.endsWith('"') && inner.length >= 2) {
                        return inner.slice(1, -1);
                    }
                    return inner || undefined;
                }
                return val;
            };

            return {
                sourceType: sourceType ?? undefined,
                dataSourcePath: dataSourcePath ?? undefined,
                location: location ?? undefined,
                columns,
                format: unwrapJsonArray(contentMap['FORMAT'] ?? contentMap['format']),
                compression: unwrapJsonArray(contentMap['COMPRESSION'] ?? contentMap['compression']),
            };
        } finally {
            client.close();
        }
    }

    async describeTransfer(path: string): Promise<TransferDescription> {
        const client = this.createRawGrpcClient();
        try {
            const metadata = await this.getRawMetadata();

            const pathBytes = Buffer.from(path, 'utf-8');
            const tagByte = 0x12; // field 2, wire type 2
            const varintBytes = encodeVarint(pathBytes.length);
            const requestBuffer = Buffer.concat([
                Buffer.from([tagByte]),
                varintBytes,
                pathBytes,
            ]);

            const responseBuffer = await new Promise<Buffer>((resolve, reject) => {
                client.makeUnaryRequest(
                    `${REPLICATION_SERVICE_PATH}/DescribeTransfer`,
                    (arg: Buffer) => arg,
                    (buf: Buffer) => buf,
                    requestBuffer,
                    metadata,
                    (err, resp) => {
                        if (err) {reject(err);}
                        else if (!resp) {reject(new Error('Empty DescribeTransfer response'));}
                        else {resolve(Buffer.from(resp));}
                    },
                );
            });

            const operation = readProtobufField(responseBuffer, 1);
            if (!operation) {
                throw new Error('DescribeTransfer: no operation in response');
            }

            const statusField = readProtobufVarint(operation, 3);
            if (statusField !== undefined && statusField !== 0 && statusField !== 400000) {
                const issuesBytes = readProtobufField(operation, 4);
                const issueText = issuesBytes ? readProtobufString(issuesBytes, 1) : undefined;
                throw new Error(`DescribeTransfer failed: ${issueText || 'status ' + statusField}`);
            }

            const anyField = readProtobufField(operation, 5);
            if (!anyField) {
                throw new Error('DescribeTransfer: no result in operation');
            }
            const resultBytes = readProtobufField(anyField, 2);
            if (!resultBytes) {
                throw new Error('DescribeTransfer: no value in Any');
            }

            // Determine state from oneof fields 3-6
            // These are sub-messages (wire type 2), not varints — check both wire types
            let state = 'Unknown';
            if (readProtobufField(resultBytes, 3) !== undefined || readProtobufVarint(resultBytes, 3) !== undefined) {
                state = 'Running';
            } else if (readProtobufField(resultBytes, 4) !== undefined || readProtobufVarint(resultBytes, 4) !== undefined) {
                state = 'Error';
            } else if (readProtobufField(resultBytes, 5) !== undefined || readProtobufVarint(resultBytes, 5) !== undefined) {
                state = 'Done';
            } else if (readProtobufField(resultBytes, 6) !== undefined || readProtobufVarint(resultBytes, 6) !== undefined) {
                state = 'Paused';
            }

            const sourcePath = readProtobufString(resultBytes, 7);
            const destinationPath = readProtobufString(resultBytes, 8);
            const transformationLambda = readProtobufString(resultBytes, 9);
            const consumerName = readProtobufString(resultBytes, 10);

            // connection_string is inside sub-message at field 2, sub-field 6
            let connectionString: string | undefined;
            const sourceConfigBytes = readProtobufField(resultBytes, 2);
            if (sourceConfigBytes) {
                const cs = readProtobufString(sourceConfigBytes, 6);
                if (cs) {
                    connectionString = cs;
                }
            }

            return {
                state,
                sourcePath: sourcePath ?? undefined,
                destinationPath: destinationPath ?? undefined,
                transformationLambda: transformationLambda ?? undefined,
                consumerName: consumerName ?? undefined,
                connectionString: connectionString ?? undefined,
            };
        } finally {
            client.close();
        }
    }


    private createRawGrpcClient(): grpc.Client {
        const endpoint = this.driver.cs.host;
        return new grpc.Client(endpoint, this.rawGrpcCredentials);
    }

    private async getRawMetadata(): Promise<grpc.Metadata> {
        const metadata = new grpc.Metadata();
        try {
            const token = await this.driver.token;
            if (token) {
                metadata.add('x-ydb-auth-ticket', token);
            }
        } catch { /* no token available */ }
        metadata.add('x-ydb-database', this.driver.database);
        return metadata;
    }

    private async streamExecuteQuery(
        queryClient: ReturnType<Driver['createClient']>,
        sessionId: string,
        params: {
            execMode: ExecMode;
            queryContent: { syntax: Syntax; text: string };
            txControl?: {
                commitTx?: boolean;
                txSelector?: { case: string; value: unknown };
            };
            statsMode?: StatsMode;
            parameters?: Record<string, TypedValue>;
        },
        maxRows?: number,
        token?: vscode.CancellationToken,
    ): Promise<ExecuteQueryResponsePart[]> {
        if (token?.isCancellationRequested) {
            throw new CancellationError();
        }

        const parts: ExecuteQueryResponsePart[] = [];
        let totalRows = 0;
        const controller = new AbortController();

        const cancelDisposable = token?.onCancellationRequested(() => {
            controller.abort();
        });

        try {
            const stream = (queryClient as ReturnType<typeof this.driver.createClient<typeof QueryServiceDefinition>>).executeQuery(
                {
                    sessionId,
                    execMode: params.execMode,
                    query: {
                        case: 'queryContent',
                        value: params.queryContent,
                    },
                    txControl: params.txControl as never,
                    statsMode: params.statsMode ?? StatsMode.UNSPECIFIED,
                    parameters: params.parameters ?? {},
                },
                { signal: controller.signal },
            );

            for await (const part of stream) {
                if (part.status !== StatusIds_StatusCode.STATUS_CODE_UNSPECIFIED && part.status !== StatusIds_StatusCode.SUCCESS) {
                    const issues = flattenIssues(part.issues ?? []);
                    throw new Error(`Query failed: ${StatusIds_StatusCode[part.status]}${issues ? ': ' + issues : ''}`);
                }
                parts.push(part);

                if (maxRows !== undefined && part.resultSet?.rows) {
                    totalRows += part.resultSet.rows.length;
                    if (totalRows >= maxRows) {
                        controller.abort();
                        break;
                    }
                }
            }
        } catch (err) {
            if (token?.isCancellationRequested) {
                throw new CancellationError();
            }
            // If we aborted due to maxRows, that's fine
            if (maxRows !== undefined && totalRows >= maxRows) {
                return parts;
            }
            throw err;
        } finally {
            cancelDisposable?.dispose();
        }

        return parts;
    }

    private async withSession<T>(fn: (queryClient: ReturnType<Driver['createClient']>, sessionId: string) => Promise<T>, token?: vscode.CancellationToken): Promise<T> {
        if (token?.isCancellationRequested) {
            throw new CancellationError();
        }
        const queryClient = this.driver.createClient(QueryServiceDefinition);

        const createResp = await queryClient.createSession({});
        if (createResp.status !== StatusIds_StatusCode.STATUS_CODE_UNSPECIFIED && createResp.status !== StatusIds_StatusCode.SUCCESS) {
            const issues = (createResp.issues ?? []).map((i: { message?: string }) => i.message).join('; ');
            throw new Error(`CreateSession failed: ${StatusIds_StatusCode[createResp.status]}${issues ? ': ' + issues : ''}`);
        }
        if (!createResp.sessionId) {
            throw new Error('CreateSession returned empty sessionId');
        }

        const sessionId = createResp.sessionId;

        // Attach session - must wait for first response before executing queries
        const attachController = new AbortController();
        const attachStream = queryClient.attachSession({ sessionId }, { signal: attachController.signal });
        const attachIterator = attachStream[Symbol.asyncIterator]();

        // Wait for the first attach response to confirm session is ready
        const firstAttach = await attachIterator.next();
        if (!firstAttach.done) {
            const state = firstAttach.value;
            if (state.status !== StatusIds_StatusCode.STATUS_CODE_UNSPECIFIED && state.status !== StatusIds_StatusCode.SUCCESS) {
                const issues = (state.issues ?? []).map((i: { message?: string }) => i.message).join('; ');
                throw new Error(`AttachSession failed: ${StatusIds_StatusCode[state.status]}${issues ? ': ' + issues : ''}`);
            }
        }

        // Continue consuming attach stream in background (keep session alive)
        const attachPromise = (async () => {
            try {
                let next = await attachIterator.next();
                while (!next.done) {
                    if (next.value.status !== StatusIds_StatusCode.STATUS_CODE_UNSPECIFIED && next.value.status !== StatusIds_StatusCode.SUCCESS) {
                        break;
                    }
                    next = await attachIterator.next();
                }
            } catch { /* expected when we abort */ }
        })();

        try {
            return await fn(queryClient, sessionId);
        } finally {
            attachController.abort();
            await attachPromise.catch(() => {});
            try {
                await queryClient.deleteSession({ sessionId });
            } catch { /* best effort */ }
        }
    }

    private parseResponseParts(parts: ExecuteQueryResponsePart[]): QueryResult {
        const columns: ColumnInfo[] = [];
        const rows: Record<string, unknown>[] = [];
        let gotColumns = false;
        let truncated = false;

        for (const part of parts) {
            if (part.resultSet) {
                const rs = part.resultSet;

                if (!gotColumns && rs.columns) {
                    for (const col of rs.columns) {
                        columns.push({
                            name: col.name ?? '',
                            type: formatType(col.type),
                        });
                    }
                    gotColumns = true;
                }

                if (rs.truncated) {
                    truncated = true;
                }

                if (rs.rows) {
                    for (const row of rs.rows) {
                        const record: Record<string, unknown> = {};
                        const items = row.items ?? [];
                        for (let i = 0; i < items.length; i++) {
                            const colName = columns[i]?.name ?? `col${i}`;
                            record[colName] = extractValue(items[i]);
                        }
                        rows.push(record);
                    }
                }
            }
        }

        return { columns, rows, truncated };
    }

}
