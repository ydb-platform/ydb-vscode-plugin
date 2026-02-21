import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Driver } from '@ydbjs/core';
import { AnonymousCredentialsProvider } from '@ydbjs/auth/anonymous';
import { StaticCredentialsProvider } from '@ydbjs/auth/static';
import { AccessTokenCredentialsProvider } from '@ydbjs/auth/access-token';
import { MetadataCredentialsProvider } from '@ydbjs/auth/metadata';
import type { CredentialsProvider } from '@ydbjs/auth';
import { ConnectionProfile, getEffectiveEndpoint } from '../models/connectionProfile';
import { ServiceAccountCredentialsProvider } from './serviceAccountCredentials';
import { CancellationError } from './queryService';
import { v4 as uuidv4 } from 'uuid';

// Yandex Cloud CA certificate bundled with the extension
function loadYandexCloudCa(): Buffer | undefined {
    try {
        const certPath = path.join(__dirname, '..', '..', 'certs', 'yandex-cloud-ca.pem');
        return fs.readFileSync(certPath);
    } catch {
        return undefined;
    }
}

const YANDEX_CLOUD_CA = loadYandexCloudCa();

function loadCustomCa(): Buffer | undefined {
    const certFile = vscode.workspace.getConfiguration('ydb').get<string>('tlsCaCertFile', '');
    if (!certFile) {
        return undefined;
    }
    try {
        return fs.readFileSync(certFile);
    } catch (err) {
        vscode.window.showWarningMessage(`YDB: Could not read custom CA cert file "${certFile}": ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
    }
}

const PROFILES_KEY = 'ydb.connectionProfiles';
const ACTIVE_PROFILE_KEY = 'ydb.activeProfileId';
const FOCUSED_PROFILE_KEY = 'ydb.focusedProfileId';
const CONNECTED_PROFILES_KEY = 'ydb.connectedProfileIds';

export class ConnectionManager {
    private static instance: ConnectionManager;
    private profiles: ConnectionProfile[] = [];
    private connectedProfileIds: Set<string> = new Set();
    private focusedProfileId: string | undefined;
    private driverCache: Map<string, Driver> = new Map();
    private globalState!: vscode.Memento;

    private readonly _onDidChangeConnection = new vscode.EventEmitter<ConnectionProfile | undefined>();
    readonly onDidChangeConnection = this._onDidChangeConnection.event;

    private readonly _onDidChangeProfiles = new vscode.EventEmitter<void>();
    readonly onDidChangeProfiles = this._onDidChangeProfiles.event;

    private readonly _onDidChangeConnectionStatus = new vscode.EventEmitter<string>();
    readonly onDidChangeConnectionStatus = this._onDidChangeConnectionStatus.event;

    private constructor() {}

    static getInstance(): ConnectionManager {
        if (!ConnectionManager.instance) {
            ConnectionManager.instance = new ConnectionManager();
        }
        return ConnectionManager.instance;
    }

    initialize(globalState: vscode.Memento): void {
        this.globalState = globalState;
        this.profiles = globalState.get<ConnectionProfile[]>(PROFILES_KEY, []);

        // Migration: read old activeProfileId if focusedProfileId not set
        const focusedId = globalState.get<string>(FOCUSED_PROFILE_KEY);
        if (focusedId !== undefined) {
            this.focusedProfileId = focusedId;
        } else {
            const oldActiveId = globalState.get<string>(ACTIVE_PROFILE_KEY);
            if (oldActiveId) {
                this.focusedProfileId = oldActiveId;
                globalState.update(FOCUSED_PROFILE_KEY, oldActiveId);
            }
        }

        const savedConnected = globalState.get<string[]>(CONNECTED_PROFILES_KEY, []);
        this.connectedProfileIds = new Set(savedConnected);
    }

    getProfiles(): ConnectionProfile[] {
        return [...this.profiles];
    }

    // Backward compatibility alias
    getActiveProfile(): ConnectionProfile | undefined {
        return this.getFocusedProfile();
    }

    getFocusedProfile(): ConnectionProfile | undefined {
        return this.profiles.find(p => p.id === this.focusedProfileId);
    }

    isConnected(id: string): boolean {
        return this.connectedProfileIds.has(id);
    }

    getConnectedProfileIds(): string[] {
        return [...this.connectedProfileIds];
    }

    getFocusedProfileId(): string | undefined {
        return this.focusedProfileId;
    }

    private getSecureOptions(secure: boolean, profileCaCertFile?: string): { ca: Buffer } | undefined {
        if (!secure) {
            return undefined;
        }
        // Per-profile cert has highest priority
        if (profileCaCertFile) {
            try {
                return { ca: fs.readFileSync(profileCaCertFile) };
            } catch (err) {
                vscode.window.showWarningMessage(`YDB: Could not read CA cert "${profileCaCertFile}": ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        // Then global setting
        const custom = loadCustomCa();
        if (custom) {
            return { ca: custom };
        }
        // Fallback to bundled Yandex Cloud CA
        if (YANDEX_CLOUD_CA) {
            return { ca: YANDEX_CLOUD_CA };
        }
        return undefined;
    }

    private buildConnectionString(profile: Pick<ConnectionProfile, 'endpoint' | 'host' | 'port' | 'database' | 'secure'>): string {
        const hostPort = getEffectiveEndpoint(profile);
        return `${profile.secure ? 'grpcs' : 'grpc'}://${hostPort}${profile.database.startsWith('/') ? '' : '/'}${profile.database}`;
    }

    async connectProfile(id: string, token?: vscode.CancellationToken): Promise<void> {
        const profile = this.profiles.find(p => p.id === id);
        if (!profile) {
            throw new Error(`Connection profile not found: ${id}`);
        }

        // Create driver if not cached
        if (!this.driverCache.has(id)) {
            if (token?.isCancellationRequested) {
                throw new CancellationError();
            }

            const connectionString = this.buildConnectionString(profile);
            const credentialsProvider = this.createCredentialsProvider(profile, connectionString);
            const secureOptions = this.getSecureOptions(profile.secure, profile.tlsCaCertFile);
            const driver = new Driver(connectionString, { credentialsProvider, secureOptions });

            await this.readyWithCancellation(driver, token);

            this.driverCache.set(id, driver);
        }

        this.connectedProfileIds.add(id);
        await this.saveConnectedIds();

        // Auto-focus if first connection
        if (!this.focusedProfileId || !this.connectedProfileIds.has(this.focusedProfileId)) {
            await this.setFocusedProfile(id);
        }

        this._onDidChangeConnectionStatus.fire(id);
    }

    async disconnectProfile(id: string): Promise<void> {
        const wasConnected = this.connectedProfileIds.has(id);
        this.destroyDriver(id);
        this.connectedProfileIds.delete(id);
        await this.saveConnectedIds();

        // Switch focus only if the profile was actually connected (not just focused-but-disconnected)
        if (wasConnected && this.focusedProfileId === id) {
            const remaining = [...this.connectedProfileIds];
            await this.setFocusedProfile(remaining.length > 0 ? remaining[0] : undefined);
        }

        this._onDidChangeConnectionStatus.fire(id);
    }

    async setFocusedProfile(id: string | undefined): Promise<void> {
        this.focusedProfileId = id;
        await this.globalState.update(FOCUSED_PROFILE_KEY, id);
        this._onDidChangeConnection.fire(this.getFocusedProfile());
        this._onDidChangeConnectionStatus.fire(id ?? '');
    }

    // Backward compatibility: set focused (driver created lazily in getDriver)
    async setActiveProfile(id: string | undefined): Promise<void> {
        await this.setFocusedProfile(id);
    }

    async addProfile(profile: Omit<ConnectionProfile, 'id'>): Promise<ConnectionProfile> {
        const newProfile: ConnectionProfile = { ...profile, id: uuidv4() };
        this.profiles.push(newProfile);
        await this.saveProfiles();
        this._onDidChangeProfiles.fire();

        if (this.profiles.length === 1) {
            await this.setActiveProfile(newProfile.id);
        }

        return newProfile;
    }

    async updateProfile(id: string, updates: Partial<Omit<ConnectionProfile, 'id'>>): Promise<void> {
        const index = this.profiles.findIndex(p => p.id === id);
        if (index === -1) {
            throw new Error(`Connection profile not found: ${id}`);
        }

        // Disconnect if connected (driver will be stale)
        if (this.connectedProfileIds.has(id)) {
            await this.disconnectProfile(id);
        }

        this.profiles[index] = { ...this.profiles[index], ...updates };
        await this.saveProfiles();
        this._onDidChangeProfiles.fire();
    }

    async removeProfile(id: string): Promise<void> {
        if (this.connectedProfileIds.has(id)) {
            await this.disconnectProfile(id);
        }
        this.profiles = this.profiles.filter(p => p.id !== id);
        await this.saveProfiles();

        if (this.focusedProfileId === id) {
            const connected = [...this.connectedProfileIds];
            const newFocused = connected.length > 0 ? connected[0] : undefined;
            this.focusedProfileId = newFocused;
            await this.globalState.update(FOCUSED_PROFILE_KEY, newFocused);
            this._onDidChangeConnection.fire(this.getFocusedProfile());
        }

        this._onDidChangeProfiles.fire();
        this._onDidChangeConnectionStatus.fire(id);
    }

    async getDriver(profileId?: string, token?: vscode.CancellationToken): Promise<Driver> {
        const id = profileId ?? this.focusedProfileId;
        if (!id) {
            throw new Error('No active connection. Please add a connection first.');
        }

        const cached = this.driverCache.get(id);
        if (cached) {
            return cached;
        }

        const profile = this.profiles.find(p => p.id === id);
        if (!profile) {
            throw new Error(`Connection profile not found: ${id}`);
        }

        if (token?.isCancellationRequested) {
            throw new CancellationError();
        }

        const connectionString = this.buildConnectionString(profile);
        const credentialsProvider = this.createCredentialsProvider(profile, connectionString);
        const secureOptions = this.getSecureOptions(profile.secure, profile.tlsCaCertFile);
        const driver = new Driver(connectionString, { credentialsProvider, secureOptions });

        await this.readyWithCancellation(driver, token);

        this.driverCache.set(id, driver);
        return driver;
    }

    /**
     * Creates a temporary (uncached) Driver for the given profile.
     * The caller is responsible for calling driver.close() when done.
     */
    async createTemporaryDriver(profile: Omit<ConnectionProfile, 'id'>): Promise<Driver> {
        const connectionString = this.buildConnectionString(profile as ConnectionProfile);
        const credentialsProvider = this.createCredentialsProvider(profile as ConnectionProfile, connectionString);
        const secureOptions = this.getSecureOptions(profile.secure, profile.tlsCaCertFile);
        const driver = new Driver(connectionString, { credentialsProvider, secureOptions });
        await this.readyWithCancellation(driver);
        return driver;
    }

    async testConnection(profile: Omit<ConnectionProfile, 'id'>, token?: vscode.CancellationToken): Promise<boolean> {
        if (token?.isCancellationRequested) {
            throw new CancellationError();
        }

        const connectionString = this.buildConnectionString(profile as ConnectionProfile);
        const credentialsProvider = this.createCredentialsProvider(profile as ConnectionProfile, connectionString);
        const secureOptions = this.getSecureOptions(profile.secure, profile.tlsCaCertFile);
        const driver = new Driver(connectionString, { credentialsProvider, secureOptions });

        try {
            await this.readyWithCancellation(driver, token);
            return true;
        } catch {
            return false;
        } finally {
            driver.close();
        }
    }

    private async readyWithCancellation(driver: Driver, token?: vscode.CancellationToken): Promise<void> {
        if (!token) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);
            try {
                await driver.ready(controller.signal);
            } finally {
                clearTimeout(timeout);
            }
            return;
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const disposable = token.onCancellationRequested(() => {
            controller.abort();
        });

        try {
            await driver.ready(controller.signal);
        } catch (err) {
            if (token.isCancellationRequested) {
                throw new CancellationError();
            }
            throw err;
        } finally {
            clearTimeout(timeout);
            disposable.dispose();
        }
    }

    private createCredentialsProvider(profile: ConnectionProfile, connectionString: string): CredentialsProvider {
        switch (profile.authType) {
            case 'anonymous':
                return new AnonymousCredentialsProvider();
            case 'static':
                return new StaticCredentialsProvider(
                    { username: profile.username ?? '', password: profile.password ?? '' },
                    connectionString,
                );
            case 'token':
                return new AccessTokenCredentialsProvider({ token: profile.token ?? '' });
            case 'metadata':
                return new MetadataCredentialsProvider();
            case 'serviceAccount':
                if (profile.serviceAccountKeyFile) {
                    return new ServiceAccountCredentialsProvider(profile.serviceAccountKeyFile);
                }
                // Fallback: use token if provided, otherwise anonymous
                if (profile.token) {
                    return new AccessTokenCredentialsProvider({ token: profile.token });
                }
                return new AnonymousCredentialsProvider();
            default:
                return new AnonymousCredentialsProvider();
        }
    }

    private destroyDriver(id: string): void {
        const driver = this.driverCache.get(id);
        if (driver) {
            driver.close();
            this.driverCache.delete(id);
        }
    }

    private async saveProfiles(): Promise<void> {
        await this.globalState.update(PROFILES_KEY, this.profiles);
    }

    private async saveConnectedIds(): Promise<void> {
        await this.globalState.update(CONNECTED_PROFILES_KEY, [...this.connectedProfileIds]);
    }

    async dispose(): Promise<void> {
        for (const [id] of this.driverCache) {
            this.destroyDriver(id);
        }
        this._onDidChangeConnection.dispose();
        this._onDidChangeProfiles.dispose();
        this._onDidChangeConnectionStatus.dispose();
    }
}
