import { StreamingQuery } from '../models/types';

export function isStreamingQueryErrorStatus(status: string | undefined): boolean {
    if (!status) { return false; }
    const s = status.toLowerCase();
    return s.includes('error') || s.includes('failed') || s.includes('suspended');
}

interface RawIssue {
    message?: string;
    severity?: number;
    issues?: RawIssue[];
    position?: { row?: number; column?: number };
}

const SEVERITY_LABELS: Record<number, string> = {
    1: 'INFO',
    2: 'WARNING',
    3: 'ERROR',
    4: 'FATAL',
};

export interface ParsedIssue {
    message: string;
    severity: string;
}

export function parseIssues(raw: string | undefined): ParsedIssue[] {
    if (!raw) { return []; }
    const text = raw.trim();
    if (!text) { return []; }

    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return [{ message: text, severity: 'ERROR' }];
    }

    const out: ParsedIssue[] = [];
    const walk = (node: unknown): void => {
        if (!node || typeof node !== 'object') { return; }
        if (Array.isArray(node)) {
            node.forEach(walk);
            return;
        }
        const issue = node as RawIssue;
        if (issue.message) {
            out.push({
                message: issue.message,
                severity: SEVERITY_LABELS[issue.severity ?? 3] ?? 'ERROR',
            });
        }
        if (issue.issues) { walk(issue.issues); }
    };
    walk(parsed);
    return out;
}

export function buildStreamingQueryTooltip(query: StreamingQuery): string {
    const lines: string[] = [`${query.fullPath}`, `Status: ${query.status}`];
    if (query.retryCount !== undefined) { lines.push(`Retry count: ${query.retryCount}`); }
    if (query.lastFailAt) { lines.push(`Last fail: ${query.lastFailAt}`); }
    if (query.suspendedUntil) { lines.push(`Suspended until: ${query.suspendedUntil}`); }
    const issues = parseIssues(query.issues);
    if (issues.length > 0) {
        lines.push('', 'Issues:');
        for (const i of issues) {
            lines.push(`  [${i.severity}] ${i.message}`);
        }
    }
    return lines.join('\n');
}
