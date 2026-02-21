export enum SchemeEntryType {
    DIRECTORY = 1,
    TABLE = 2,
    PERS_QUEUE_GROUP = 3,
    DATABASE = 4,
    RTMR_VOLUME = 5,
    BLOCK_STORE_VOLUME = 6,
    COORDINATION_NODE = 7,
    COLUMN_STORE = 12,
    COLUMN_TABLE = 13,
    SEQUENCE = 15,
    REPLICATION = 16,
    TOPIC = 17,
    EXTERNAL_TABLE = 18,
    EXTERNAL_DATA_SOURCE = 19,
    VIEW = 20,
    RESOURCE_POOL = 21,
    TRANSFER = 23,
}

export interface SchemeEntry {
    name: string;
    type: SchemeEntryType;
    owner?: string;
    effectivePermissions?: PermissionEntry[];
    permissions?: PermissionEntry[];
}

export interface PermissionEntry {
    subject: string;
    permissionNames: string[];
}

export interface SessionInfo {
    sessionId: string;
    nodeId: number;
    state: string;
    queryId: string;
    startTime: string;
    user: string;
    clientAddress: string;
    applicationName: string;
}

export interface DashboardMetrics {
    cpuUsed: number;
    cpuTotal: number;
    storageUsed: number;
    storageTotal: number;
    memoryUsed: number;
    memoryTotal: number;
    networkThroughput: number;
    nodes: NodeInfo[];
}

export interface NodeInfo {
    nodeId: number;
    host: string;
    status: string;
    uptime: number;
    cpuUsage: number;
    memoryUsage: number;
}

export interface QueryResult {
    columns: ColumnInfo[];
    rows: Record<string, unknown>[];
    truncated: boolean;
}

export interface ColumnInfo {
    name: string;
    type: string;
}

export interface ExplainResult {
    plan: PlanNode;
    ast?: string;
    rawJson?: string;
}

export interface PlanOperator {
    name: string;
    properties: Record<string, string>;
}

export interface PlanNode {
    name: string;
    tableName?: string;
    operators?: string;
    operatorDetails?: PlanOperator[];
    properties: Record<string, string>;
    children: PlanNode[];
}

export interface QueryStatistics {
    totalDurationUs: number;
    totalCpuTimeUs: number;
    planJson: string;
}

export interface StreamingQuery {
    name: string;
    fullPath: string;
    status: string;
    queryText: string;
    resourcePool?: string;
    retryCount?: number;
    lastFailAt?: string;
    suspendedUntil?: string;
    plan?: string;
    ast?: string;
    issues?: string;
}

export interface PaginatedQueryState {
    queryText: string;
    allRows: Record<string, unknown>[];
    columns: ColumnInfo[];
    pageSize: number;
    isComplete: boolean;
}

export interface TableDescription {
    columns: { name: string; type: string; notNull: boolean }[];
    primaryKeys: string[];
    partitionBy: string[];
    isColumnTable: boolean;
}

export interface ExternalDataSourceDescription {
    sourceType?: string;
    location?: string;
    properties: Record<string, string>;
}

export interface TransferDescription {
    sourcePath?: string;
    destinationPath?: string;
    state: string;
    transformationLambda?: string;
    consumerName?: string;
    connectionString?: string;
}

export interface ExternalTableDescription {
    sourceType?: string;
    dataSourcePath?: string;
    location?: string;
    columns: { name: string; type: string; notNull: boolean }[];
    format?: string;
    compression?: string;
}

export interface ResourcePool {
    name: string;
    concurrentQueryLimit: number;
    queueSize: number;
    databaseLoadCpuThreshold: number;
    resourceWeight: number;
    totalCpuLimitPercentPerNode: number;
    queryCpuLimitPercentPerNode: number;
    queryMemoryLimitPercentPerNode: number;
}

export interface ViewerAutocompleteResponse {
    Success: boolean;
    Error?: string[];
    Result: {
        Entities?: ViewerAutocompleteEntity[];
        Total?: number;
    };
}

export interface ViewerAutocompleteEntity {
    Name: string;
    Type: string;
    Parent: string;
    PKIndex?: number;
    NotNull?: boolean;
    Default?: number;
}
