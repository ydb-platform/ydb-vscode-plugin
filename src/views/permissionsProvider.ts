import * as vscode from 'vscode';
import { PermissionEntry } from '../models/types';

class PermissionItem extends vscode.TreeItem {
    constructor(
        label: string,
        description: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly permissions?: string[],
    ) {
        super(label, collapsibleState);
        this.description = description;
        this.contextValue = 'permission';
    }
}

export class PermissionsProvider implements vscode.TreeDataProvider<PermissionItem> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<PermissionItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private objectPath: string | undefined;
    private owner: string | undefined;
    private explicitPermissions: PermissionEntry[] = [];
    private effectivePermissions: PermissionEntry[] = [];

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    setPermissions(
        objectPath: string,
        owner: string | undefined,
        explicitPerms: PermissionEntry[],
        effectivePerms: PermissionEntry[],
    ): void {
        this.objectPath = objectPath;
        this.owner = owner;
        this.explicitPermissions = explicitPerms;
        this.effectivePermissions = effectivePerms;
        this.refresh();
    }

    clear(): void {
        this.objectPath = undefined;
        this.owner = undefined;
        this.explicitPermissions = [];
        this.effectivePermissions = [];
        this.refresh();
    }

    getTreeItem(element: PermissionItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: PermissionItem): Promise<PermissionItem[]> {
        if (!this.objectPath) {
            return [new PermissionItem(
                'Select an object to view permissions',
                '',
                vscode.TreeItemCollapsibleState.None,
            )];
        }

        if (!element) {
            const items: PermissionItem[] = [];

            // Object path
            items.push(new PermissionItem(
                `Object: ${this.objectPath}`,
                '',
                vscode.TreeItemCollapsibleState.None,
            ));

            // Owner
            items.push(new PermissionItem(
                `Owner: ${this.owner ?? 'unknown'}`,
                '',
                vscode.TreeItemCollapsibleState.None,
            ));

            // Explicit permissions section
            if (this.explicitPermissions.length > 0) {
                items.push(new PermissionItem(
                    'Explicit Permissions',
                    `(${this.explicitPermissions.length})`,
                    vscode.TreeItemCollapsibleState.Expanded,
                    ['explicit'],
                ));
            }

            // Effective permissions section
            if (this.effectivePermissions.length > 0) {
                items.push(new PermissionItem(
                    'Effective Permissions',
                    `(${this.effectivePermissions.length})`,
                    vscode.TreeItemCollapsibleState.Collapsed,
                    ['effective'],
                ));
            }

            return items;
        }

        // Children of explicit/effective permission sections
        if (element.permissions) {
            const perms = element.permissions[0] === 'explicit'
                ? this.explicitPermissions
                : this.effectivePermissions;

            return perms.map(p => new PermissionItem(
                p.subject,
                p.permissionNames.join(', '),
                vscode.TreeItemCollapsibleState.None,
            ));
        }

        return [];
    }
}
