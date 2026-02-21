/**
 * In-memory implementation of vscode.Memento for testing.
 */
export class MockMemento {
    private storage = new Map<string, unknown>();

    get<T>(key: string): T | undefined;
    get<T>(key: string, defaultValue: T): T;
    get<T>(key: string, defaultValue?: T): T | undefined {
        if (this.storage.has(key)) {
            return this.storage.get(key) as T;
        }
        return defaultValue;
    }

    async update(key: string, value: unknown): Promise<void> {
        if (value === undefined) {
            this.storage.delete(key);
        } else {
            this.storage.set(key, value);
        }
    }

    keys(): readonly string[] {
        return [...this.storage.keys()];
    }
}
