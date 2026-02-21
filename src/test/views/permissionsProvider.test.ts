import { describe, it, expect } from 'vitest';
import { PermissionsProvider } from '../../views/permissionsProvider';

describe('PermissionsProvider', () => {
    it('shows placeholder when no permissions set', async () => {
        const provider = new PermissionsProvider();
        const children = await provider.getChildren();
        expect(children).toHaveLength(1);
        expect(children[0].label).toContain('Select an object');
    });

    it('shows path and owner at root', async () => {
        const provider = new PermissionsProvider();
        provider.setPermissions(
            '/mydb/my_table',
            'root',
            [{ subject: 'user1', permissionNames: ['read'] }],
            [{ subject: 'user2', permissionNames: ['read', 'write'] }],
        );
        const children = await provider.getChildren();
        const labels = children.map(c => c.label as string);
        expect(labels.some(l => l.includes('/mydb/my_table'))).toBe(true);
        expect(labels.some(l => l.includes('root'))).toBe(true);
    });

    it('shows explicit permissions section', async () => {
        const provider = new PermissionsProvider();
        provider.setPermissions(
            '/mydb/t',
            'owner',
            [{ subject: 'alice', permissionNames: ['ydb.tables.read'] }],
            [],
        );
        const children = await provider.getChildren();
        const explicitSection = children.find(c => (c.label as string).includes('Explicit'));
        expect(explicitSection).toBeDefined();
    });

    it('shows effective permissions section', async () => {
        const provider = new PermissionsProvider();
        provider.setPermissions(
            '/mydb/t',
            'owner',
            [],
            [{ subject: 'bob', permissionNames: ['ydb.tables.read'] }],
        );
        const children = await provider.getChildren();
        const effectiveSection = children.find(c => (c.label as string).includes('Effective'));
        expect(effectiveSection).toBeDefined();
    });

    it('shows permission entries as children', async () => {
        const provider = new PermissionsProvider();
        provider.setPermissions(
            '/mydb/t',
            'owner',
            [
                { subject: 'alice', permissionNames: ['read'] },
                { subject: 'bob', permissionNames: ['write'] },
            ],
            [],
        );
        const root = await provider.getChildren();
        const explicitSection = root.find(c => (c.label as string).includes('Explicit'));
        expect(explicitSection).toBeDefined();

        const entries = await provider.getChildren(explicitSection);
        expect(entries).toHaveLength(2);
        expect(entries[0].label).toBe('alice');
        expect(entries[1].label).toBe('bob');
    });

    it('clear resets all state', async () => {
        const provider = new PermissionsProvider();
        provider.setPermissions('/path', 'owner', [], []);
        provider.clear();
        const children = await provider.getChildren();
        expect(children).toHaveLength(1);
        expect(children[0].label).toContain('Select an object');
    });
});
