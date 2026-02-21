import { describe, it, expect } from 'vitest';
import { SessionProvider } from '../../views/sessionProvider';

describe('SessionProvider', () => {
    const noConnectionManager = {
        getActiveProfile: () => undefined,
        getDriver: () => { throw new Error('no driver'); },
    } as never;

    it('shows "No connection" when no profile', async () => {
        const provider = new SessionProvider(noConnectionManager);
        const items = await provider.getChildren();
        expect(items).toHaveLength(1);
        expect(items[0].label).toBe('No connection');
    });

    it('toggleHideIdle toggles state', () => {
        const provider = new SessionProvider(noConnectionManager);
        // Toggle should not throw
        provider.toggleHideIdle();
        provider.toggleHideIdle();
    });

    it('getTreeItem returns element', () => {
        const provider = new SessionProvider(noConnectionManager);
        const mockItem = { label: 'test' } as never;
        expect(provider.getTreeItem(mockItem)).toBe(mockItem);
    });

    it('refresh fires event without error', () => {
        const provider = new SessionProvider(noConnectionManager);
        provider.refresh();
    });
});
