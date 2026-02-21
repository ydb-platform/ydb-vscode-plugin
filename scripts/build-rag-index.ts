#!/usr/bin/env npx ts-node
/**
 * Builds a Vectra RAG index from YDB documentation.
 *
 * Usage:
 *   npx ts-node scripts/build-rag-index.ts <path-to-ydb-repo> [options]
 *
 * Options:
 *   --lang en|ru|both   Language(s) to index (default: en)
 *   --model <name>      Ollama embedding model (default: nomic-embed-text)
 *   --ollama <url>      Ollama base URL (default: http://localhost:11434)
 *   --output <path>     Output directory for the index (default: ./assets/yql-rag)
 *   --chunk-size <n>    Target chunk size in characters (default: 1500)
 *   --chunk-overlap <n> Overlap between chunks in characters (default: 200)
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === '--help') {
    console.log(`Usage: npx ts-node scripts/build-rag-index.ts <ydb-repo-path> [options]

Options:
  --lang en|ru|both   Language(s) to index (default: en)
  --model <name>      Ollama model (default: nomic-embed-text)
  --ollama <url>      Ollama base URL (default: http://localhost:11434)
  --output <path>     Output path for the index (default: ./assets/yql-rag)
  --chunk-size <n>    Characters per chunk (default: 1500)
  --chunk-overlap <n> Overlap characters (default: 200)
`);
    process.exit(0);
}

const repoPath = args[0];

function getArg(name: string, def: string): string {
    const i = args.indexOf(name);
    return i !== -1 && args[i + 1] ? args[i + 1] : def;
}

const lang = getArg('--lang', 'en');
const ollamaModel = getArg('--model', 'nomic-embed-text');
const ollamaUrl = getArg('--ollama', 'http://localhost:11434');
const outputDir = getArg('--output', path.join(process.cwd(), 'assets', 'yql-rag'));
const chunkSize = parseInt(getArg('--chunk-size', '1500'), 10);
const chunkOverlap = parseInt(getArg('--chunk-overlap', '200'), 10);

// ---------------------------------------------------------------------------
// Find docs directory
// ---------------------------------------------------------------------------

function findDocsDir(base: string): string {
    // Canonical location: <repo>/ydb/docs
    const candidate = path.join(base, 'ydb', 'docs');
    if (fs.existsSync(candidate)) {
        return candidate;
    }
    // Fallback: search up to 3 levels deep for a "docs" dir containing "en" or "ru"
    const found = findDirRecursive(base, 'docs', 3);
    if (found) return found;
    throw new Error(`Cannot find docs directory under ${base}`);
}

function findDirRecursive(base: string, name: string, depth: number): string | null {
    if (depth === 0) return null;
    try {
        const entries = fs.readdirSync(base, { withFileTypes: true });
        for (const e of entries) {
            if (e.isDirectory() && e.name === name) {
                const full = path.join(base, e.name);
                const sub = fs.readdirSync(full).filter(n => n === 'en' || n === 'ru');
                if (sub.length > 0) return full;
            }
        }
        for (const e of entries) {
            if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
                const result = findDirRecursive(path.join(base, e.name), name, depth - 1);
                if (result) return result;
            }
        }
    } catch {
        // ignore permission errors
    }
    return null;
}

// ---------------------------------------------------------------------------
// Collect markdown files
// ---------------------------------------------------------------------------

function collectMarkdownFiles(docsDir: string, languages: string[]): string[] {
    const files: string[] = [];
    for (const l of languages) {
        const yqlDir = path.join(docsDir, l, 'core', 'yql');
        if (!fs.existsSync(yqlDir)) {
            console.warn(`Warning: YQL docs not found for language "${l}" at ${yqlDir}`);
            continue;
        }
        collectMdRecursive(yqlDir, files);
    }
    return files;
}

function collectMdRecursive(dir: string, result: string[]): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            // Skip _includes — these are fragments included into other files
            if (e.name === '_includes' || e.name === '_assets') continue;
            collectMdRecursive(full, result);
        } else if (e.isFile() && e.name.endsWith('.md')) {
            result.push(full);
        }
    }
}

// ---------------------------------------------------------------------------
// Markdown cleaning and chunking
// ---------------------------------------------------------------------------

function cleanMarkdown(content: string): string {
    // Remove YAML frontmatter
    content = content.replace(/^---[\s\S]*?---\n/, '');
    // Remove Yandex Docs template conditionals {% if ... %} ... {% endif %}
    content = content.replace(/\{%[^%]*%\}/g, '');
    // Remove HTML comments
    content = content.replace(/<!--[\s\S]*?-->/g, '');
    // Remove image references ![](...) and [...](...) links keeping text
    content = content.replace(/!\[([^\]]*)\]\([^)]*\)/g, '');
    content = content.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
    // Collapse excessive blank lines
    content = content.replace(/\n{3,}/g, '\n\n');
    return content.trim();
}

/**
 * Force-cut text into chunks of at most `size` chars.
 * Tries paragraph boundaries first, falls back to character splitting.
 */
