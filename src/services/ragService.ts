import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import * as zlib from 'zlib';
import type { Driver } from '@ydbjs/core';
import { parseYdbVersion } from '../utils/versionParser';

const S3_BASE = 'https://storage.yandexcloud.net';
const S3_BUCKET = 'ydb-utilities';
const S3_PREFIX = 'yql-rag/';

export interface RagItem {
    id: string;
    metadata: { text: string; source?: string; lang?: string; title?: string };
    vector: number[];
}

export interface RagIndex {
    version: number;
    distanceFunction: 'cosine';
    dimensions: number;
    items: RagItem[];
}

/**
 * Queries YDB version string from .sys/nodes system view.
 * Returns undefined if not accessible (older versions, permissions, etc.)
 */
export async function queryYdbVersion(driver: Driver): Promise<string | undefined> {
    try {
        // Import dynamically to avoid circular deps
        const { QueryService } = await import('./queryService.js');
        const qs = new QueryService(driver);
        const result = await qs.executeQuery('SELECT version()');
        if (result.rows.length > 0) {
            const row = result.rows[0];
            const key = result.columns[0]?.name ?? Object.keys(row)[0];
            if (key !== undefined) {
                const raw: unknown = row[key];
                return typeof raw === 'string' ? raw : String(raw);
            }
        }
    } catch {
        // .sys/nodes may not be accessible — not an error
    }
    return undefined;
}

/**
 * Converts a raw YDB version string to a local cache file suffix.
 * "stable-24-3-1"   → "24.3.1"
 * "stable-24-3"     → "24.3"
 * non-stable builds → the raw string
 */
export function versionToCacheSuffix(rawVersion: string): string {
    const parsed = parseYdbVersion(rawVersion);
    if (!parsed || !parsed.isStable) {
        return rawVersion.replace(/[^a-z0-9.]/gi, '-');
    }
    // Extract hotfix number if present
    const parts = rawVersion.replace(/^stable-/, '').split('-');
    if (parts.length >= 3) {
        return `${parts[0]}.${parts[1]}.${parts[2]}`;
    }
    return `${parts[0]}.${parts[1]}`;
}

/**
 * Downloads content from an HTTPS URL and returns it as a Buffer.
 */
