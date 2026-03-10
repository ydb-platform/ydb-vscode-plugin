import { SchemeService } from './schemeService.js';
import { QueryService } from './queryService.js';
import { SchemeEntryType } from '../models/types.js';

export interface DeleteProgress {
    deleted: number;
    total: number;
    currentPath: string;
}

interface DeleteItem {
    path: string;
    type: SchemeEntryType;
    contextValue: string;
}

export class DeleteService {
    constructor(
        private schemeService: SchemeService,
        private queryService: QueryService,
    ) {}

    /**
     * Recursively collect all items under path (depth-first, leaves before parent),
     * then delete them in order, reporting progress.
     */
    async deleteRecursive(
        path: string,
        type: SchemeEntryType,
        contextValue: string,
        onProgress?: (progress: DeleteProgress) => void,
    ): Promise<void> {
        const items = await this.collectItems(path, type, contextValue);
        const total = items.length;
        let deleted = 0;

        for (const item of items) {
            onProgress?.({ deleted, total, currentPath: item.path });
            await this.deleteOne(item);
            deleted++;
        }
        onProgress?.({ deleted, total, currentPath: '' });
    }

    private async collectItems(path: string, type: SchemeEntryType, contextValue: string): Promise<DeleteItem[]> {
        const items: DeleteItem[] = [];

        if (type === SchemeEntryType.DIRECTORY) {
            let children;
            try {
                children = await this.schemeService.listDirectory(path);
            } catch {
                children = [];
            }
            for (const child of children) {
                const childPath = path ? `${path}/${child.name}` : child.name;
                const childItems = await this.collectItems(childPath, child.type, this.typeToContextValue(child.type));
                items.push(...childItems);
            }
        }

        // Push self last (children before parent = bottom-up order)
        items.push({ path, type, contextValue });
        return items;
    }

    private typeToContextValue(type: SchemeEntryType): string {
        switch (type) {
            case SchemeEntryType.DIRECTORY: return 'folder';
            case SchemeEntryType.TABLE: return 'table';
            case SchemeEntryType.COLUMN_STORE:
            case SchemeEntryType.COLUMN_TABLE: return 'column-store';
            case SchemeEntryType.PERS_QUEUE_GROUP:
            case SchemeEntryType.TOPIC: return 'topic';
            case SchemeEntryType.EXTERNAL_DATA_SOURCE: return 'external-datasource';
            case SchemeEntryType.EXTERNAL_TABLE: return 'external-table';
            case SchemeEntryType.RESOURCE_POOL: return 'resource-pool';
            case SchemeEntryType.COORDINATION_NODE: return 'coordination-node';
            case SchemeEntryType.VIEW: return 'view';
            case SchemeEntryType.TRANSFER: return 'transfer';
            default: return 'unknown';
        }
    }

    private async deleteOne(item: DeleteItem): Promise<void> {
        // Use backtick-quoted path for YQL DROP statements (relative to database root)
        const q = (p: string) => `\`${p}\``;

        switch (item.contextValue) {
            case 'folder':
                await this.schemeService.removeDirectory(item.path);
                break;
            case 'table':
            case 'column-store':
                await this.queryService.executeQuery(`DROP TABLE ${q(item.path)}`);
                break;
            case 'topic':
                await this.queryService.executeQuery(`DROP TOPIC ${q(item.path)}`);
                break;
            case 'view':
                await this.queryService.executeQuery(`DROP VIEW ${q(item.path)}`);
                break;
            case 'external-table':
                await this.queryService.executeQuery(`DROP EXTERNAL TABLE ${q(item.path)}`);
                break;
            case 'external-datasource':
                await this.queryService.executeQuery(`DROP EXTERNAL DATA SOURCE ${q(item.path)}`);
                break;
            case 'resource-pool': {
                // Resource pools use just their name, not a full path
                const name = item.path.split('/').pop() ?? item.path;
                await this.queryService.executeQuery(`DROP RESOURCE POOL \`${name}\``);
                break;
            }
            case 'transfer':
                await this.queryService.executeQuery(`DROP TRANSFER ${q(item.path)}`);
                break;
            case 'coordination-node':
                await this.queryService.executeQuery(`DROP COORDINATION NODE ${q(item.path)}`);
                break;
            case 'streaming-query-running':
            case 'streaming-query-stopped':
                await this.queryService.executeQuery(`DROP STREAMING QUERY ${q(item.path)}`);
                break;
            default:
                throw new Error(`Unsupported entity type for deletion: ${item.contextValue}`);
        }
    }
}
