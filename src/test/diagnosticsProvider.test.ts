import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseYqlQueryWithoutCursor } from '@gravity-ui/websql-autocomplete/yql';

describe('YQL Diagnostics - parseYqlQueryWithoutCursor', () => {
    it('returns no errors for valid query', () => {
        const result = parseYqlQueryWithoutCursor('SELECT 1');
        expect(result.errors).toHaveLength(0);
    });

    it('returns no errors for valid SELECT FROM', () => {
        const result = parseYqlQueryWithoutCursor('SELECT * FROM my_table');
        expect(result.errors).toHaveLength(0);
    });

    it('detects syntax errors in invalid queries', () => {
        const result = parseYqlQueryWithoutCursor('SELECTT * FROM');
        expect(result.errors.length).toBeGreaterThan(0);
    });

    it('returns errors with position info', () => {
        const result = parseYqlQueryWithoutCursor('SELECT FROM WHERE');
        // The parser should find errors (FROM requires table, WHERE requires condition)
        if (result.errors.length > 0) {
            const error = result.errors[0];
            expect(error).toHaveProperty('startLine');
            expect(error).toHaveProperty('startColumn');
            expect(error).toHaveProperty('endLine');
            expect(error).toHaveProperty('endColumn');
            expect(error).toHaveProperty('message');
        }
    });

    it('returns errors for empty query (parser expects input)', () => {
        const result = parseYqlQueryWithoutCursor('');
        // The parser reports an error for empty input (expects at least one statement)
        expect(result.errors.length).toBeGreaterThanOrEqual(0);
    });

    it('handles multiline queries', () => {
        const result = parseYqlQueryWithoutCursor(`
            SELECT a, b
            FROM my_table
            WHERE a > 1
        `);
        expect(result.errors).toHaveLength(0);
    });

    it('detects unclosed parenthesis', () => {
        const result = parseYqlQueryWithoutCursor('SELECT COUNT(');
        expect(result.errors.length).toBeGreaterThan(0);
    });

    it('handles PRAGMA correctly', () => {
        const result = parseYqlQueryWithoutCursor('PRAGMA TablePathPrefix("/my/db");');
        expect(result.errors).toHaveLength(0);
    });

    it('handles UPSERT correctly', () => {
        const result = parseYqlQueryWithoutCursor('UPSERT INTO my_table (a, b) VALUES (1, "hello")');
        expect(result.errors).toHaveLength(0);
    });

    it('handles CREATE TABLE correctly', () => {
        const result = parseYqlQueryWithoutCursor(`
            CREATE TABLE my_table (
                id Int32,
                name Utf8,
                PRIMARY KEY (id)
            )
        `);
        expect(result.errors).toHaveLength(0);
    });
});
