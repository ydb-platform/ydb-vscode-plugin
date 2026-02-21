import * as vscode from 'vscode';
import { SchemeEntryType } from '../models/types';

export class NavigatorItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly fullPath: string,
        public readonly entryType: SchemeEntryType | 'root-folder',
        collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly contextValue: string,
        rootSection?: string,
    ) {
        super(label, collapsibleState);
        this.id = rootSection
            ? `${rootSection}/${contextValue}:${fullPath}`
            : `${contextValue}:${fullPath}`;
        this.tooltip = fullPath;
        this.iconPath = NavigatorItem.getIcon(entryType, contextValue);
    }

    private static getIcon(entryType: SchemeEntryType | 'root-folder', contextValue: string): vscode.ThemeIcon {
        switch (contextValue) {
            case 'root-tables':
                return new vscode.ThemeIcon('table');
            case 'root-system-views':
                return new vscode.ThemeIcon('eye');
            case 'root-topics':
                return new vscode.ThemeIcon('mail');
            case 'root-external-datasources':
                return new vscode.ThemeIcon('plug');
            case 'root-external-tables':
                return new vscode.ThemeIcon('link-external');
            case 'root-views':
                return new vscode.ThemeIcon('symbol-interface');
            case 'root-resource-pools':
                return new vscode.ThemeIcon('server-process');
            case 'root-streaming-queries':
                return new vscode.ThemeIcon('play-circle');
            case 'folder':
                return new vscode.ThemeIcon('folder');
            case 'table':
                return new vscode.ThemeIcon('table');
            case 'column-store':
                return new vscode.ThemeIcon('layout');
            case 'topic':
                return new vscode.ThemeIcon('mail');
            case 'system-view':
                return new vscode.ThemeIcon('eye');
            case 'external-datasource':
                return new vscode.ThemeIcon('plug');
            case 'external-table':
                return new vscode.ThemeIcon('link-external');
            case 'resource-pool':
                return new vscode.ThemeIcon('server-process');
            case 'streaming-query':
                return new vscode.ThemeIcon('play-circle');
            case 'view':
                return new vscode.ThemeIcon('symbol-interface');
            case 'coordination-node':
                return new vscode.ThemeIcon('git-merge');
            case 'root-transfers':
            case 'transfer':
                return new vscode.ThemeIcon('arrow-swap');
            default:
                return new vscode.ThemeIcon('file');
        }
    }
}

export function getContextValue(entryType: SchemeEntryType): string {
    switch (entryType) {
        case SchemeEntryType.DIRECTORY:
            return 'folder';
        case SchemeEntryType.TABLE:
            return 'table';
        case SchemeEntryType.COLUMN_STORE:
        case SchemeEntryType.COLUMN_TABLE:
            return 'column-store';
        case SchemeEntryType.PERS_QUEUE_GROUP:
        case SchemeEntryType.TOPIC:
            return 'topic';
        case SchemeEntryType.EXTERNAL_DATA_SOURCE:
            return 'external-datasource';
        case SchemeEntryType.EXTERNAL_TABLE:
            return 'external-table';
        case SchemeEntryType.RESOURCE_POOL:
            return 'resource-pool';
        case SchemeEntryType.COORDINATION_NODE:
            return 'coordination-node';
        case SchemeEntryType.VIEW:
            return 'view';
        case SchemeEntryType.TRANSFER:
            return 'transfer';
        default:
            return 'unknown';
    }
}

export function isExpandable(entryType: SchemeEntryType): boolean {
    return entryType === SchemeEntryType.DIRECTORY;
}
