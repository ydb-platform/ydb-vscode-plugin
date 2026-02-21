// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'node_modules', 'monaco-editor', 'min', 'vs');
const dest = path.join(__dirname, '..', 'out', 'monaco', 'vs');

function copyDir(srcDir, destDir) {
    if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
    }
    const entries = fs.readdirSync(srcDir, { withFileTypes: true });
    for (const entry of entries) {
        const srcPath = path.join(srcDir, entry.name);
        const destPath = path.join(destDir, entry.name);
        if (entry.isDirectory()) {
            copyDir(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

copyDir(src, dest);
console.log('Monaco files copied to out/monaco/vs');
