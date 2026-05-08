import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
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
        provider.dispose();
    });

    it('toggleHideIdle toggles state', () => {
        const provider = new SessionProvider(noConnectionManager);
        provider.toggleHideIdle();
        provider.toggleHideIdle();
        provider.dispose();
    });

    it('getTreeItem returns element', () => {
        const provider = new SessionProvider(noConnectionManager);
        const mockItem = { label: 'test' } as never;
        expect(provider.getTreeItem(mockItem)).toBe(mockItem);
        provider.dispose();
    });

    it('refresh fires event without error', () => {
        const provider = new SessionProvider(noConnectionManager);
        provider.refresh();
        provider.dispose();
    });

    describe('auto-refresh', () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });
        afterEach(() => {
            vi.useRealTimers();
            vi.restoreAllMocks();
        });

        function stubInterval(seconds: number) {
            vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
                get: <T>(_key: string, defaultValue?: T) => seconds as unknown as T ?? defaultValue,
                has: () => true,
                update: async () => {},
            } as never);
        }

        it('fires refresh on configured interval', () => {
            stubInterval(10);
            const provider = new SessionProvider(noConnectionManager);
            const fired = vi.fn();
            provider.onDidChangeTreeData(fired);

            vi.advanceTimersByTime(9_000);
            expect(fired).not.toHaveBeenCalled();
            vi.advanceTimersByTime(1_000);
            expect(fired).toHaveBeenCalledTimes(1);
            vi.advanceTimersByTime(10_000);
            expect(fired).toHaveBeenCalledTimes(2);

            provider.dispose();
        });

        it('does not start a timer when interval is 0', () => {
            stubInterval(0);
            const provider = new SessionProvider(noConnectionManager);
            const fired = vi.fn();
            provider.onDidChangeTreeData(fired);

            vi.advanceTimersByTime(60_000);
            expect(fired).not.toHaveBeenCalled();

            provider.dispose();
        });

        it('stops the timer on dispose', () => {
            stubInterval(5);
            const provider = new SessionProvider(noConnectionManager);
            const fired = vi.fn();
            provider.onDidChangeTreeData(fired);

            provider.dispose();
            vi.advanceTimersByTime(60_000);
            expect(fired).not.toHaveBeenCalled();
        });
    });
});
