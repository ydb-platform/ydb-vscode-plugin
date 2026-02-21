import { describe, it, expect } from 'vitest';
import {
    encodeVarint,
    readProtobufField,
    readProtobufVarint,
    readProtobufString,
    readAllProtobufFields,
} from '../../utils/protobufReader';

/**
 * These tests simulate version-specific protobuf responses for various YDB describe* methods.
 * They test the wire-level parsing logic that the QueryService uses.
 */

function buildMessage(fields: Array<{ field: number; wireType: number; data: Buffer }>): Buffer {
    const parts: Buffer[] = [];
    for (const f of fields) {
        const tag = (f.field << 3) | f.wireType;
        parts.push(encodeVarint(tag));
        if (f.wireType === 2) {
            parts.push(encodeVarint(f.data.length));
        }
        parts.push(f.data);
    }
    return Buffer.concat(parts);
}

function sf(field: number, str: string) {
    return { field, wireType: 2, data: Buffer.from(str, 'utf-8') };
}

function vf(field: number, value: number) {
    return { field, wireType: 0, data: encodeVarint(value) };
}

function mf(field: number, inner: Buffer) {
    return { field, wireType: 2, data: inner };
}

describe('describeView parsing', () => {
    it('extracts query_text from DescribeViewResult (field 2)', () => {
        const resultBytes = buildMessage([sf(2, 'SELECT * FROM users')]);
        const queryText = readProtobufString(resultBytes, 2);
        expect(queryText).toBe('SELECT * FROM users');
    });

    it('handles missing query_text', () => {
        const resultBytes = buildMessage([sf(1, 'view_name')]);
        const queryText = readProtobufString(resultBytes, 2);
        expect(queryText).toBeUndefined();
    });

    it('handles result with extra unknown fields (forward compat)', () => {
        const resultBytes = buildMessage([
            sf(1, 'view_name'),
            sf(2, 'SELECT 1'),
            sf(99, 'unknown_field'),  // unknown future field
            vf(100, 42),             // unknown varint field
        ]);
        const queryText = readProtobufString(resultBytes, 2);
        expect(queryText).toBe('SELECT 1');
    });
});

describe('describeExternalDataSource parsing', () => {
    it('extracts sourceType and location', () => {
        const resultBytes = buildMessage([
            sf(2, 'ObjectStorage'),
            sf(3, 'https://s3.amazonaws.com/bucket/'),
        ]);
        expect(readProtobufString(resultBytes, 2)).toBe('ObjectStorage');
        expect(readProtobufString(resultBytes, 3)).toBe('https://s3.amazonaws.com/bucket/');
    });

    it('extracts map properties (repeated field 4)', () => {
        const entry1 = buildMessage([sf(1, 'AWS_REGION'), sf(2, 'us-east-1')]);
        const entry2 = buildMessage([sf(1, 'AUTH_METHOD'), sf(2, 'AWS')]);
        const resultBytes = buildMessage([
            sf(2, 'ObjectStorage'),
            mf(4, entry1),
            mf(4, entry2),
        ]);
        const entries = readAllProtobufFields(resultBytes, 4);
        expect(entries).toHaveLength(2);

        const props: Record<string, string> = {};
        for (const entry of entries) {
            const key = readProtobufString(entry, 1);
            const value = readProtobufString(entry, 2);
            if (key) { props[key] = value ?? ''; }
        }
        expect(props['AWS_REGION']).toBe('us-east-1');
        expect(props['AUTH_METHOD']).toBe('AWS');
    });

    it('handles empty properties', () => {
        const resultBytes = buildMessage([sf(2, 'Ydb')]);
        const entries = readAllProtobufFields(resultBytes, 4);
        expect(entries).toHaveLength(0);
    });

    it('handles unknown extra fields (forward compat)', () => {
        const resultBytes = buildMessage([
            sf(2, 'ObjectStorage'),
            sf(3, 'location'),
            sf(50, 'new_field'),
        ]);
        expect(readProtobufString(resultBytes, 2)).toBe('ObjectStorage');
    });
});

