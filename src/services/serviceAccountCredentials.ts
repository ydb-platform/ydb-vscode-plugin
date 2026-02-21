import * as fs from 'fs';
import * as crypto from 'crypto';
import * as https from 'https';
import { CredentialsProvider } from '@ydbjs/auth';

interface ServiceAccountKey {
    id: string;
    service_account_id: string;
    private_key: string;
}

/**
 * Yandex Cloud Service Account credentials provider.
 * Reads a SA key JSON file, signs a JWT with the private key (PS256),
 * and exchanges it for an IAM token via iam.api.cloud.yandex.net.
 */
export class ServiceAccountCredentialsProvider extends CredentialsProvider {
    private cachedToken: string | undefined;
    private tokenExpiresAt: number = 0;

    constructor(private readonly keyFilePath: string) {
        super();
    }

    async getToken(force?: boolean): Promise<string> {
        if (!force && this.cachedToken && Date.now() < this.tokenExpiresAt) {
            return this.cachedToken;
        }

        const keyJson = fs.readFileSync(this.keyFilePath, 'utf8');
        const key = JSON.parse(keyJson) as ServiceAccountKey;
        const jwt = createJwt(key);
        const iamToken = await exchangeJwtForIamToken(jwt);

        this.cachedToken = iamToken;
        // IAM tokens are valid for ~12 hours; refresh after 11 hours
        this.tokenExpiresAt = Date.now() + 11 * 60 * 60 * 1000;

        return iamToken;
    }
}

function base64url(buf: Buffer): string {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function createJwt(key: ServiceAccountKey): string {
    const now = Math.floor(Date.now() / 1000);

    const header = base64url(Buffer.from(JSON.stringify({
        alg: 'PS256',
        typ: 'JWT',
        kid: key.id,
    })));

    const payload = base64url(Buffer.from(JSON.stringify({
        iss: key.service_account_id,
        sub: key.service_account_id,
        aud: 'https://iam.api.cloud.yandex.net/iam/v1/tokens',
        iat: now,
        exp: now + 3600,
    })));

    const signingInput = `${header}.${payload}`;
    const signature = base64url(
        crypto.sign('RSA-SHA256', Buffer.from(signingInput), {
            key: key.private_key,
            padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
            saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
        }),
    );

    return `${signingInput}.${signature}`;
}

function exchangeJwtForIamToken(jwt: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ jwt });
        const options = {
            hostname: 'iam.api.cloud.yandex.net',
            path: '/iam/v1/tokens',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data) as { iamToken?: string; message?: string };
                    if (parsed.iamToken) {
                        resolve(parsed.iamToken);
                    } else {
                        reject(new Error(`Failed to get IAM token: ${parsed.message ?? data}`));
                    }
                } catch (e) {
                    reject(new Error(`Failed to parse IAM response: ${data}`));
                }
            });
        });

        req.on('error', reject);
        req.write(body);
        req.end();
    });
}
