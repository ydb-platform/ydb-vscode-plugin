import { TableDescription, TransferDescription, ExternalTableDescription, StreamingQuery } from '../models/types.js';

export function generateTableDDL(path: string, desc: TableDescription): string {
    if (!desc.columns.length) {
        return '';
    }

    const pkSet = new Set(desc.primaryKeys);
    const lines: string[] = [];
    lines.push(`CREATE TABLE \`${path}\` (`);

    const columnLines: string[] = [];
    for (const col of desc.columns) {
        let line = `    \`${col.name}\` ${col.type}`;
        if (pkSet.has(col.name) || col.notNull) {
            line += ' NOT NULL';
        }
        columnLines.push(line);
    }

    if (desc.primaryKeys.length > 0) {
        columnLines.push(`    PRIMARY KEY (${desc.primaryKeys.map(k => `\`${k}\``).join(', ')})`);
    }

    lines.push(columnLines.join(',\n'));
    lines.push(')');

    if (desc.isColumnTable && desc.partitionBy.length > 0) {
        lines.push(`PARTITION BY HASH(${desc.partitionBy.map(k => `\`${k}\``).join(', ')})`);
    }

    if (desc.isColumnTable) {
        lines.push('WITH (STORE = COLUMN)');
    }

    return lines.join('\n');
}

export function generateViewDDL(relativePath: string, queryText: string): string {
    return `CREATE VIEW \`${relativePath}\` WITH (security_invoker = TRUE) AS\n${queryText}`;
}

export function generateTransferDDL(path: string, desc: TransferDescription, db: string): string {
    const lines: string[] = [];

    const stripDb = (p: string) => p.startsWith(db + '/') ? p.slice(db.length + 1) : p;
    const source = desc.sourcePath ? stripDb(desc.sourcePath) : '';
    const destination = desc.destinationPath ? stripDb(desc.destinationPath) : '';

    if (desc.transformationLambda) {
        const cleaned = desc.transformationLambda
            .replace(/^(\$__ydb_transfer_lambda\s*=.*\n?)/m, '')
            .trim();
        if (cleaned) {
            lines.push(cleaned);
            lines.push('');
        }
        lines.push(`CREATE TRANSFER \`${path}\``);
        lines.push(`    FROM \`${source}\` TO \`${destination}\` USING $transformation_lambda;`);
    } else {
        lines.push(`CREATE TRANSFER \`${path}\``);
        lines.push(`    FROM \`${source}\` TO \`${destination}\`;`);
    }

    return lines.join('\n');
}

export function generateExternalTableDDL(path: string, desc: ExternalTableDescription): string {
    if (!desc.columns.length) {
        return '';
    }

    const lines: string[] = [];
    lines.push(`CREATE EXTERNAL TABLE \`${path}\` (`);

    const columnLines: string[] = [];
    for (const col of desc.columns) {
        let line = `    \`${col.name}\` ${col.type}`;
        if (col.notNull) {
            line += ' NOT NULL';
        }
        columnLines.push(line);
    }

    lines.push(columnLines.join(',\n'));
    lines.push(') WITH (');

    const withParams: string[] = [];
    if (desc.dataSourcePath) {
        withParams.push(`    DATA_SOURCE="${desc.dataSourcePath}"`);
    }
    if (desc.sourceType) {
        withParams.push(`    SOURCE_TYPE="${desc.sourceType}"`);
    }
    if (desc.location) {
        withParams.push(`    LOCATION="${desc.location}"`);
    }
    if (desc.format) {
        withParams.push(`    FORMAT="${desc.format}"`);
    }
    if (desc.compression) {
        withParams.push(`    COMPRESSION="${desc.compression}"`);
    }

    lines.push(withParams.join(',\n'));
    lines.push(')');

    return lines.join('\n');
}

export function generateStreamingQueryDDL(path: string, query: StreamingQuery): string {
    if (!query.queryText) {
        return '';
    }
    return `CREATE STREAMING QUERY \`${path}\` AS\nDO BEGIN\n${query.queryText}\nEND DO`;
}