describe('describeTransfer parsing', () => {
    const states = [
        { field: 3, name: 'Running' },
        { field: 4, name: 'Error' },
        { field: 5, name: 'Done' },
        { field: 6, name: 'Paused' },
    ];

    for (const { field, name } of states) {
        it(`detects ${name} state (field ${field})`, () => {
            const stateMsg = buildMessage([sf(1, 'state_details')]);
            const resultBytes = buildMessage([mf(field, stateMsg)]);
            const stateField = readProtobufField(resultBytes, field);
            expect(stateField).toBeDefined();
        });
    }

    it('extracts all transfer fields', () => {
        const resultBytes = buildMessage([
            mf(3, buildMessage([])),  // Running state
            sf(7, '/db/source_topic'),
            sf(8, '/db/dest_table'),
            sf(9, '$lambda = ($msg) -> { return $msg; };'),
            sf(10, 'my-consumer'),
        ]);

        expect(readProtobufString(resultBytes, 7)).toBe('/db/source_topic');
        expect(readProtobufString(resultBytes, 8)).toBe('/db/dest_table');
        expect(readProtobufString(resultBytes, 9)).toBe('$lambda = ($msg) -> { return $msg; };');
        expect(readProtobufString(resultBytes, 10)).toBe('my-consumer');
    });

    it('extracts connectionString from sourceConfig (field 2, sub-field 6)', () => {
        const sourceConfig = buildMessage([sf(6, 'grpc://external-ydb:2135')]);
        const resultBytes = buildMessage([mf(2, sourceConfig)]);
        const configBytes = readProtobufField(resultBytes, 2);
        expect(configBytes).toBeDefined();
        const cs = readProtobufString(configBytes!, 6);
        expect(cs).toBe('grpc://external-ydb:2135');
    });

    it('handles unknown state (none of fields 3-6)', () => {
        const resultBytes = buildMessage([sf(7, '/db/topic')]);
        // None of fields 3-6 present
        expect(readProtobufField(resultBytes, 3)).toBeUndefined();
        expect(readProtobufField(resultBytes, 4)).toBeUndefined();
        expect(readProtobufField(resultBytes, 5)).toBeUndefined();
        expect(readProtobufField(resultBytes, 6)).toBeUndefined();
    });

    it('handles missing optional fields (backward compat)', () => {
        const resultBytes = buildMessage([mf(3, buildMessage([]))]);
        expect(readProtobufString(resultBytes, 7)).toBeUndefined();
        expect(readProtobufString(resultBytes, 8)).toBeUndefined();
        expect(readProtobufString(resultBytes, 9)).toBeUndefined();
        expect(readProtobufString(resultBytes, 10)).toBeUndefined();
    });
});

describe('describeExternalTable parsing', () => {
    it('extracts all fields', () => {
        const resultBytes = buildMessage([
            sf(2, 'ObjectStorage'),
            sf(3, '/db/my_datasource'),
            sf(4, 'path/to/data.csv'),
        ]);
        expect(readProtobufString(resultBytes, 2)).toBe('ObjectStorage');
        expect(readProtobufString(resultBytes, 3)).toBe('/db/my_datasource');
        expect(readProtobufString(resultBytes, 4)).toBe('path/to/data.csv');
    });

    it('extracts content map entries (repeated field 6)', () => {
        const entry1 = buildMessage([sf(1, 'FORMAT'), sf(2, '["csv_with_names"]')]);
        const entry2 = buildMessage([sf(1, 'COMPRESSION'), sf(2, '["gzip"]')]);
        const resultBytes = buildMessage([
            sf(2, 'ObjectStorage'),
            mf(6, entry1),
            mf(6, entry2),
        ]);
        const entries = readAllProtobufFields(resultBytes, 6);
        expect(entries).toHaveLength(2);

        const contentMap: Record<string, string> = {};
        for (const entry of entries) {
            const key = readProtobufString(entry, 1);
            const value = readProtobufString(entry, 2);
            if (key) { contentMap[key] = value ?? ''; }
        }
        expect(contentMap['FORMAT']).toBe('["csv_with_names"]');
        expect(contentMap['COMPRESSION']).toBe('["gzip"]');
    });

    it('extracts column entries (repeated field 5)', () => {
        const col1 = buildMessage([sf(1, 'id')]);
        const col2 = buildMessage([sf(1, 'name')]);
        const resultBytes = buildMessage([
            mf(5, col1),
            mf(5, col2),
        ]);
        const columns = readAllProtobufFields(resultBytes, 5);
        expect(columns).toHaveLength(2);
        expect(readProtobufString(columns[0], 1)).toBe('id');
        expect(readProtobufString(columns[1], 1)).toBe('name');
    });

    it('handles missing optional fields', () => {
        const resultBytes = buildMessage([]);
        expect(readProtobufString(resultBytes, 2)).toBeUndefined();
        expect(readProtobufString(resultBytes, 3)).toBeUndefined();
        expect(readProtobufString(resultBytes, 4)).toBeUndefined();
    });
});
