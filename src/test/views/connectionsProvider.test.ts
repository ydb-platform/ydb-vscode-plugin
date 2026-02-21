import { describe, it, expect } from 'vitest';
import { ConnectionItem } from '../../views/connectionsProvider';
import type { ConnectionProfile } from '../../models/connectionProfile';

const mockProfile: ConnectionProfile = {
    id: 'test-id',
    name: 'Test Connection',
    endpoint: 'grpc://localhost:2135',
    database: '/mydb',
    authType: 'anonymous',
    secure: false,
};

describe('ConnectionItem', () => {
    it('creates item with focused status', () => {
        const item = new ConnectionItem(mockProfile, 'focused');
        expect(item.contextValue).toBe('connection-focused');
        expect(item.label).toBe('Test Connection');
    });

    it('creates item with connected status', () => {
        const item = new ConnectionItem(mockProfile, 'connected');
        expect(item.contextValue).toBe('connection-connected');
    });

    it('creates item with disconnected status', () => {
        const item = new ConnectionItem(mockProfile, 'disconnected');
        expect(item.contextValue).toBe('connection-disconnected');
    });

    it('sets description with endpoint and database', () => {
        const item = new ConnectionItem(mockProfile, 'focused');
        expect(item.description).toBe('grpc://localhost:2135 / /mydb');
    });

    it('sets tooltip as MarkdownString', () => {
        const item = new ConnectionItem(mockProfile, 'focused');
        expect(item.tooltip).toBeDefined();
    });

    it('has icon for each status', () => {
        for (const status of ['focused', 'connected', 'disconnected'] as const) {
            const item = new ConnectionItem(mockProfile, status);
            expect(item.iconPath).toBeDefined();
        }
    });

    it('has setFocusedConnection command', () => {
        const item = new ConnectionItem(mockProfile, 'disconnected');
        expect(item.command).toBeDefined();
        expect(item.command!.command).toBe('ydb.setFocusedConnection');
    });

    it('stores profile reference', () => {
        const item = new ConnectionItem(mockProfile, 'focused');
        expect(item.profile).toBe(mockProfile);
    });
});
