// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

// Clean stale tsc output, keeping out/monaco (webview assets)
const outDir = path.join(__dirname, '..', 'out');
if (fs.existsSync(outDir)) {
    for (const entry of fs.readdirSync(outDir)) {
        if (entry === 'monaco') continue;
        const full = path.join(outDir, entry);
        fs.rmSync(full, { recursive: true, force: true });
    }
}

esbuild.build({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'out/extension.js',
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    sourcemap: true,
}).then(() => {
    console.log('Extension bundled to out/extension.js');
}).catch(() => process.exit(1));
