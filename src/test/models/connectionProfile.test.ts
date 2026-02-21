import { describe, it, expect } from 'vitest';
import {
    deriveMonitoringUrl,
    getMonitoringUrl,
    extractAuthToken,
    AUTH_TYPE_LABELS,
    type AuthType,
    type ConnectionProfile,
} from '../../models/connectionProfile';

describe('deriveMonitoringUrl', () => {
    it('derives URL from grpcs:// endpoint', () => {
        expect(deriveMonitoringUrl('grpcs://ydb.example.com:2135')).toBe('https://ydb.example.com:8765');
    });

    it('derives URL from grpc:// endpoint', () => {
        expect(deriveMonitoringUrl('grpc://ydb.example.com:2135')).toBe('http://ydb.example.com:8765');
    });

    it('derives URL from bare host', () => {
        expect(deriveMonitoringUrl('ydb.example.com:2135')).toBe('http://ydb.example.com:8765');
    });

    it('derives URL from https:// endpoint', () => {
        expect(deriveMonitoringUrl('https://ydb.example.com:2135')).toBe('https://ydb.example.com:8765');
    });

    it('uses https when secure flag is set', () => {
        expect(deriveMonitoringUrl('ydb.example.com:2135', true)).toBe('https://ydb.example.com:8765');
    });

    it('returns empty string for invalid endpoint', () => {
        expect(deriveMonitoringUrl('')).toBe('');
    });
});

describe('getMonitoringUrl', () => {
    const baseProfile: ConnectionProfile = {
        id: 'test',
        name: 'Test',
        endpoint: 'grpc://ydb.example.com:2135',
        database: '/mydb',
        authType: 'anonymous',
        secure: false,
    };

    it('returns explicit monitoring URL when set', () => {
        const profile = { ...baseProfile, monitoringUrl: 'https://custom.monitor:8080' };
        expect(getMonitoringUrl(profile)).toBe('https://custom.monitor:8080');
    });

    it('derives URL from endpoint when no explicit URL', () => {
        expect(getMonitoringUrl(baseProfile)).toBe('http://ydb.example.com:8765');
    });
});

describe('extractAuthToken', () => {
    const baseProfile: ConnectionProfile = {
        id: 'test',
        name: 'Test',
        endpoint: 'grpc://localhost:2135',
        database: '/mydb',
        authType: 'anonymous',
        secure: false,
    };

    it('returns token for token auth type', () => {
        const profile = { ...baseProfile, authType: 'token' as AuthType, token: 'my-token' };
        expect(extractAuthToken(profile)).toBe('my-token');
    });

    it('returns undefined for non-token auth type', () => {
        const profile = { ...baseProfile, authType: 'anonymous' as AuthType, token: 'should-not-return' };
        expect(extractAuthToken(profile)).toBeUndefined();
    });

    it('returns undefined when token is missing', () => {
        const profile = { ...baseProfile, authType: 'token' as AuthType };
        expect(extractAuthToken(profile)).toBeUndefined();
    });
});

describe('AUTH_TYPE_LABELS', () => {
    it('has labels for all auth types', () => {
        const allTypes: AuthType[] = ['anonymous', 'static', 'token', 'serviceAccount', 'metadata'];
        for (const authType of allTypes) {
            expect(AUTH_TYPE_LABELS[authType]).toBeDefined();
            expect(typeof AUTH_TYPE_LABELS[authType]).toBe('string');
            expect(AUTH_TYPE_LABELS[authType].length).toBeGreaterThan(0);
        }
    });
});
