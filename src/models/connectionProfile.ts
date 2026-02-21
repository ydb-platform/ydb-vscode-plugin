export type AuthType = 'anonymous' | 'static' | 'token' | 'serviceAccount' | 'metadata';

export interface ConnectionProfile {
    id: string;
    name: string;
    /** @deprecated Use host + port instead. Kept for backward compatibility. */
    endpoint: string;
    host?: string;
    port?: number;
    database: string;
    authType: AuthType;
    secure: boolean;
    monitoringUrl?: string;
    // Auth-specific fields
    username?: string;
    password?: string;
    token?: string;
    serviceAccountKeyFile?: string;
    /** Path to a custom CA certificate file (PEM). Overrides the global ydb.tlsCaCertFile setting. */
    tlsCaCertFile?: string;
    /** Whether to enable the RAG (YQL documentation) index for this connection. */
    useRag?: boolean;
}

/** Returns the effective host:port string for a profile. */
export function getEffectiveEndpoint(profile: Pick<ConnectionProfile, 'endpoint' | 'host' | 'port'>): string {
    if (profile.host) {
        return profile.port ? `${profile.host}:${profile.port}` : profile.host;
    }
    return profile.endpoint;
}

/**
 * Derives a monitoring URL from the connection endpoint.
 * Extracts the host and uses port 8765 (YDB Viewer default).
 */
export function deriveMonitoringUrl(endpoint: string, secure?: boolean): string {
    try {
        let normalized = endpoint
            .replace(/^grpcs:\/\//, 'https://')
            .replace(/^grpc:\/\//, 'http://');
        if (!/^https?:\/\//.test(normalized)) {
            normalized = `http://${normalized}`;
        }
        const url = new URL(normalized);
        const useHttps = url.protocol === 'https:' || secure;
        return `${useHttps ? 'https' : 'http'}://${url.hostname}:8765`;
    } catch {
        return '';
    }
}

export function getMonitoringUrl(profile: ConnectionProfile): string {
    return profile.monitoringUrl || deriveMonitoringUrl(getEffectiveEndpoint(profile), profile.secure);
}


export function extractAuthToken(profile: ConnectionProfile): string | undefined {
    if (profile.authType === 'token' && profile.token) {
        return profile.token;
    }
    return undefined;
}

export const AUTH_TYPE_LABELS: Record<AuthType, string> = {
    anonymous: 'Anonymous',
    static: 'Static Credentials (Login/Password)',
    token: 'Access Token',
    serviceAccount: 'Service Account Key File',
    metadata: 'Metadata Service (Cloud VM)',
};
