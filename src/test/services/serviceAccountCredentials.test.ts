import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as crypto from 'crypto';

// ESM mock must be declared before imports that use these modules
vi.mock('fs', () => ({
    default: { readFileSync: vi.fn() },
    readFileSync: vi.fn(),
}));

vi.mock('https', () => ({
    default: { request: vi.fn() },
    request: vi.fn(),
}));

// Import after mocks are set up
import * as fs from 'fs';
import * as https from 'https';
import { ServiceAccountCredentialsProvider } from '../../services/serviceAccountCredentials';

// Generate a real RSA key pair for testing
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

const FAKE_KEY_FILE = '/fake/sa-key.json';
const FAKE_SA_KEY = {
    id: 'test-key-id',
    service_account_id: 'test-sa-id',
    private_key: privateKeyPem,
};

function setupFsReadFileSync() {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(FAKE_SA_KEY));
}

function setupHttpsRequest(iamToken: string) {
    vi.mocked(https.request).mockImplementation((_options: unknown, callback: unknown) => {
        const cb = callback as (res: unknown) => void;
        const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
        const res = {
            on(event: string, handler: (...args: unknown[]) => void) {
                listeners[event] = listeners[event] ?? [];
                listeners[event].push(handler);
                return res;
            },
        };
        cb(res);
        const req = {
            on: () => req,
            write: () => {},
            end: () => {
                (listeners['data'] ?? []).forEach(h => h(JSON.stringify({ iamToken })));
                (listeners['end'] ?? []).forEach(h => h());
            },
        };
        return req as unknown as ReturnType<typeof https.request>;
    });
}

function setupHttpsRequestWithBodyCapture(iamToken: string, bodyCapture: { value: string }) {
    vi.mocked(https.request).mockImplementation((_options: unknown, callback: unknown) => {
        const cb = callback as (res: unknown) => void;
        const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
        const res = {
            on(event: string, handler: (...args: unknown[]) => void) {
                listeners[event] = listeners[event] ?? [];
                listeners[event].push(handler);
                return res;
            },
        };
        cb(res);
        const req = {
            on: () => req,
            write: (body: string) => { bodyCapture.value += body; },
            end: () => {
                (listeners['data'] ?? []).forEach(h => h(JSON.stringify({ iamToken })));
                (listeners['end'] ?? []).forEach(h => h());
            },
        };
        return req as unknown as ReturnType<typeof https.request>;
    });
}

