import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as zlib from 'zlib';
import { RagService, findBestS3Dir, versionToCacheSuffix, parseS3ListingXml, parseS3ObjectKeys } from '../../services/ragService';

// ---------------------------------------------------------------------------
// versionToCacheSuffix
// ---------------------------------------------------------------------------

describe('versionToCacheSuffix', () => {
    it('stable-24-3-1 → 24.3.1', () => {
        expect(versionToCacheSuffix('stable-24-3-1')).toBe('24.3.1');
    });

    it('stable-24-3 → 24.3', () => {
        expect(versionToCacheSuffix('stable-24-3')).toBe('24.3');
    });

    it('stable-25-4-2 → 25.4.2', () => {
        expect(versionToCacheSuffix('stable-25-4-2')).toBe('25.4.2');
    });

    it('non-stable build → sanitized string', () => {
        const result = versionToCacheSuffix('main');
        expect(result).toBe('main');
    });
});

// ---------------------------------------------------------------------------
// findBestS3Dir
// ---------------------------------------------------------------------------

describe('findBestS3Dir', () => {
    const dirs = ['stable-24-3', 'stable-24', 'stable-25-4', 'default'];

    it('matches exact major.minor', () => {
        expect(findBestS3Dir('stable-24-3-1', dirs)).toBe('stable-24-3');
    });

    it('falls back to major-only when minor dir missing', () => {
        expect(findBestS3Dir('stable-24-7-0', dirs)).toBe('stable-24');
    });

    it('falls back to default when no match', () => {
        expect(findBestS3Dir('stable-23-1-0', dirs)).toBe('default');
    });

    it('returns null when dirs are empty', () => {
        expect(findBestS3Dir('stable-24-3-1', [])).toBeNull();
    });

    it('non-stable build goes to default', () => {
        expect(findBestS3Dir('main', dirs)).toBe('default');
    });

    it('prefers exact match over major-only', () => {
        expect(findBestS3Dir('stable-24-3-5', dirs)).toBe('stable-24-3');
    });
});

// ---------------------------------------------------------------------------
// RagService cache paths
// ---------------------------------------------------------------------------

