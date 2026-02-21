// Mock VS Code API for unit testing

export class EventEmitter<T> {
    private listeners: Array<(e: T) => void> = [];
    event = (listener: (e: T) => void) => {
        this.listeners.push(listener);
        return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
    };
    fire(data: T) {
        for (const listener of this.listeners) {
            listener(data);
        }
    }
    dispose() {
        this.listeners = [];
    }
}

export enum TreeItemCollapsibleState {
    None = 0,
    Collapsed = 1,
    Expanded = 2,
}

export class TreeItem {
    label: string | { label: string };
    id?: string;
    iconPath?: ThemeIcon;
    description?: string;
    tooltip?: string | MarkdownString;
    command?: Command;
    contextValue?: string;
    collapsibleState: TreeItemCollapsibleState;

    constructor(label: string | { label: string }, collapsibleState?: TreeItemCollapsibleState) {
        this.label = label;
        this.collapsibleState = collapsibleState ?? TreeItemCollapsibleState.None;
    }
}

export class ThemeIcon {
    constructor(public readonly id: string, public readonly color?: ThemeColor) {}
}

export class ThemeColor {
    constructor(public readonly id: string) {}
}

export class MarkdownString {
    value: string;
    isTrusted?: boolean;
    constructor(value?: string) {
        this.value = value ?? '';
    }
}

export interface Command {
    title: string;
    command: string;
    arguments?: unknown[];
}

export enum CompletionItemKind {
    Text = 0,
    Method = 1,
    Function = 2,
    Constructor = 3,
    Field = 4,
    Variable = 5,
    Class = 6,
    Interface = 7,
    Module = 8,
    Property = 9,
    Unit = 10,
    Value = 11,
    Enum = 12,
    Keyword = 13,
    Snippet = 14,
    Color = 15,
    File = 16,
    Reference = 17,
    Folder = 18,
    EnumMember = 19,
    Constant = 20,
    Struct = 21,
    Event = 22,
    Operator = 23,
    TypeParameter = 24,
}

export class CompletionItem {
    label: string;
    kind?: CompletionItemKind;
    detail?: string;
    insertText?: string;

    constructor(label: string, kind?: CompletionItemKind) {
        this.label = label;
        this.kind = kind;
    }
}

export enum ProgressLocation {
    Notification = 15,
    SourceControl = 1,
    Window = 10,
}

export class Uri {
    static file(path: string) { return new Uri(path); }
    static parse(value: string) { return new Uri(value); }
    constructor(public readonly fsPath: string) {}
    toString() { return this.fsPath; }
}

export const window = {
    showInformationMessage: async (..._args: unknown[]) => undefined,
    showWarningMessage: async (..._args: unknown[]) => undefined,
    showErrorMessage: async (..._args: unknown[]) => undefined,
    showQuickPick: async (..._args: unknown[]) => undefined,
    showInputBox: async (..._args: unknown[]) => undefined,
    createWebviewPanel: (..._args: unknown[]) => ({
        webview: { html: '', postMessage: async () => true, onDidReceiveMessage: () => ({ dispose: () => {} }) },
        reveal: () => {},
        onDidDispose: () => ({ dispose: () => {} }),
        dispose: () => {},
    }),
    withProgress: async <T>(_options: unknown, task: (progress: unknown, token: unknown) => Promise<T>) => {
        return task({ report: () => {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) });
    },
    activeTextEditor: undefined as unknown,
    createOutputChannel: () => ({
        appendLine: () => {},
        append: () => {},
        show: () => {},
        dispose: () => {},
    }),
};

export const commands = {
    registerCommand: (command: string, callback: (...args: unknown[]) => unknown) => {
        return { dispose: () => {} };
    },
    executeCommand: async (..._args: unknown[]) => undefined,
};

export const workspace = {
    openTextDocument: async (_options: unknown) => ({
        getText: () => '',
        uri: Uri.file(''),
    }),
    getConfiguration: (_section?: string) => ({
        get: <T>(key: string, defaultValue?: T) => defaultValue,
        has: (_key: string) => false,
        update: async () => {},
    }),
    workspaceFolders: undefined as unknown,
    textDocuments: [] as unknown[],
    onDidChangeTextDocument: () => ({ dispose: () => {} }),
    onDidOpenTextDocument: () => ({ dispose: () => {} }),
    onDidCloseTextDocument: () => ({ dispose: () => {} }),
};

export class CancellationTokenSource {
    token = {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose: () => {} }),
    };
    cancel() { this.token.isCancellationRequested = true; }
    dispose() {}
}

export enum ViewColumn {
    Active = -1,
    Beside = -2,
    One = 1,
    Two = 2,
    Three = 3,
}

export class Disposable {
    constructor(private callOnDispose: () => void) {}
    static from(...disposables: { dispose: () => unknown }[]) {
        return new Disposable(() => disposables.forEach(d => d.dispose()));
    }
    dispose() { this.callOnDispose(); }
}

export enum DiagnosticSeverity {
    Error = 0,
    Warning = 1,
    Information = 2,
    Hint = 3,
}

export class Position {
    constructor(public readonly line: number, public readonly character: number) {}
}

export class Range {
    constructor(
        public readonly start: Position,
        public readonly end: Position,
    ) {}
}

export class Diagnostic {
    source?: string;
    constructor(
        public readonly range: Range,
        public readonly message: string,
        public readonly severity?: DiagnosticSeverity,
    ) {}
}

export const languages = {
    registerCompletionItemProvider: (..._args: unknown[]) => ({ dispose: () => {} }),
    createDiagnosticCollection: (_name?: string) => ({
        set: () => {},
        delete: () => {},
        clear: () => {},
        dispose: () => {},
    }),
};
