import { describe, it, expect, beforeEach } from 'vitest';
import { ConnectionManager } from '../../services/connectionManager';
import { MockMemento } from '../helpers/mockMemento';

// ConnectionManager is a singleton. For testing, we need to reset it.
// We'll use the public API where possible and access internals via the instance.

describe('ConnectionManager', () => {
    let manager: ConnectionManager;
    let memento: MockMemento;

    beforeEach(() => {
        // Get the singleton instance (always the same object)
        manager = ConnectionManager.getInstance();
        memento = new MockMemento();
        // Re-initialize with fresh memento to reset state
        manager.initialize(memento);
    });

    describe('singleton', () => {
        it('returns same instance', () => {
            const a = ConnectionManager.getInstance();
            const b = ConnectionManager.getInstance();
            expect(a).toBe(b);
        });
    });

    describe('initialize', () => {
        it('loads profiles from memento', () => {
            const profiles = [
                { id: '1', name: 'P1', endpoint: 'grpc://a', database: '/db', authType: 'anonymous' as const, secure: false },
            ];
            memento.update('ydb.connectionProfiles', profiles);
            manager.initialize(memento);
            expect(manager.getProfiles()).toHaveLength(1);
            expect(manager.getProfiles()[0].name).toBe('P1');
        });

        it('migrates old active profile key to focused', () => {
            memento.update('ydb.activeProfileId', 'old-id');
            manager.initialize(memento);
            expect(manager.getFocusedProfileId()).toBe('old-id');
        });

        it('prefers focusedProfileId over activeProfileId', () => {
            memento.update('ydb.activeProfileId', 'old-id');
            memento.update('ydb.focusedProfileId', 'new-id');
            manager.initialize(memento);
            expect(manager.getFocusedProfileId()).toBe('new-id');
        });
    });

    describe('getProfiles', () => {
        it('returns defensive copy', async () => {
            await manager.addProfile({
                name: 'Test',
                endpoint: 'grpc://localhost:2135',
                database: '/mydb',
                authType: 'anonymous',
                secure: false,
            });
            const profiles1 = manager.getProfiles();
            const profiles2 = manager.getProfiles();
            expect(profiles1).not.toBe(profiles2); // different array references
            expect(profiles1).toEqual(profiles2);   // same content
        });
    });

    describe('addProfile', () => {
        it('adds profile with generated UUID', async () => {
            const result = await manager.addProfile({
                name: 'New',
                endpoint: 'grpc://host:2135',
                database: '/db',
                authType: 'anonymous',
                secure: false,
            });
            expect(result.id).toBeDefined();
            expect(result.id.length).toBeGreaterThan(0);
            expect(result.name).toBe('New');
        });

        it('saves to memento', async () => {
            await manager.addProfile({
                name: 'Saved',
                endpoint: 'grpc://host:2135',
                database: '/db',
                authType: 'anonymous',
                secure: false,
            });
            const saved = memento.get<unknown[]>('ydb.connectionProfiles');
            expect(saved).toBeDefined();
            expect(saved!.length).toBe(1);
        });

        it('auto-activates first profile', async () => {
            const profile = await manager.addProfile({
                name: 'First',
                endpoint: 'grpc://host:2135',
                database: '/db',
                authType: 'anonymous',
                secure: false,
            });
            // After adding the first profile, it becomes focused
            expect(manager.getFocusedProfileId()).toBe(profile.id);
        });
    });

    describe('updateProfile', () => {
        it('updates profile fields', async () => {
            const profile = await manager.addProfile({
                name: 'Original',
                endpoint: 'grpc://host:2135',
                database: '/db',
                authType: 'anonymous',
                secure: false,
            });
            await manager.updateProfile(profile.id, { name: 'Updated' });
            const updated = manager.getProfiles().find(p => p.id === profile.id);
            expect(updated?.name).toBe('Updated');
        });

        it('throws for nonexistent profile', async () => {
            await expect(manager.updateProfile('nonexistent', { name: 'X' }))
                .rejects.toThrow('Connection profile not found');
        });
    });

    describe('removeProfile', () => {
        it('removes profile', async () => {
            const profile = await manager.addProfile({
                name: 'ToDelete',
                endpoint: 'grpc://host:2135',
                database: '/db',
                authType: 'anonymous',
                secure: false,
            });
            await manager.removeProfile(profile.id);
            expect(manager.getProfiles()).toHaveLength(0);
        });

        it('clears focus if focused profile removed', async () => {
            const profile = await manager.addProfile({
                name: 'Focused',
                endpoint: 'grpc://host:2135',
                database: '/db',
                authType: 'anonymous',
                secure: false,
            });
            await manager.removeProfile(profile.id);
            expect(manager.getFocusedProfileId()).toBeUndefined();
        });
    });

    describe('setFocusedProfile', () => {
        it('sets focused profile id', async () => {
            const profile = await manager.addProfile({
                name: 'Focus',
                endpoint: 'grpc://host:2135',
                database: '/db',
                authType: 'anonymous',
                secure: false,
            });
            await manager.setFocusedProfile(profile.id);
            expect(manager.getFocusedProfileId()).toBe(profile.id);
        });

        it('can set undefined', async () => {
            await manager.setFocusedProfile(undefined);
            expect(manager.getFocusedProfileId()).toBeUndefined();
        });
    });

    describe('getDriver', () => {
        it('throws when no active connection', async () => {
            await expect(manager.getDriver()).rejects.toThrow('No active connection');
        });

        it('throws for nonexistent profile id', async () => {
            await expect(manager.getDriver('nonexistent')).rejects.toThrow('Connection profile not found');
        });
    });

    describe('isConnected', () => {
        it('returns false for unknown profile', () => {
            expect(manager.isConnected('unknown')).toBe(false);
        });
    });

    describe('getConnectedProfileIds', () => {
        it('returns empty array initially', () => {
            expect(manager.getConnectedProfileIds()).toEqual([]);
        });
    });

    describe('getActiveProfile', () => {
        it('returns undefined when no focused profile', () => {
            expect(manager.getActiveProfile()).toBeUndefined();
        });
    });

    describe('getFocusedProfile', () => {
        it('returns the focused profile', async () => {
            const profile = await manager.addProfile({
                name: 'Focused',
                endpoint: 'grpc://host:2135',
                database: '/db',
                authType: 'anonymous',
                secure: false,
            });
            expect(manager.getFocusedProfile()?.id).toBe(profile.id);
        });
    });

    describe('getProfileById', () => {
        it('returns undefined for unknown id', () => {
            expect(manager.getProfileById('nonexistent')).toBeUndefined();
        });

        it('returns the matching profile', async () => {
            const profile = await manager.addProfile({
                name: 'Test',
                endpoint: 'grpc://host:2135',
                database: '/db',
                authType: 'anonymous',
                secure: false,
            });
            expect(manager.getProfileById(profile.id)).toEqual(profile);
        });

        it('returns undefined after profile is deleted', async () => {
            const profile = await manager.addProfile({
                name: 'ToDelete',
                endpoint: 'grpc://host:2135',
                database: '/db',
                authType: 'anonymous',
                secure: false,
            });
            await manager.removeProfile(profile.id);
            expect(manager.getProfileById(profile.id)).toBeUndefined();
        });
    });

    describe('dispose', () => {
        it('cleans up without error', async () => {
            await expect(manager.dispose()).resolves.not.toThrow();
        });
    });
});
