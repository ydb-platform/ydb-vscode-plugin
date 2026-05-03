import * as http from 'http';
import * as https from 'https';
import { ConnectionProfile } from '../models/connectionProfile';

const SESSION_TTL_MS = 60 * 60 * 1000;
const SESSION_COOKIE_NAME = 'ydb_session_id';
const MAX_REDIRECTS = 5;

const SESSION_COOKIE_RE = new RegExp(
    `(?:^|[;,\\s])${SESSION_COOKIE_NAME}=([^;,\\s]+)`,
);

export function extractSessionCookie(setCookieHeader: string): string | undefined {
    const m = SESSION_COOKIE_RE.exec(setCookieHeader);
    return m ? m[1] : undefined;
}

class UnauthorizedError extends Error {
    constructor(url: string) {
        super(`HTTP 401 from ${url}`);
        this.name = 'UnauthorizedError';
    }
}

export class MonitoringAuthClient {
    private sessionCookie: string | undefined;
    private sessionExpiresAt = 0;
    private loginPromise: Promise<string> | undefined;

    constructor(
        private readonly monitoringUrl: string,
        private readonly authToken?: string,
        private readonly user?: string,
        private readonly password?: string,
    ) {}

    async httpGet(url: string): Promise<string> {
        try {
            return await this.doHttpGet(url, false);
        } catch (err) {
            if (err instanceof UnauthorizedError && this.user) {
                this.invalidateSession();
                return this.doHttpGet(url, true);
            }
            throw err;
        }
    }

    private async doHttpGet(
        url: string,
        isRetry: boolean,
        redirectsLeft = MAX_REDIRECTS,
    ): Promise<string> {
        const headers: Record<string, string> = { 'Accept': 'application/json' };
        await this.applyAuth(headers);
        return new Promise((resolve, reject) => {
            const client = url.startsWith('https') ? https : http;
            client
                .get(url, { headers }, (res) => {
                    const status = res.statusCode ?? 0;
                    if ([301, 302, 303, 307, 308].includes(status)) {
                        const location = res.headers.location;
                        res.resume();
                        if (!location || redirectsLeft <= 0) {
                            reject(new Error(`Redirect failed from ${url}`));
                            return;
                        }
                        const next = location.startsWith('/')
                            ? new URL(location, url).href
                            : location;
                        this.doHttpGet(next, isRetry, redirectsLeft - 1).then(resolve, reject);
                        return;
                    }
                    if (status === 401 && !isRetry) {
                        res.resume();
                        reject(new UnauthorizedError(url));
                        return;
                    }
                    if (status !== 200) {
                        res.resume();
                        reject(new Error(`HTTP ${status} from ${url}`));
                        return;
                    }
                    let data = '';
                    res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
                    res.on('end', () => resolve(data));
                    res.on('error', reject);
                })
                .on('error', reject);
        });
    }

    private async applyAuth(headers: Record<string, string>): Promise<void> {
        if (this.authToken) {
            headers['Authorization'] = `OAuth ${this.authToken}`;
            return;
        }
        if (this.user) {
            const cookie = await this.ensureSession();
            headers['Cookie'] = `${SESSION_COOKIE_NAME}=${cookie}`;
        }
    }

    private async ensureSession(): Promise<string> {
        if (this.sessionCookie && Date.now() < this.sessionExpiresAt) {
            return this.sessionCookie;
        }
        if (!this.loginPromise) {
            this.loginPromise = this.login()
                .then((cookie) => {
                    this.sessionCookie = cookie;
                    this.sessionExpiresAt = Date.now() + SESSION_TTL_MS;
                    return cookie;
                })
                .finally(() => {
                    this.loginPromise = undefined;
                });
        }
        return this.loginPromise;
    }

    private invalidateSession(): void {
        this.sessionCookie = undefined;
        this.sessionExpiresAt = 0;
    }

    private login(): Promise<string> {
        const base = this.monitoringUrl.endsWith('/')
            ? this.monitoringUrl.slice(0, -1)
            : this.monitoringUrl;
        const loginUrl = `${base}/login`;
        const body = JSON.stringify({ user: this.user, password: this.password ?? '' });
        return new Promise((resolve, reject) => {
            const u = new URL(loginUrl);
            const client = u.protocol === 'https:' ? https : http;
            const req = client.request(
                {
                    method: 'POST',
                    hostname: u.hostname,
                    port: u.port || (u.protocol === 'https:' ? 443 : 80),
                    path: u.pathname + u.search,
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                        'Content-Length': Buffer.byteLength(body),
                    },
                },
                (res) => {
                    const status = res.statusCode ?? 0;
                    res.resume();
                    if (status !== 200) {
                        reject(new Error(`Login failed: HTTP ${status} from ${loginUrl}`));
                        return;
                    }
                    const setCookie = res.headers['set-cookie'] ?? [];
                    for (const header of setCookie) {
                        const value = extractSessionCookie(header);
                        if (value) {
                            resolve(value);
                            return;
                        }
                    }
                    reject(new Error(`Login response did not contain ${SESSION_COOKIE_NAME} cookie`));
                },
            );
            req.on('error', reject);
            req.write(body);
            req.end();
        });
    }
}

export function buildMonitoringAuthClient(
    monitoringUrl: string,
    profile: ConnectionProfile,
): MonitoringAuthClient {
    if (profile.authType === 'token' && profile.token) {
        return new MonitoringAuthClient(monitoringUrl, profile.token);
    }
    if (profile.authType === 'static' && profile.username) {
        return new MonitoringAuthClient(
            monitoringUrl,
            undefined,
            profile.username,
            profile.password,
        );
    }
    return new MonitoringAuthClient(monitoringUrl);
}
