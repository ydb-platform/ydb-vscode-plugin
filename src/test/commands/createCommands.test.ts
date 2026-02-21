import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const createCommandsPath = path.resolve(__dirname, '../../commands/createCommands.ts');
const sourceCode = fs.readFileSync(createCommandsPath, 'utf-8');

const extensionPath = path.resolve(__dirname, '../../extension.ts');
const extensionSource = fs.readFileSync(extensionPath, 'utf-8');

const packageJsonPath = path.resolve(__dirname, '../../../package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));

describe('createCommands templates', () => {
    const expectedKeys = [
        'rowTable', 'columnTable', 'topic', 'view',
        'extDsObjectStorage', 'extDsYdb',
        'extTableCsv', 'extTableJson', 'extTableParquet',
        'transfer', 'streamingQuery',
    ];

    it('has all 11 template keys', () => {
        for (const key of expectedKeys) {
            expect(sourceCode).toContain(`${key}:`);
        }
    });

    it('rowTable template contains CREATE TABLE and PRIMARY KEY', () => {
        expect(sourceCode).toContain('CREATE TABLE');
        expect(sourceCode).toContain('PRIMARY KEY');
    });

    it('columnTable template contains STORE = COLUMN', () => {
        expect(sourceCode).toContain('STORE = COLUMN');
    });

    it('topic template contains CREATE TOPIC and CONSUMER', () => {
        expect(sourceCode).toContain('CREATE TOPIC');
        expect(sourceCode).toContain('CONSUMER');
    });

    it('transfer template contains CREATE TRANSFER and USING', () => {
        expect(sourceCode).toContain('CREATE TRANSFER');
        expect(sourceCode).toContain('USING $transformation_lambda');
    });

    it('view template contains CREATE VIEW', () => {
        expect(sourceCode).toContain('CREATE VIEW');
    });

    it('templates have placeholder markers', () => {
        expect(sourceCode).toMatch(/<\w+>/);
        expect(sourceCode).toContain('<table_name>');
        expect(sourceCode).toContain('<topic_name>');
    });

    it('external data source templates contain SOURCE_TYPE', () => {
        expect(sourceCode).toContain('SOURCE_TYPE=\\"ObjectStorage\\"');
        expect(sourceCode).toContain('SOURCE_TYPE=\\"Ydb\\"');
    });

    it('external table templates contain FORMAT', () => {
        expect(sourceCode).toContain('FORMAT=\\"csv_with_names\\"');
        expect(sourceCode).toContain('FORMAT=\\"json_each_row\\"');
        expect(sourceCode).toContain('FORMAT=\\"parquet\\"');
    });

    it('streaming query template contains CREATE STREAMING QUERY', () => {
        expect(sourceCode).toContain('CREATE STREAMING QUERY');
    });
});

describe('createCommands registration in extension.ts', () => {
    it('imports registerCreateCommands', () => {
        expect(extensionSource).toContain("import { registerCreateCommands } from './commands/createCommands'");
    });

    it('calls registerCreateCommands(context)', () => {
        expect(extensionSource).toContain('registerCreateCommands(context)');
    });
});

describe('createCommands declared in package.json', () => {
    const commands: Array<{ command: string }> = packageJson.contributes.commands;
    const commandIds = commands.map((c) => c.command);

    const expectedCommands = [
        'ydb.createRowTable',
        'ydb.createColumnTable',
        'ydb.createTopic',
        'ydb.createView',
        'ydb.createExtDsObjectStorage',
        'ydb.createExtDsYdb',
        'ydb.createExtTableCsv',
        'ydb.createExtTableJson',
        'ydb.createExtTableParquet',
        'ydb.createTransfer',
        'ydb.createStreamingQuery',
    ];

    for (const cmd of expectedCommands) {
        it(`declares command ${cmd}`, () => {
            expect(commandIds).toContain(cmd);
        });
    }
});

describe('createCommands context menu entries in package.json', () => {
    const menuItems: Array<{ command: string; when: string }> =
        packageJson.contributes.menus['view/item/context'];

    function hasMenuEntry(command: string, contextValue: string): boolean {
        return menuItems.some(
            (item) => item.command === command && item.when.includes(contextValue),
        );
    }

    it('root-tables shows createRowTable', () => {
        expect(hasMenuEntry('ydb.createRowTable', 'root-tables')).toBe(true);
    });

    it('root-tables shows createColumnTable', () => {
        expect(hasMenuEntry('ydb.createColumnTable', 'root-tables')).toBe(true);
    });

    it('folder shows createRowTable', () => {
        expect(hasMenuEntry('ydb.createRowTable', 'folder')).toBe(true);
    });

    it('folder shows createColumnTable', () => {
        expect(hasMenuEntry('ydb.createColumnTable', 'folder')).toBe(true);
    });

    it('root-topics shows createTopic', () => {
        expect(hasMenuEntry('ydb.createTopic', 'root-topics')).toBe(true);
    });

    it('root-views shows createView', () => {
        expect(hasMenuEntry('ydb.createView', 'root-views')).toBe(true);
    });

    it('root-external-datasources shows createExtDsObjectStorage', () => {
        expect(hasMenuEntry('ydb.createExtDsObjectStorage', 'root-external-datasources')).toBe(true);
    });

    it('root-external-datasources shows createExtDsYdb', () => {
        expect(hasMenuEntry('ydb.createExtDsYdb', 'root-external-datasources')).toBe(true);
    });

    it('root-external-tables shows createExtTableCsv', () => {
        expect(hasMenuEntry('ydb.createExtTableCsv', 'root-external-tables')).toBe(true);
    });

    it('root-external-tables shows createExtTableJson', () => {
        expect(hasMenuEntry('ydb.createExtTableJson', 'root-external-tables')).toBe(true);
    });

    it('root-external-tables shows createExtTableParquet', () => {
        expect(hasMenuEntry('ydb.createExtTableParquet', 'root-external-tables')).toBe(true);
    });

    it('root-transfers shows createTransfer', () => {
        expect(hasMenuEntry('ydb.createTransfer', 'root-transfers')).toBe(true);
    });

    it('root-streaming-queries shows createStreamingQuery', () => {
        expect(hasMenuEntry('ydb.createStreamingQuery', 'root-streaming-queries')).toBe(true);
    });
});
