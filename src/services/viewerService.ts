import * as http from 'http';
import * as https from 'https';
import * as vscode from 'vscode';
import { ViewerAutocompleteResponse, ViewerAutocompleteEntity } from '../models/types';

const AUTOCOMPLETE_TIMEOUT_MS = 3_000;

const outputChannel = vscode.window.createOutputChannel('YDB Autocomplete');

function httpGet(url: URL, headers: Record<string, string>, timeoutMs: number): Promise<string> {
    const transport = url.protocol === 'https:' ? https : http;
    return new Promise<string>((resolve, reject) => {
        const req = transport.request(url, {
            method: 'GET',
            headers,
            timeout: timeoutMs,
        }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf-8');
                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP ${res.statusCode}: ${body}`));
                } else {
                    resolve(body);
                }
            });
        });
        req.on('error', (err) => reject(err));
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
        req.end();
    });
}

export async function fetchEntities(
    monitoringUrl: string,
    database: string,
    prefix: string,
    authToken?: string,
): Promise<ViewerAutocompleteEntity[]> {
    try {
        const base = monitoringUrl.endsWith('/') ? monitoringUrl : monitoringUrl + '/';
        const url = new URL('viewer/json/autocomplete', base);
        url.searchParams.set('database', database);
        url.searchParams.set('prefix', prefix);
        url.searchParams.set('limit', '1000');

        const headers: Record<string, string> = {};
        if (authToken) {
            headers['Authorization'] = authToken;
        }

        const body = await httpGet(url, headers, AUTOCOMPLETE_TIMEOUT_MS);
        const response: ViewerAutocompleteResponse = JSON.parse(body);

        if (!response.Success || !response.Result.Entities) {
            return [];
        }
        return response.Result.Entities;
    } catch (err) {
        outputChannel.appendLine(`fetchEntities error: ${err}`);
        return [];
    }
}

export async function fetchColumns(
    monitoringUrl: string,
    database: string,
    tableNames: string[],
    authToken?: string,
): Promise<ViewerAutocompleteEntity[]> {
    try {
        const base = monitoringUrl.endsWith('/') ? monitoringUrl : monitoringUrl + '/';
        const url = new URL('viewer/json/autocomplete', base);
        url.searchParams.set('database', database);
        url.searchParams.set('limit', '1000');
        for (const name of tableNames) {
            url.searchParams.append('table', name);
        }

        const headers: Record<string, string> = {};
        if (authToken) {
            headers['Authorization'] = authToken;
        }

        const body = await httpGet(url, headers, AUTOCOMPLETE_TIMEOUT_MS);
        const response: ViewerAutocompleteResponse = JSON.parse(body);

        if (!response.Success || !response.Result.Entities) {
            return [];
        }
        return response.Result.Entities;
    } catch (err) {
        outputChannel.appendLine(`fetchColumns error: ${err}`);
        return [];
    }
}