describe('ServiceAccountCredentialsProvider', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('fetches IAM token and returns it', async () => {
        setupFsReadFileSync();
        setupHttpsRequest('iam-token-abc123');

        const provider = new ServiceAccountCredentialsProvider(FAKE_KEY_FILE);
        const token = await provider.getToken();

        expect(token).toBe('iam-token-abc123');
    });

    it('caches token on subsequent calls', async () => {
        setupFsReadFileSync();
        setupHttpsRequest('iam-token-cached');

        const provider = new ServiceAccountCredentialsProvider(FAKE_KEY_FILE);
        await provider.getToken();
        await provider.getToken();

        // https.request called only once (second call uses cache)
        expect(https.request).toHaveBeenCalledTimes(1);
    });

    it('forces token refresh when force=true', async () => {
        setupFsReadFileSync();
        setupHttpsRequest('iam-token-refreshed');

        const provider = new ServiceAccountCredentialsProvider(FAKE_KEY_FILE);
        await provider.getToken();
        await provider.getToken(true);

        // https.request called twice (forced refresh)
        expect(https.request).toHaveBeenCalledTimes(2);
    });

    it('throws when IAM API returns error message', async () => {
        setupFsReadFileSync();
        vi.mocked(https.request).mockImplementation((_options: unknown, callback: unknown) => {
            const cb = callback as (res: unknown) => void;
            const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
            const res = {
                on(event: string, handler: (...args: unknown[]) => void) {
                    listeners[event] = listeners[event] ?? [];
                    listeners[event].push(handler);
                    return res;
                },
            };
            cb(res);
            const req = {
                on: () => req,
                write: () => {},
                end: () => {
                    (listeners['data'] ?? []).forEach(h => h(JSON.stringify({ message: 'Invalid JWT' })));
                    (listeners['end'] ?? []).forEach(h => h());
                },
            };
            return req as unknown as ReturnType<typeof https.request>;
        });

        const provider = new ServiceAccountCredentialsProvider(FAKE_KEY_FILE);
        await expect(provider.getToken()).rejects.toThrow('Invalid JWT');
    });

    it('throws when network request fails', async () => {
        setupFsReadFileSync();
        vi.mocked(https.request).mockImplementation((_options: unknown, _callback: unknown) => {
            const errorListeners: ((...args: unknown[]) => void)[] = [];
            const req = {
                on(event: string, handler: (...args: unknown[]) => void) {
                    if (event === 'error') { errorListeners.push(handler); }
                    return req;
                },
                write: () => {},
                end: () => { errorListeners.forEach(h => h(new Error('Network error'))); },
            };
            return req as unknown as ReturnType<typeof https.request>;
        });

        const provider = new ServiceAccountCredentialsProvider(FAKE_KEY_FILE);
        await expect(provider.getToken()).rejects.toThrow('Network error');
    });

    it('throws when key file cannot be read', async () => {
        vi.mocked(fs.readFileSync).mockImplementation(() => {
            throw new Error('File not found');
        });

        const provider = new ServiceAccountCredentialsProvider(FAKE_KEY_FILE);
        await expect(provider.getToken()).rejects.toThrow('File not found');
    });

    it('sends JWT with correct header and payload to IAM API', async () => {
        setupFsReadFileSync();
        const bodyCapture = { value: '' };
        setupHttpsRequestWithBodyCapture('tok', bodyCapture);

        const provider = new ServiceAccountCredentialsProvider(FAKE_KEY_FILE);
        await provider.getToken();

        const parsed = JSON.parse(bodyCapture.value) as { jwt: string };
        expect(parsed).toHaveProperty('jwt');

        const parts = parsed.jwt.split('.');
        expect(parts).toHaveLength(3);

        const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString()) as {
            alg: string; typ: string; kid: string;
        };
        expect(header.alg).toBe('PS256');
        expect(header.typ).toBe('JWT');
        expect(header.kid).toBe(FAKE_SA_KEY.id);

        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as {
            iss: string; sub: string; aud: string; iat: number; exp: number;
        };
        expect(payload.iss).toBe(FAKE_SA_KEY.service_account_id);
        expect(payload.sub).toBe(FAKE_SA_KEY.service_account_id);
        expect(payload.aud).toBe('https://iam.api.cloud.yandex.net/iam/v1/tokens');

        const now = Math.floor(Date.now() / 1000);
        expect(payload.iat).toBeCloseTo(now, -1); // within ~10 seconds
        expect(payload.exp).toBe(payload.iat + 3600);
    });

    it('signs JWT with PS256 (verifiable with matching public key)', async () => {
        setupFsReadFileSync();
        const bodyCapture = { value: '' };
        setupHttpsRequestWithBodyCapture('tok', bodyCapture);

        const provider = new ServiceAccountCredentialsProvider(FAKE_KEY_FILE);
        await provider.getToken();

        const { jwt } = JSON.parse(bodyCapture.value) as { jwt: string };
        const parts = jwt.split('.');

        const signingInput = `${parts[0]}.${parts[1]}`;
        const signature = Buffer.from(parts[2], 'base64url');
        const valid = crypto.verify('RSA-SHA256', Buffer.from(signingInput), {
            key: publicKey,
            padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
            saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
        }, signature);

        expect(valid).toBe(true);
    });

    it('sends request to correct IAM endpoint', async () => {
        setupFsReadFileSync();
        setupHttpsRequest('tok');

        const provider = new ServiceAccountCredentialsProvider(FAKE_KEY_FILE);
        await provider.getToken();

        const callArgs = vi.mocked(https.request).mock.calls[0];
        const options = callArgs[0] as unknown as { hostname: string; path: string; method: string };
        expect(options.hostname).toBe('iam.api.cloud.yandex.net');
        expect(options.path).toBe('/iam/v1/tokens');
        expect(options.method).toBe('POST');
    });
});
