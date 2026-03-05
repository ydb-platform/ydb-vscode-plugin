// @ts-check
'use strict';

const esbuild = require('esbuild');

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
