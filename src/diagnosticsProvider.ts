import * as vscode from 'vscode';
import { parseYqlQueryWithoutCursor } from '@gravity-ui/websql-autocomplete/yql';

const DEBOUNCE_MS = 500;

export class DiagnosticsProvider implements vscode.Disposable {
    private diagnosticCollection: vscode.DiagnosticCollection;
    private disposables: vscode.Disposable[] = [];
    private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

    constructor() {
        this.diagnosticCollection = vscode.languages.createDiagnosticCollection('yql');

        this.disposables.push(
            vscode.workspace.onDidChangeTextDocument(e => {
                if (e.document.languageId === 'yql') {
                    this.scheduleValidation(e.document);
                }
            }),
            vscode.workspace.onDidOpenTextDocument(doc => {
                if (doc.languageId === 'yql') {
                    this.scheduleValidation(doc);
                }
            }),
            vscode.workspace.onDidCloseTextDocument(doc => {
                this.diagnosticCollection.delete(doc.uri);
                const key = doc.uri.toString();
                const timer = this.debounceTimers.get(key);
                if (timer) {
                    clearTimeout(timer);
                    this.debounceTimers.delete(key);
                }
            }),
        );

        // Validate already open documents
        for (const doc of vscode.workspace.textDocuments) {
            if (doc.languageId === 'yql') {
                this.validate(doc);
            }
        }
    }

    private scheduleValidation(document: vscode.TextDocument): void {
        const key = document.uri.toString();
        const existing = this.debounceTimers.get(key);
        if (existing) {
            clearTimeout(existing);
        }
        this.debounceTimers.set(key, setTimeout(() => {
            this.debounceTimers.delete(key);
            this.validate(document);
        }, DEBOUNCE_MS));
    }

    private validate(document: vscode.TextDocument): void {
        const text = document.getText();
        if (!text.trim()) {
            this.diagnosticCollection.set(document.uri, []);
            return;
        }

        try {
            const { errors } = parseYqlQueryWithoutCursor(text);
            if (!errors || errors.length === 0) {
                this.diagnosticCollection.set(document.uri, []);
                return;
            }

            const diagnostics: vscode.Diagnostic[] = errors.map((error: { startLine: number; startColumn: number; endLine: number; endColumn: number; message: string }) => {
                const range = new vscode.Range(
                    new vscode.Position(error.startLine - 1, error.startColumn),
                    new vscode.Position(error.endLine - 1, error.endColumn),
                );
                const diagnostic = new vscode.Diagnostic(
                    range,
                    'Syntax error',
                    vscode.DiagnosticSeverity.Error,
                );
                diagnostic.source = 'YQL';
                return diagnostic;
            });

            this.diagnosticCollection.set(document.uri, diagnostics);
        } catch {
            this.diagnosticCollection.set(document.uri, []);
        }
    }

    dispose(): void {
        for (const timer of this.debounceTimers.values()) {
            clearTimeout(timer);
        }
        this.debounceTimers.clear();
        this.diagnosticCollection.dispose();
        for (const d of this.disposables) {
            d.dispose();
        }
    }
}