describe('RagService getCacheFilePath', () => {
    it('returns correct path', () => {
        const svc = new RagService('/tmp/rag');
        expect(svc.getCacheFilePath('stable-24-3-1')).toBe(
            path.join('/tmp/rag', 'index-24.3.1.json.gz'),
        );
    });

    it('isCached returns false when file missing', () => {
        const svc = new RagService('/tmp/nonexistent-rag-' + Date.now());
        expect(svc.isCached('stable-24-3-1')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// RagService keywordSearch
// ---------------------------------------------------------------------------

describe('RagService keywordSearch', () => {
    const index = {
        version: 1,
        distanceFunction: 'cosine' as const,
        dimensions: 3,
        items: [
            { id: '1', metadata: { text: 'SELECT * FROM table WHERE id = 1', title: 'SELECT' }, vector: [1, 0, 0] },
            { id: '2', metadata: { text: 'INSERT INTO table VALUES (1, 2)', title: 'INSERT' }, vector: [0, 1, 0] },
            { id: '3', metadata: { text: 'SELECT col FROM t JOIN other ON t.id = other.id', title: 'JOIN' }, vector: [0, 0, 1] },
        ],
    };

    const svc = new RagService('/tmp');

    it('returns matching chunks sorted by score', () => {
        const results = svc.keywordSearch('SELECT', index, 2);
        expect(results).toHaveLength(2);
        // Both SELECT chunks should appear; the one with 2 occurrences ranks first
        expect(results[0]).toContain('SELECT');
    });

    it('returns empty when no matches', () => {
        const results = svc.keywordSearch('PRAGMA', index, 3);
        expect(results).toHaveLength(0);
    });

    it('respects topK', () => {
        const results = svc.keywordSearch('table', index, 1);
        expect(results).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// RagService loadIndex (gzipped JSON)
// ---------------------------------------------------------------------------

describe('RagService loadIndex', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-test-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('loads and decompresses a valid index', async () => {
        const index = {
            version: 1,
            distanceFunction: 'cosine',
            dimensions: 3,
            items: [
                { id: 'a', metadata: { text: 'hello world', title: 'test' }, vector: [1, 0, 0] },
            ],
        };
        const json = JSON.stringify(index);
        const gz = zlib.gzipSync(Buffer.from(json, 'utf-8'));
        const filePath = path.join(tmpDir, 'index-24.3.json.gz');
        fs.writeFileSync(filePath, gz);

        const svc = new RagService(tmpDir);
        const loaded = await svc.loadIndex(filePath);

        expect(loaded.items).toHaveLength(1);
        expect(loaded.items[0].metadata.text).toBe('hello world');
    });

    it('caches index in memory after first load', async () => {
        const index = { version: 1, distanceFunction: 'cosine', dimensions: 1, items: [] };
        const gz = zlib.gzipSync(Buffer.from(JSON.stringify(index)));
        const filePath = path.join(tmpDir, 'index-24.3.json.gz');
        fs.writeFileSync(filePath, gz);

        const svc = new RagService(tmpDir);
        const first = await svc.loadIndex(filePath);
        const second = await svc.loadIndex(filePath);
        expect(first).toBe(second); // same reference
    });
});

// ---------------------------------------------------------------------------
// RagService findAnyCachedFile
// ---------------------------------------------------------------------------

describe('RagService findAnyCachedFile', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-test-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns undefined when dir is empty', () => {
        const svc = new RagService(tmpDir);
        expect(svc.findAnyCachedFile()).toBeUndefined();
    });

    it('returns path when a file exists', () => {
        fs.writeFileSync(path.join(tmpDir, 'index-24.3.json.gz'), '');
        const svc = new RagService(tmpDir);
        expect(svc.findAnyCachedFile()).toBe(path.join(tmpDir, 'index-24.3.json.gz'));
    });
});

// ---------------------------------------------------------------------------
// RagService enable/disable/isRunning
// ---------------------------------------------------------------------------

describe('RagService enable/disable/isRunning', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-test-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('isEnabled=false and isRunning=false when cache is empty', () => {
        const svc = new RagService(tmpDir);
        expect(svc.isEnabled).toBe(false);
        expect(svc.isRunning).toBe(false);
    });

    it('isEnabled=true and isRunning=true when cache file exists', () => {
        fs.writeFileSync(path.join(tmpDir, 'index-24.3.json.gz'), '');
        const svc = new RagService(tmpDir);
        expect(svc.isEnabled).toBe(true);
        expect(svc.isRunning).toBe(true);
    });

    it('disable() stops isEnabled and isRunning', () => {
        fs.writeFileSync(path.join(tmpDir, 'index-24.3.json.gz'), '');
        const svc = new RagService(tmpDir);
        svc.disable();
        expect(svc.isEnabled).toBe(false);
        expect(svc.isRunning).toBe(false);
    });

    it('enable() after disable() restores isEnabled and isRunning', () => {
        fs.writeFileSync(path.join(tmpDir, 'index-24.3.json.gz'), '');
        const svc = new RagService(tmpDir);
        svc.disable();
        svc.enable();
        expect(svc.isEnabled).toBe(true);
        expect(svc.isRunning).toBe(true);
    });

    it('isRunning=false when enabled but no cache file', () => {
        const svc = new RagService(tmpDir);
        svc.enable();
        expect(svc.isEnabled).toBe(true);
        expect(svc.isRunning).toBe(false);
    });

    it('unloadFromMemory() preserves disk files and isRunning state', async () => {
        const index = { version: 1, distanceFunction: 'cosine' as const, dimensions: 1, items: [] };
        const gz = zlib.gzipSync(Buffer.from(JSON.stringify(index)));
        const filePath = path.join(tmpDir, 'index-24.3.json.gz');
        fs.writeFileSync(filePath, gz);

        const svc = new RagService(tmpDir);
        await svc.loadIndex(filePath); // populate in-memory cache

        svc.unloadFromMemory();

        // File still on disk
        expect(fs.existsSync(filePath)).toBe(true);
        // isRunning still true (disk cache present, enabled)
        expect(svc.isRunning).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// parseS3ListingXml
// ---------------------------------------------------------------------------

describe('parseS3ListingXml', () => {
    it('extracts directory names from XML', () => {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Name>ydb-utilities</Name>
  <Prefix>yql-rag/</Prefix>
  <Delimiter>/</Delimiter>
  <CommonPrefixes><Prefix>yql-rag/stable-24-3/</Prefix></CommonPrefixes>
  <CommonPrefixes><Prefix>yql-rag/stable-24/</Prefix></CommonPrefixes>
  <CommonPrefixes><Prefix>yql-rag/default/</Prefix></CommonPrefixes>
</ListBucketResult>`;

        const dirs = parseS3ListingXml(xml);
        expect(dirs).toContain('stable-24-3');
        expect(dirs).toContain('stable-24');
        expect(dirs).toContain('default');
        expect(dirs).toHaveLength(3);
    });

    it('skips root prefix', () => {
        const xml = `<ListBucketResult>
  <Prefix>yql-rag/</Prefix>
  <CommonPrefixes><Prefix>yql-rag/</Prefix></CommonPrefixes>
  <CommonPrefixes><Prefix>yql-rag/default/</Prefix></CommonPrefixes>
</ListBucketResult>`;

        const dirs = parseS3ListingXml(xml);
        expect(dirs).toEqual(['default']);
    });

    it('returns empty for empty listing', () => {
        expect(parseS3ListingXml('<ListBucketResult></ListBucketResult>')).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// parseS3ObjectKeys
// ---------------------------------------------------------------------------

describe('parseS3ObjectKeys', () => {
    it('extracts object keys from XML', () => {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Contents><Key>yql-rag/default/index-0.0.1.json.gz</Key></Contents>
  <Contents><Key>yql-rag/default/readme.md</Key></Contents>
</ListBucketResult>`;

        const keys = parseS3ObjectKeys(xml);
        expect(keys).toContain('yql-rag/default/index-0.0.1.json.gz');
        expect(keys).toContain('yql-rag/default/readme.md');
        expect(keys).toHaveLength(2);
    });

    it('returns empty for no contents', () => {
        expect(parseS3ObjectKeys('<ListBucketResult></ListBucketResult>')).toEqual([]);
    });
});
