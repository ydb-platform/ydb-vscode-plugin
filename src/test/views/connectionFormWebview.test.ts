import { describe, it, expect } from 'vitest';
import { buildFormHtml, computeMonitoringUrl } from '../../views/connectionFormWebview';

describe('buildFormHtml', () => {
    it('host input has no pre-filled value (only placeholder)', () => {
        const html = buildFormHtml(false);
        // Must have placeholder but no value attribute on host input
        expect(html).toContain('id="host"');
        expect(html).toContain('placeholder="localhost"');
        // value="localhost" would cause accidental concatenation when user starts typing
        expect(html).not.toMatch(/id="host"[^>]*value="localhost"/);
        expect(html).not.toMatch(/value="localhost"[^>]*id="host"/);
    });

    it('database input has no pre-filled value (only placeholder)', () => {
        const html = buildFormHtml(false);
        expect(html).toContain('id="database"');
        expect(html).toContain('placeholder="/local"');
        expect(html).not.toMatch(/id="database"[^>]*value="\/local"/);
        expect(html).not.toMatch(/value="\/local"[^>]*id="database"/);
    });

    it('port input retains default value 2135', () => {
        const html = buildFormHtml(false);
        expect(html).toContain('id="port"');
        expect(html).toContain('value="2135"');
    });

    it('generates valid HTML for new connection form', () => {
        const html = buildFormHtml(false);
        expect(html).toContain('<!DOCTYPE html>');
        expect(html).toContain('New YDB Connection');
        expect(html).toContain('id="saveBtn"');
        expect(html).toContain('id="testBtn"');
    });

    it('generates valid HTML for edit connection form', () => {
        const html = buildFormHtml(true);
        expect(html).toContain('<!DOCTYPE html>');
        expect(html).toContain('Edit YDB Connection');
    });

    it('form contains all required auth type options', () => {
        const html = buildFormHtml(false);
        expect(html).toContain('value="anonymous"');
        expect(html).toContain('value="static"');
        expect(html).toContain('value="token"');
        expect(html).toContain('value="serviceAccount"');
        expect(html).toContain('value="metadata"');
    });

    it('form contains secure checkbox', () => {
        const html = buildFormHtml(false);
        expect(html).toContain('id="secure"');
        expect(html).toContain('type="checkbox"');
    });

    it('form contains useRag checkbox', () => {
        const html = buildFormHtml(false);
        expect(html).toContain('id="useRag"');
        expect(html).toContain('for="useRag"');
    });

    it('form contains ragRunningBadge status element', () => {
        const html = buildFormHtml(false);
        expect(html).toContain('id="ragRunningBadge"');
        expect(html).toContain('○ Not running');
    });

    it('form handles toggleRag via useRag change listener', () => {
        const html = buildFormHtml(false);
        expect(html).toContain('toggleRag');
        expect(html).toContain('updateRagRunningBadge');
    });

    it('form auto-derives monitoring URL from host and secure flag', () => {
        const html = buildFormHtml(false);
        expect(html).toContain('monitoringUrlAuto');
        expect(html).toContain('computeMonitoringUrl');
        expect(html).toContain(":8765");
        expect(html).toMatch(/secure[^?]*\?\s*'https'\s*:\s*'http'/);
        // input listener on host triggers refresh
        expect(html).toMatch(/getElementById\('host'\)\.addEventListener\('input', refreshMonitoringUrl\)/);
        // secure change listener triggers refresh
        expect(html).toMatch(/getElementById\('secure'\)\.addEventListener\('change', refreshMonitoringUrl\)/);
        // user editing monitoringUrl flips auto flag based on equality with computed
        expect(html).toMatch(/getElementById\('monitoringUrl'\)\.addEventListener\('input'/);
    });
});

describe('computeMonitoringUrl', () => {
    it('uses http when secure is false', () => {
        expect(computeMonitoringUrl('example.com', false)).toBe('http://example.com:8765');
    });

    it('uses https when secure is true', () => {
        expect(computeMonitoringUrl('example.com', true)).toBe('https://example.com:8765');
    });

    it('returns empty string when host is empty', () => {
        expect(computeMonitoringUrl('', true)).toBe('');
        expect(computeMonitoringUrl('   ', false)).toBe('');
    });

    it('trims whitespace from host', () => {
        expect(computeMonitoringUrl('  srv1  ', true)).toBe('https://srv1:8765');
    });
});

describe('monitoring URL inline script wiring', () => {
    it('script computes URL with the same formula as computeMonitoringUrl', () => {
        const html = buildFormHtml(false);
        // Verify the inline script's formula matches: (secure ? 'https' : 'http') + '://' + host + ':8765'
        expect(html).toMatch(/secure\s*\?\s*'https'\s*:\s*'http'\s*\)\s*\+\s*':\/\/'\s*\+\s*host\s*\+\s*':8765'/);
    });

    it('script wires host input, secure change, and monitoringUrl input listeners', () => {
        const html = buildFormHtml(false);
        expect(html).toMatch(/getElementById\('host'\)\.addEventListener\('input', refreshMonitoringUrl\)/);
        expect(html).toMatch(/getElementById\('secure'\)\.addEventListener\('change', refreshMonitoringUrl\)/);
        expect(html).toMatch(/getElementById\('monitoringUrl'\)\.addEventListener\('input'/);
    });

    it('script flips auto flag based on equality with computed value', () => {
        const html = buildFormHtml(false);
        expect(html).toContain('monitoringUrlAuto = this.value.trim() === computeMonitoringUrl()');
    });

    it('fillForm preserves user-customized monitoring URL (auto = false)', () => {
        const html = buildFormHtml(true);
        expect(html).toContain("monitoringUrlAuto = currentMonitoring === '' || currentMonitoring === computeMonitoringUrl()");
    });
});