function httpsGet(url: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const req = https.get(url, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                const location = res.headers.location;
                if (location) {
                    httpsGet(location).then(resolve, reject);
                    return;
                }
            }
            if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode} for ${url}`));
                res.resume();
                return;
            }
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(30_000, () => { req.destroy(); reject(new Error('Request timeout')); });
    });
}

/**
 * Parses the XML response from S3 ListObjects into directory names.
 * Exported for testing.
 */
export function parseS3ListingXml(xml: string): string[] {
    const dirs: string[] = [];
    const re = /<Prefix>([^<]+)<\/Prefix>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) {
        const prefix = m[1];
        if (prefix === S3_PREFIX) continue;
        if (prefix.startsWith(S3_PREFIX)) {
            const dir = prefix.slice(S3_PREFIX.length).replace(/\/$/, '');
            if (dir) dirs.push(dir);
        }
    }
    return dirs;
}

/**
 * Parses S3 ListObjects XML to find object keys (files, no delimiter).
 * Exported for testing.
 */
export function parseS3ObjectKeys(xml: string): string[] {
    const keys: string[] = [];
    const re = /<Key>([^<]+)<\/Key>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) {
        keys.push(m[1]);
    }
    return keys;
}

/**
 * Lists available RAG version directories in S3.
 * Returns directory names like ["stable-24-3", "stable-24", "default"].
 */
export async function listS3Dirs(): Promise<string[]> {
    const url = `${S3_BASE}/${S3_BUCKET}?prefix=${encodeURIComponent(S3_PREFIX)}&delimiter=/`;
    const xml = (await httpsGet(url)).toString('utf-8');
    return parseS3ListingXml(xml);
}

/**
 * Finds the best matching S3 directory for a given YDB version string.
 * Match priority: <prefix>-<major>-<minor> → <prefix>-<major> → default
 */
export function findBestS3Dir(ydbVersion: string, s3Dirs: string[]): string | null {
    const parsed = parseYdbVersion(ydbVersion);

    if (parsed?.isStable) {
        const exactDir = `stable-${parsed.major}-${parsed.minor}`;
        if (s3Dirs.includes(exactDir)) return exactDir;

        const majorDir = `stable-${parsed.major}`;
        if (s3Dirs.includes(majorDir)) return majorDir;
    }

    if (s3Dirs.includes('default')) return 'default';
    return null;
}

/**
 * Manages the local RAG index cache and provides search over it.
 */
export class RagService {
    private readonly cacheDir: string;
    /** In-memory cache of loaded indexes keyed by absolute file path */
    private indexCache = new Map<string, RagIndex>();
    /** Whether RAG is enabled (MCP tool will use it). Auto-enabled if cache exists. */
    private _enabled: boolean;

    constructor(cacheDir: string) {
        this.cacheDir = cacheDir;
        this._enabled = !!this.findAnyCachedFile();
    }

    get isEnabled(): boolean { return this._enabled; }

    /** RAG is "running" when it is enabled AND has a cached index on disk. */
    get isRunning(): boolean { return this._enabled && !!this.findAnyCachedFile(); }

    enable(): void { this._enabled = true; }
    disable(): void { this._enabled = false; }

    /** Frees the in-memory index cache (disk cache is preserved). */
    unloadFromMemory(): void { this.indexCache.clear(); }

    /**
     * Returns the absolute path for a cached RAG file for a given YDB version.
     * Format: <cacheDir>/index-<x>.<y>.<z>.json.gz
     */
    getCacheFilePath(rawVersion: string): string {
        const suffix = versionToCacheSuffix(rawVersion);
        return path.join(this.cacheDir, `index-${suffix}.json.gz`);
    }

    isCached(rawVersion: string): boolean {
        return fs.existsSync(this.getCacheFilePath(rawVersion));
    }

    /**
     * Downloads the RAG index from S3 and writes it to the local cache.
     * @param s3Dir   Matched S3 directory name (e.g. "stable-24-3")
     * @param rawVersion  Full YDB version string (used for local filename)
     * @param onProgress  Optional progress callback
     * @returns Absolute path to the cached file
     */
    async downloadRag(
        s3Dir: string,
        rawVersion: string,
        onProgress?: (msg: string) => void,
    ): Promise<string> {
        // Find index file name by listing the directory (it can be index-0.0.1.json.gz, index-0.0.2.json.gz, etc.)
        const listUrl = `${S3_BASE}/${S3_BUCKET}?prefix=${encodeURIComponent(S3_PREFIX + s3Dir + '/')}`;
        const listXml = (await httpsGet(listUrl)).toString('utf-8');
        const keys = parseS3ObjectKeys(listXml);
        const indexKey = keys.find(k => {
            const filename = k.split('/').pop() ?? '';
            return filename.startsWith('index-') && filename.endsWith('.json.gz');
        });
        if (!indexKey) {
            throw new Error(`No index-*.json.gz file found in S3 directory "${s3Dir}"`);
        }
        const url = `${S3_BASE}/${S3_BUCKET}/${indexKey}`;
        onProgress?.(`Downloading RAG from ${url}...`);

        const data = await httpsGet(url);

        const destPath = this.getCacheFilePath(rawVersion);
        fs.mkdirSync(this.cacheDir, { recursive: true });
        fs.writeFileSync(destPath, data);

        // Invalidate in-memory cache so the new file will be re-read
        this.indexCache.delete(destPath);
        onProgress?.(`Saved to ${destPath} (${(data.length / 1024).toFixed(1)} KB)`);
        return destPath;
    }

    /**
     * Loads and decompresses a RAG index from a local .json.gz file.
     * Results are cached in memory.
     */
    async loadIndex(filePath: string): Promise<RagIndex> {
        const cached = this.indexCache.get(filePath);
        if (cached) return cached;

        const compressed = fs.readFileSync(filePath);
        const json = await new Promise<string>((resolve, reject) => {
            zlib.gunzip(compressed, (err, buf) => {
                if (err) reject(err); else resolve(buf.toString('utf-8'));
            });
        });

        const index = JSON.parse(json) as RagIndex;
        this.indexCache.set(filePath, index);
        return index;
    }

    /**
     * Finds the first cached RAG file (any version).
     * Useful as a fallback when the exact version is unknown.
     */
    findAnyCachedFile(): string | undefined {
        if (!fs.existsSync(this.cacheDir)) return undefined;
        const files = fs.readdirSync(this.cacheDir)
            .filter(f => f.startsWith('index-') && f.endsWith('.json.gz'));
        return files.length > 0 ? path.join(this.cacheDir, files[0]) : undefined;
    }

    // -------------------------------------------------------------------------
    // Search
    // -------------------------------------------------------------------------

    /**
     * Searches the RAG index using keyword matching.
     * Returns texts of the top-K most relevant chunks.
     */
    keywordSearch(query: string, index: RagIndex, topK: number): string[] {
        const words = query.toLowerCase().split(/\s+/).filter(Boolean);
        if (words.length === 0 || index.items.length === 0) return [];

        const scored = index.items.map(item => {
            const text = item.metadata.text.toLowerCase();
            const score = words.reduce((s, w) => {
                const count = (text.split(w).length - 1);
                return s + count;
            }, 0);
            return { text: item.metadata.text, score };
        });

        return scored
            .filter(s => s.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, topK)
            .map(s => s.text);
    }

    private cosineSimilarity(a: number[], b: number[]): number {
        let dot = 0, na = 0, nb = 0;
        for (let i = 0; i < a.length; i++) {
            dot += a[i] * b[i];
            na += a[i] * a[i];
            nb += b[i] * b[i];
        }
        const denom = Math.sqrt(na) * Math.sqrt(nb);
        return denom === 0 ? 0 : dot / denom;
    }

    /**
     * Searches using vector cosine similarity.
     * @param queryVector  Embedding vector for the query (same model used during indexing)
     */
    vectorSearch(queryVector: number[], index: RagIndex, topK: number): string[] {
        return index.items
            .map(item => ({ text: item.metadata.text, score: this.cosineSimilarity(queryVector, item.vector) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, topK)
            .map(s => s.text);
    }

    /**
     * High-level search: tries Ollama vector search, falls back to keyword search.
     * Returns results and the method actually used.
     * @param query       Natural language query
     * @param filePath    Path to the cached .json.gz index
     * @param ollamaUrl   Optional Ollama base URL (e.g. "http://localhost:11434")
     * @param model       Ollama model name (must match the model used during indexing)
     */
    async search(
        query: string,
        filePath: string,
        topK: number,
        ollamaUrl?: string,
        model = 'nomic-embed-text',
    ): Promise<{ results: string[]; method: 'vector' | 'keyword' }> {
        const index = await this.loadIndex(filePath);

        if (ollamaUrl) {
            try {
                const vec = await getOllamaEmbedding(query, ollamaUrl, model);
                return { results: this.vectorSearch(vec, index, topK), method: 'vector' };
            } catch {
                // Ollama unavailable — fall through to keyword search
            }
        }

        return { results: this.keywordSearch(query, index, topK), method: 'keyword' };
    }
}

// -------------------------------------------------------------------------
// Ollama helpers (optional)
// -------------------------------------------------------------------------

/**
 * Checks whether an Ollama instance is reachable at the given base URL.
 * Performs a quick GET / with a 3 s timeout.
 */
export function checkOllamaAvailable(baseUrl: string): Promise<boolean> {
    return new Promise((resolve) => {
        try {
            const url = new URL('/', baseUrl);
            const transport = url.protocol === 'https:' ? https : http;
            const req = transport.get(url.toString(), (res) => {
                res.resume();
                resolve(res.statusCode === 200);
            });
            req.on('error', () => resolve(false));
            req.setTimeout(3000, () => { req.destroy(); resolve(false); });
        } catch {
            resolve(false);
        }
    });
}

export async function getOllamaEmbedding(
    text: string,
    baseUrl: string,
    model: string,
): Promise<number[]> {
    const data = JSON.stringify({ model, prompt: text });
    return new Promise((resolve, reject) => {
        const url = new URL('/api/embeddings', baseUrl);
        const transport = url.protocol === 'https:' ? https : http;
        const req = transport.request(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    reject(new Error(`Ollama HTTP ${res.statusCode}`));
                    return;
                }
                try {
                    const json = JSON.parse(Buffer.concat(chunks).toString()) as { embedding: number[] };
                    resolve(json.embedding);
                } catch (e) {
                    reject(e);
                }
            });
            res.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(10_000, () => { req.destroy(); reject(new Error('Ollama timeout')); });
        req.write(data);
        req.end();
    });
}

/**
 * Convenience: detect YDB version, find matching S3 dir, download if needed.
 * @param driver      Connected driver (will NOT be closed by this function)
 * @param ragService  RagService instance
 * @param force       Re-download even if already cached
 * @param onProgress  Optional progress callback
 * @returns  { version, s3Dir, cachePath } or throws
 */
export async function detectAndEnsureRag(
    driver: Driver,
    ragService: RagService,
    force: boolean,
    onProgress?: (msg: string) => void,
): Promise<{ version: string; s3Dir: string; cachePath: string }> {
    onProgress?.('Detecting YDB version...');
    const rawVersion = await queryYdbVersion(driver);
    if (!rawVersion) {
        throw new Error('Could not detect YDB version from .sys/nodes');
    }
    onProgress?.(`YDB version: ${rawVersion}`);

    onProgress?.('Listing available RAG versions in S3...');
    const dirs = await listS3Dirs();
    if (dirs.length === 0) {
        throw new Error('No RAG versions found in S3 bucket');
    }

    const s3Dir = findBestS3Dir(rawVersion, dirs);
    if (!s3Dir) {
        throw new Error(
            `No matching RAG found for version "${rawVersion}". Available: ${dirs.join(', ')}`,
        );
    }
    onProgress?.(`Matched S3 directory: ${s3Dir}`);

    const cachePath = ragService.getCacheFilePath(rawVersion);
    if (!force && ragService.isCached(rawVersion)) {
        onProgress?.(`Using cached RAG: ${cachePath}`);
        return { version: rawVersion, s3Dir, cachePath };
    }

    const finalPath = await ragService.downloadRag(s3Dir, rawVersion, onProgress);
    return { version: rawVersion, s3Dir, cachePath: finalPath };
}
