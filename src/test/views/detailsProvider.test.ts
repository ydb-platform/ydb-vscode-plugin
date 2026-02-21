import { describe, it, expect, beforeEach } from 'vitest';
import { DetailsProvider } from '../../views/detailsProvider';
import { NavigatorItem } from '../../views/navigatorItems';
import { SchemeEntryType } from '../../models/types';
import { TreeItemCollapsibleState } from 'vscode';

// We test only the parts of DetailsProvider that don't require a real driver connection

function makeItem(label: string, path: string, type: SchemeEntryType | 'root-folder'): NavigatorItem {
    return new NavigatorItem(
        label,
        path,
        type,
        TreeItemCollapsibleState.None,
        type === 'root-folder' ? 'root-folder' : 'table',
    );
}

describe('DetailsProvider', () => {
    let provider: DetailsProvider;
    const mockConnectionManager = {
        getDriver: () => { throw new Error('No driver in test'); },
        getActiveProfile: () => undefined,
        getFocusedProfileId: () => undefined,
        onDidChangeConnection: { event: () => ({ dispose: () => {} }) },
    } as never;

    beforeEach(() => {
        provider = new DetailsProvider(mockConnectionManager);
    });

    it('starts with no selected item', () => {
        expect(provider.getSelectedItem()).toBeUndefined();
    });

    it('setSelectedItem updates selection', () => {
        const item = makeItem('t', '/path', SchemeEntryType.DIRECTORY);
        provider.setSelectedItem(item);
        expect(provider.getSelectedItem()).toBe(item);
    });

    it('clear resets selection', () => {
        const item = makeItem('t', '/path', SchemeEntryType.DIRECTORY);
        provider.setSelectedItem(item);
        provider.clear();
        expect(provider.getSelectedItem()).toBeUndefined();
    });

    it('hasBack returns false initially', () => {
        expect(provider.hasBack()).toBe(false);
    });

    it('navigateTo pushes to history', () => {
        const item1 = makeItem('t1', '/p1', SchemeEntryType.TABLE);
        const item2 = makeItem('t2', '/p2', SchemeEntryType.TABLE);
        provider.setSelectedItem(item1);
        provider.navigateTo(item2);
        expect(provider.hasBack()).toBe(true);
        expect(provider.getSelectedItem()).toBe(item2);
    });

    it('goBack pops from history', () => {
        const item1 = makeItem('t1', '/p1', SchemeEntryType.TABLE);
        const item2 = makeItem('t2', '/p2', SchemeEntryType.TABLE);
        provider.setSelectedItem(item1);
        provider.navigateTo(item2);
        provider.goBack();
        expect(provider.getSelectedItem()).toBe(item1);
        expect(provider.hasBack()).toBe(false);
    });

    it('peekBack returns last history item', () => {
        const item1 = makeItem('t1', '/p1', SchemeEntryType.TABLE);
        const item2 = makeItem('t2', '/p2', SchemeEntryType.TABLE);
        provider.setSelectedItem(item1);
        provider.navigateTo(item2);
        expect(provider.peekBack()).toBe(item1);
    });

    it('peekBack returns undefined when no history', () => {
        expect(provider.peekBack()).toBeUndefined();
    });

    it('getChildren returns empty for root-folder or directory', async () => {
        const dirItem = makeItem('dir', '/dir', SchemeEntryType.DIRECTORY);
        provider.setSelectedItem(dirItem);
        // Wait for the async loadDetails to fire
        await new Promise(r => setTimeout(r, 10));
        const children = await provider.getChildren();
        expect(children).toHaveLength(0);
    });

    it('clear resets history', () => {
        const item1 = makeItem('t1', '/p1', SchemeEntryType.TABLE);
        const item2 = makeItem('t2', '/p2', SchemeEntryType.TABLE);
        provider.setSelectedItem(item1);
        provider.navigateTo(item2);
        provider.clear();
        expect(provider.hasBack()).toBe(false);
    });

    it('MAX_HISTORY limits history size', () => {
        const items: NavigatorItem[] = [];
        for (let i = 0; i < 55; i++) {
            items.push(makeItem(`t${i}`, `/p${i}`, SchemeEntryType.TABLE));
        }
        provider.setSelectedItem(items[0]);
        for (let i = 1; i < 55; i++) {
            provider.navigateTo(items[i]);
        }
        // History should be capped at MAX_HISTORY (50)
        let count = 0;
        while (provider.hasBack()) {
            provider.goBack();
            count++;
        }
        expect(count).toBeLessThanOrEqual(50);
    });
});
