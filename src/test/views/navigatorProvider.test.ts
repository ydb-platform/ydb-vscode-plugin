import { describe, it, expect, beforeEach, vi } from 'vitest';
import { YdbNavigatorProvider } from '../../views/navigatorProvider';
import { NavigatorItem } from '../../views/navigatorItems';
import { TreeItemCollapsibleState } from 'vscode';

vi.mock('../../services/queryService', () => ({
    QueryService: vi.fn().mockImplementation(() => ({
        loadStreamingQueries: vi.fn().mockResolvedValue([]),
        loadResourcePools: vi.fn().mockResolvedValue([]),
    })),
    CancellationError: class CancellationError extends Error {},
}));

// A mock YDB driver that makes SchemeService.listDirectory return [] without network calls.
// anyUnpack({typeUrl:'',value:Uint8Array}) returns undefined → SchemeService returns [].
function makeEmptySchemeDriver() {
    return {
        database: '/mydb',
        createClient: () => ({
            listDirectory: async () => ({
                operation: { status: 0, result: { typeUrl: '', value: new Uint8Array() }, issues: [] },
            }),
        }),
    };
}

describe('YdbNavigatorProvider', () => {
    let provider: YdbNavigatorProvider;
    const mockConnectionManager = {
        getActiveProfile: () => undefined,
        getFocusedProfileId: () => undefined,
        getDriver: () => { throw new Error('no driver'); },
        onDidChangeConnection: { event: () => ({ dispose: () => {} }) },
    } as never;

    beforeEach(() => {
        provider = new YdbNavigatorProvider(mockConnectionManager);
    });

    it('shows "No connection" when no active profile', async () => {
        const children = await provider.getChildren();
        expect(children).toHaveLength(1);
        expect(children[0].label).toContain('No connection');
        expect(children[0].contextValue).toBe('no-connection');
    });

    it('returns root folders when profile exists', async () => {
        const mgr = Object.assign({}, mockConnectionManager, {
            getActiveProfile: () => ({
                id: 'test-id',
                name: 'Test',
                endpoint: 'grpc://localhost:2135',
                database: '/mydb',
                authType: 'anonymous',
                secure: false,
            }),
            getFocusedProfileId: () => 'test-id',
            isConnected: () => true,
        });
        // We need a fresh provider with the connected manager
        const connectedProvider = new YdbNavigatorProvider(mgr as never);
        const children = await connectedProvider.getChildren();

        // Should have 9 root folders
        expect(children.length).toBe(9);
        const contextValues = children.map(c => c.contextValue);
        expect(contextValues).toContain('root-tables');
        expect(contextValues).toContain('root-system-views');
        expect(contextValues).toContain('root-views');
        expect(contextValues).toContain('root-topics');
        expect(contextValues).toContain('root-external-datasources');
        expect(contextValues).toContain('root-external-tables');
        expect(contextValues).toContain('root-resource-pools');
        expect(contextValues).toContain('root-transfers');
        expect(contextValues).toContain('root-streaming-queries');
    });

    it('root folders are collapsible', async () => {
        const mgr = {
            getActiveProfile: () => ({
                id: 'test-id',
                name: 'Test',
                endpoint: 'grpc://localhost:2135',
                database: '/mydb',
                authType: 'anonymous',
                secure: false,
            }),
            getFocusedProfileId: () => 'test-id',
            isConnected: () => true,
            getDriver: () => { throw new Error('no driver'); },
        };
        const connectedProvider = new YdbNavigatorProvider(mgr as never);
        const children = await connectedProvider.getChildren();
        for (const child of children) {
            expect(child.collapsibleState).toBe(TreeItemCollapsibleState.Collapsed);
        }
    });

    it('getTableNames returns empty initially', () => {
        expect(provider.getTableNames()).toEqual([]);
    });

    it('getParent returns undefined for unknown item', () => {
        const result = provider.getParent({ id: 'unknown-id' } as never);
        expect(result).toBeUndefined();
    });

    it('getParent returns undefined for item with no id', () => {
        const result = provider.getParent({ id: undefined } as never);
        expect(result).toBeUndefined();
    });

    it('switchProfile resets cached table names', () => {
        provider.switchProfile();
        expect(provider.getTableNames()).toEqual([]);
    });

    it('refresh clears cache', async () => {
        // Call refresh — should not throw
        provider.refresh();
        expect(provider.getTableNames()).toEqual([]);
    });

    it('getTreeItem returns the element itself', () => {
        const item = { label: 'test' } as never;
        expect(provider.getTreeItem(item)).toBe(item);
    });

    describe('empty placeholder', () => {
        const connectedMgr = {
            getActiveProfile: () => ({
                id: 'test-id',
                name: 'Test',
                endpoint: 'grpc://localhost:2135',
                database: '/mydb',
                authType: 'anonymous',
                secure: false,
            }),
            getFocusedProfileId: () => 'test-id',
            isConnected: () => true,
            getDriver: vi.fn().mockResolvedValue(makeEmptySchemeDriver()),
        };

        it('shows placeholder when root section has no children', async () => {
            const connectedProvider = new YdbNavigatorProvider(connectedMgr as never);

            // Simulate a root tables section element
            const tablesRoot = new NavigatorItem(
                'Tables', '', 'root-folder',
                TreeItemCollapsibleState.Collapsed, 'root-tables',
            );

            const children = await connectedProvider.getChildren(tablesRoot);

            expect(children).toHaveLength(1);
            expect(children[0].label).toBe('<empty>');
            expect(children[0].contextValue).toBe('empty-placeholder');
        });

        it('empty placeholder is not expandable', async () => {
            const connectedProvider = new YdbNavigatorProvider(connectedMgr as never);

            const tablesRoot = new NavigatorItem(
                'Tables', '', 'root-folder',
                TreeItemCollapsibleState.Collapsed, 'root-tables',
            );

            const children = await connectedProvider.getChildren(tablesRoot);
            expect(children[0].collapsibleState).toBe(TreeItemCollapsibleState.None);
        });

        it('shows placeholder for streaming queries when empty', async () => {
            const connectedProvider = new YdbNavigatorProvider(connectedMgr as never);

            const streamingRoot = new NavigatorItem(
                'Streaming Queries', '', 'root-folder',
                TreeItemCollapsibleState.Collapsed, 'root-streaming-queries',
            ) as NavigatorItem & { isStreamingQueries?: boolean };
            streamingRoot.isStreamingQueries = true;

            const children = await connectedProvider.getChildren(streamingRoot);

            expect(children).toHaveLength(1);
            expect(children[0].label).toBe('<empty>');
            expect(children[0].contextValue).toBe('empty-placeholder');
        });

        it('shows placeholder for resource pools when empty', async () => {
            const connectedProvider = new YdbNavigatorProvider(connectedMgr as never);

            const poolsRoot = new NavigatorItem(
                'Resource Pools', '', 'root-folder',
                TreeItemCollapsibleState.Collapsed, 'root-resource-pools',
            ) as NavigatorItem & { isResourcePools?: boolean };
            poolsRoot.isResourcePools = true;

            const children = await connectedProvider.getChildren(poolsRoot);

            expect(children).toHaveLength(1);
            expect(children[0].label).toBe('<empty>');
            expect(children[0].contextValue).toBe('empty-placeholder');
        });
    });

    it('caches children for same profile', async () => {
        const mgr = {
            getActiveProfile: () => ({
                id: 'test-id',
                name: 'Test',
                endpoint: 'grpc://localhost:2135',
                database: '/mydb',
                authType: 'anonymous',
                secure: false,
            }),
            getFocusedProfileId: () => 'test-id',
            isConnected: () => true,
            getDriver: () => { throw new Error('no driver'); },
        };
        const connectedProvider = new YdbNavigatorProvider(mgr as never);
        const children1 = await connectedProvider.getChildren();
        const children2 = await connectedProvider.getChildren();
        // Should return same cached reference
        expect(children1).toBe(children2);
    });

    it('root folders have correct labels', async () => {
        const mgr = {
            getActiveProfile: () => ({
                id: 'test-id',
                name: 'Test',
                endpoint: 'grpc://localhost:2135',
                database: '/mydb',
                authType: 'anonymous',
                secure: false,
            }),
            getFocusedProfileId: () => 'test-id',
            isConnected: () => true,
            getDriver: () => { throw new Error('no driver'); },
        };
        const connectedProvider = new YdbNavigatorProvider(mgr as never);
        const children = await connectedProvider.getChildren();
        const labels = children.map(c => c.label);
        expect(labels).toContain('Tables');
        expect(labels).toContain('System Views');
        expect(labels).toContain('Views');
        expect(labels).toContain('Topics');
        expect(labels).toContain('External Data Sources');
        expect(labels).toContain('External Tables');
        expect(labels).toContain('Resource Pools');
        expect(labels).toContain('Transfers');
        expect(labels).toContain('Streaming Queries');
    });
});