function hardSplit(text: string, size: number, overlap: number): string[] {
    if (text.length <= size) return [text];

    const result: string[] = [];
    const paragraphs = text.split(/\n\n+/);
    let buffer = '';

    const flush = () => {
        const t = buffer.trim();
        if (t) result.push(t);
        buffer = '';
    };

    for (const p of paragraphs) {
        if (p.length > size) {
            // Paragraph itself is too large — flush buffer then force-cut by chars
            flush();
            let pos = 0;
            while (pos < p.length) {
                result.push(p.slice(pos, pos + size).trim());
                pos += size - overlap;
            }
        } else if (buffer.length + 2 + p.length <= size) {
            buffer = buffer ? buffer + '\n\n' + p : p;
        } else {
            flush();
            buffer = p;
        }
    }
    flush();
    return result;
}

function chunkText(text: string, title: string, size: number, overlap: number): string[] {
    if (text.length <= size) return [text];

    const chunks: string[] = [];
    // Split on heading boundaries first
    const headingSections = text.split(/(?=^#{1,3} )/m);

    for (const section of headingSections) {
        if (section.length > size) {
            // Section is too large on its own — hard-split it
            chunks.push(...hardSplit(section.trim(), size, overlap));
        } else if (
            chunks.length > 0 &&
            chunks[chunks.length - 1].length + 2 + section.length <= size
        ) {
            // Merge with previous chunk
            chunks[chunks.length - 1] += '\n\n' + section;
        } else {
            chunks.push(section.trim());
        }
    }

    // Prepend title to continuation chunks so context is preserved
    return chunks
        .filter(c => c.length > 0)
        .map((c, i) => (i === 0 ? c : `# ${title} (continued)\n\n${c}`));
}

// ---------------------------------------------------------------------------
// Ollama embedding
// ---------------------------------------------------------------------------

async function getEmbeddingRaw(text: string): Promise<number[]> {
    const url = `${ollamaUrl}/api/embeddings`;
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: ollamaModel, prompt: text }),
    });
    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Ollama error ${response.status}: ${err}`);
    }
    const json = await response.json() as { embedding: number[] };
    return json.embedding;
}

async function getEmbedding(text: string): Promise<number[]> {
    let current = text;
    while (true) {
        try {
            return await getEmbeddingRaw(current);
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            if (msg.includes('context length') || msg.includes('input length')) {
                // Truncate by 20% and retry
                current = current.slice(0, Math.floor(current.length * 0.8));
                if (current.length < 50) throw e;
                process.stdout.write(' [truncated]');
            } else {
                throw e;
            }
        }
    }
}

async function checkOllama(): Promise<void> {
    try {
        const res = await fetch(`${ollamaUrl}/api/tags`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as { models: { name: string }[] };
        const names = data.models.map(m => m.name);
        const hasModel = names.some(n => n.startsWith(ollamaModel));
        if (!hasModel) {
            console.warn(`Warning: model "${ollamaModel}" not found in Ollama.`);
            console.warn(`Available: ${names.join(', ')}`);
            console.warn(`Pull with: ollama pull ${ollamaModel}`);
        } else {
            console.log(`Ollama OK, using model: ${ollamaModel}`);
        }
    } catch (e) {
        throw new Error(
            `Cannot connect to Ollama at ${ollamaUrl}. Start it with: ollama serve\n${e}`
        );
    }
}

// ---------------------------------------------------------------------------
// Vectra-compatible index format
// ---------------------------------------------------------------------------

interface VectraItem {
    id: string;
    metadata: {
        text: string;
        source: string;
        lang: string;
        title: string;
        chunkIndex: number;
    };
    vector: number[];
}

interface VectraIndex {
    version: number;
    distanceFunction: 'cosine';
    dimensions: number;
    items: VectraItem[];
}

function makeId(): string {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    // Validate repo path
    if (!fs.existsSync(repoPath)) {
        console.error(`Error: path does not exist: ${repoPath}`);
        process.exit(1);
    }

    console.log(`YDB repo: ${repoPath}`);

    // Check Ollama
    await checkOllama();

    // Find docs
    const docsDir = findDocsDir(repoPath);
    console.log(`Docs directory: ${docsDir}`);

    // Determine languages
    const languages = lang === 'both' ? ['en', 'ru'] : [lang];

    // Collect files
    const files = collectMarkdownFiles(docsDir, languages);
    console.log(`Found ${files.length} markdown files`);

    if (files.length === 0) {
        console.error('No markdown files found. Check repo path and language.');
        process.exit(1);
    }

    // Process files → chunks
    type ChunkMeta = { text: string; source: string; lang: string; title: string; chunkIndex: number };
    const allChunks: ChunkMeta[] = [];

    for (const file of files) {
        const raw = fs.readFileSync(file, 'utf-8');
        const cleaned = cleanMarkdown(raw);
        if (cleaned.length < 50) continue; // skip near-empty files

        // Extract title from first heading
        const titleMatch = cleaned.match(/^#+ (.+)/m);
        const title = titleMatch ? titleMatch[1].trim() : path.basename(file, '.md');

        // Detect language from path
        const fileLang = file.includes('/en/') ? 'en' : 'ru';

        // Relative source path for display
        const source = path.relative(repoPath, file);

        const chunks = chunkText(cleaned, title, chunkSize, chunkOverlap);
        chunks.forEach((text, i) => {
            allChunks.push({ text, source, lang: fileLang, title, chunkIndex: i });
        });
    }

    console.log(`Total chunks: ${allChunks.length}`);

    // Ensure output directory exists
    fs.mkdirSync(outputDir, { recursive: true });

    // Embed chunks
    const items: VectraItem[] = [];
    let dimensions = 0;
    let errors = 0;

    for (let i = 0; i < allChunks.length; i++) {
        const chunk = allChunks[i];
        process.stdout.write(`\rEmbedding ${i + 1}/${allChunks.length} ...`);

        try {
            const vector = await getEmbedding(chunk.text);
            if (dimensions === 0) dimensions = vector.length;
            items.push({
                id: makeId(),
                metadata: chunk,
                vector,
            });
        } catch (e) {
            errors++;
            console.error(`\nError embedding chunk ${i} (${chunk.source}): ${e}`);
            if (errors > 5) {
                console.error('Too many errors, aborting.');
                process.exit(1);
            }
        }
    }

    console.log(`\nEmbedded ${items.length} chunks, dimensions: ${dimensions}`);

    // Write Vectra index
    const index: VectraIndex = {
        version: 1,
        distanceFunction: 'cosine',
        dimensions,
        items,
    };

    const outputFile = path.join(outputDir, 'index.json');
    fs.writeFileSync(outputFile, JSON.stringify(index), 'utf-8');

    const sizeMb = (fs.statSync(outputFile).size / 1024 / 1024).toFixed(2);
    console.log(`Index written: ${outputFile} (${sizeMb} MB)`);

    if (errors > 0) {
        console.warn(`Completed with ${errors} errors.`);
    } else {
        console.log('Done.');
    }
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
