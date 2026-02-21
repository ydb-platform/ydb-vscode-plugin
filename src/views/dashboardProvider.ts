import * as vscode from 'vscode';
import { ConnectionManager } from '../services/connectionManager';
import { DashboardMetrics } from '../models/types';
import { getMonitoringUrl, extractAuthToken } from '../models/connectionProfile';
import { fetchDashboardMetrics } from '../commands/viewCommands';

export class DashboardProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private metrics: DashboardMetrics | undefined;
    private error: string | undefined;
    private refreshTimer: ReturnType<typeof setInterval> | undefined;

    constructor(private connectionManager: ConnectionManager) {
        this.startAutoRefresh();
    }

    refresh(): void {
        this.fetchMetrics();
    }

    dispose(): void {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = undefined;
        }
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(): Promise<vscode.TreeItem[]> {
        const profile = this.connectionManager.getActiveProfile();
        if (!profile) {
            const item = new vscode.TreeItem('No connection', vscode.TreeItemCollapsibleState.None);
            item.description = 'Add a connection first';
            item.iconPath = new vscode.ThemeIcon('warning');
            return [item];
        }

        const monitoringUrl = getMonitoringUrl(profile);
        if (!monitoringUrl) {
            const item = new vscode.TreeItem('No monitoring URL', vscode.TreeItemCollapsibleState.None);
            item.description = 'Configure monitoring URL';
            item.iconPath = new vscode.ThemeIcon('warning');
            return [item];
        }

        if (this.error) {
            const item = new vscode.TreeItem('Failed to load metrics', vscode.TreeItemCollapsibleState.None);
            item.description = this.error;
            item.iconPath = new vscode.ThemeIcon('error');
            item.tooltip = this.error;
            return [item];
        }

        if (!this.metrics) {
            this.fetchMetrics();
            const item = new vscode.TreeItem('Loading...', vscode.TreeItemCollapsibleState.None);
            item.iconPath = new vscode.ThemeIcon('loading~spin');
            return [item];
        }

        const m = this.metrics;
        const items: vscode.TreeItem[] = [];

        const cpuPercent = m.cpuTotal > 0 ? (m.cpuUsed / m.cpuTotal * 100) : 0;
        const cpuItem = new vscode.TreeItem('CPU', vscode.TreeItemCollapsibleState.None);
        cpuItem.description = `${cpuPercent.toFixed(1)}%  (${m.cpuUsed.toFixed(1)} / ${m.cpuTotal} cores)`;
        cpuItem.iconPath = new vscode.ThemeIcon('pulse', this.getColorForPercent(cpuPercent));
        cpuItem.tooltip = `CPU: ${cpuPercent.toFixed(1)}%\n${m.cpuUsed.toFixed(1)} / ${m.cpuTotal} cores`;
        items.push(cpuItem);

        const memPercent = m.memoryTotal > 0 ? (m.memoryUsed / m.memoryTotal * 100) : 0;
        const memItem = new vscode.TreeItem('Memory', vscode.TreeItemCollapsibleState.None);
        memItem.description = `${memPercent.toFixed(1)}%  (${this.formatBytes(m.memoryUsed)} / ${this.formatBytes(m.memoryTotal)})`;
        memItem.iconPath = new vscode.ThemeIcon('circuit-board', this.getColorForPercent(memPercent));
        memItem.tooltip = `Memory: ${memPercent.toFixed(1)}%\n${this.formatBytes(m.memoryUsed)} / ${this.formatBytes(m.memoryTotal)}`;
        items.push(memItem);

        const storagePercent = m.storageTotal > 0 ? (m.storageUsed / m.storageTotal * 100) : 0;
        const storageItem = new vscode.TreeItem('Storage', vscode.TreeItemCollapsibleState.None);
        storageItem.description = `${storagePercent.toFixed(1)}%  (${this.formatBytes(m.storageUsed)} / ${this.formatBytes(m.storageTotal)})`;
        storageItem.iconPath = new vscode.ThemeIcon('database', this.getColorForPercent(storagePercent));
        storageItem.tooltip = `Storage: ${storagePercent.toFixed(1)}%\n${this.formatBytes(m.storageUsed)} / ${this.formatBytes(m.storageTotal)}`;
        items.push(storageItem);

        const nodesItem = new vscode.TreeItem('Nodes', vscode.TreeItemCollapsibleState.None);
        nodesItem.description = `${m.nodes.length}`;
        nodesItem.iconPath = new vscode.ThemeIcon('server');
        nodesItem.tooltip = `Total nodes: ${m.nodes.length}`;
        items.push(nodesItem);

        return items;
    }

    private getColorForPercent(percent: number): vscode.ThemeColor {
        if (percent < 60) {
            return new vscode.ThemeColor('charts.green');
        }
        if (percent < 85) {
            return new vscode.ThemeColor('charts.yellow');
        }
        return new vscode.ThemeColor('charts.red');
    }

    private formatBytes(bytes: number): string {
        if (bytes === 0) {return '0 B';}
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
    }

    private startAutoRefresh(): void {
        this.refreshTimer = setInterval(() => {
            this.fetchMetrics();
        }, 10000);
    }

    private async fetchMetrics(): Promise<void> {
        const profile = this.connectionManager.getActiveProfile();
        if (!profile) {
            this.metrics = undefined;
            this.error = undefined;
            this._onDidChangeTreeData.fire();
            return;
        }

        const monitoringUrl = getMonitoringUrl(profile);
        if (!monitoringUrl) {
            this.metrics = undefined;
            this.error = undefined;
            this._onDidChangeTreeData.fire();
            return;
        }

        try {
            this.metrics = await fetchDashboardMetrics(monitoringUrl, extractAuthToken(profile));
            this.error = undefined;
        } catch (err: unknown) {
            this.error = err instanceof Error ? err.message : String(err);
            this.metrics = undefined;
        }

        this._onDidChangeTreeData.fire();
    }
}
