import { describe, it, expect } from 'vitest';
import { buildFormHtml } from '../../views/connectionFormWebview';

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
});
