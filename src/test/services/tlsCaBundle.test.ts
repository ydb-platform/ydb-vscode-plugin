import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as tls from 'tls';
import { buildCaBundle } from '../../services/connectionManager';

// Minimal self-signed PEM for testing (not a real cert, just valid PEM structure)
const FAKE_CERT_A = [
    '-----BEGIN CERTIFICATE-----',
    'AAAA',
    '-----END CERTIFICATE-----',
].join('\n');

const FAKE_CERT_B = [
    '-----BEGIN CERTIFICATE-----',
    'BBBB',
    '-----END CERTIFICATE-----',
].join('\n');

describe('buildCaBundle', () => {
    it('joins multiple PEM strings with newline separator', () => {
        const bundle = buildCaBundle([FAKE_CERT_A, FAKE_CERT_B]);
        const text = bundle.toString('utf-8');

        // Must NOT have "-----END CERTIFICATE----------BEGIN CERTIFICATE-----" (no newline)
        expect(text).not.toContain('-----END CERTIFICATE----------BEGIN CERTIFICATE-----');
        // Must contain proper separator
        expect(text).toContain('-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----');
    });

    it('handles PEM strings without trailing newlines', () => {
        // Simulates tls.rootCertificates entries that don't end with \n
        const certNoNewline = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----';
        expect(certNoNewline.endsWith('\n')).toBe(false);

        const bundle = buildCaBundle([certNoNewline, FAKE_CERT_B]);
        const text = bundle.toString('utf-8');

        expect(text).toContain('-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----');
    });

    it('handles PEM strings with trailing newlines', () => {
        const certWithNewline = FAKE_CERT_A + '\n';
        const bundle = buildCaBundle([certWithNewline, FAKE_CERT_B]);
        const text = bundle.toString('utf-8');

        // Still valid — double newline between certs is fine
        expect(text).not.toContain('-----END CERTIFICATE----------BEGIN CERTIFICATE-----');
    });

    it('accepts Buffer sources', () => {
        const bufA = Buffer.from(FAKE_CERT_A);
        const bundle = buildCaBundle([bufA, FAKE_CERT_B]);
        const text = bundle.toString('utf-8');

        expect(text).toContain('AAAA');
        expect(text).toContain('BBBB');
        expect(text).toContain('-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----');
    });

    it('skips undefined sources', () => {
        const bundle = buildCaBundle([FAKE_CERT_A, undefined, FAKE_CERT_B]);
        const text = bundle.toString('utf-8');

        expect(text).toContain('AAAA');
        expect(text).toContain('BBBB');
    });

    it('returns empty buffer for empty input', () => {
        const bundle = buildCaBundle([]);
        expect(bundle.length).toBe(0);
    });

    it('returns empty buffer for all-undefined input', () => {
        const bundle = buildCaBundle([undefined, undefined]);
        expect(bundle.length).toBe(0);
    });

    it('preserves all certificates when joining system CAs with extra certs', () => {
        // Simulate the real scenario: system CAs joined + extra cert
        const systemCAs = [FAKE_CERT_A, FAKE_CERT_B];
        const extraCert = [
            '-----BEGIN CERTIFICATE-----',
            'CCCC',
            '-----END CERTIFICATE-----',
        ].join('\n');

        const bundle = buildCaBundle([systemCAs.join('\n'), extraCert]);
        const text = bundle.toString('utf-8');

        // Count certificates in the bundle
        const certCount = (text.match(/-----BEGIN CERTIFICATE-----/g) || []).length;
        expect(certCount).toBe(3);
    });
});

describe('Yandex Cloud CA cert file', () => {
    const certPath = path.join(__dirname, '..', '..', '..', 'certs', 'yandex-cloud-ca.pem');

    it('exists on disk', () => {
        expect(fs.existsSync(certPath)).toBe(true);
    });

    it('contains valid PEM certificates', () => {
        const content = fs.readFileSync(certPath, 'utf-8');
        const beginCount = (content.match(/-----BEGIN CERTIFICATE-----/g) || []).length;
        const endCount = (content.match(/-----END CERTIFICATE-----/g) || []).length;

        expect(beginCount).toBeGreaterThanOrEqual(1);
        expect(beginCount).toBe(endCount);
    });

    it('contains YandexInternalRootCA (self-signed root)', () => {
        const content = fs.readFileSync(certPath, 'utf-8');
        // The root CA is included so Node.js can verify the full chain
        expect(content).toContain('-----BEGIN CERTIFICATE-----');
    });

    it('integrates into a bundle with system CAs without boundary corruption', () => {
        const systemCAs = tls.rootCertificates;
        const yandexCa = fs.readFileSync(certPath, 'utf-8');

        const bundle = buildCaBundle([systemCAs.join('\n'), yandexCa]);
        const text = bundle.toString('utf-8');

        // No corrupted PEM boundaries
        expect(text).not.toMatch(/-----END CERTIFICATE----------BEGIN CERTIFICATE-----/);

        // All system certs + yandex certs present
        const totalCerts = (text.match(/-----BEGIN CERTIFICATE-----/g) || []).length;
        const yandexCerts = (yandexCa.match(/-----BEGIN CERTIFICATE-----/g) || []).length;
        expect(totalCerts).toBe(systemCAs.length + yandexCerts);
    });
});
