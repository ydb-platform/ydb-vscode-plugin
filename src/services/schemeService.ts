import { Driver } from '@ydbjs/core';
import { SchemeServiceDefinition, ListDirectoryResultSchema, DescribePathResultSchema } from '@ydbjs/api/scheme';
import type { Entry, ListDirectoryResult, DescribePathResult } from '@ydbjs/api/scheme';
import { StatusIds_StatusCode } from '@ydbjs/api/operation';
import { anyUnpack } from '@bufbuild/protobuf/wkt';
import { SchemeEntry, SchemeEntryType, PermissionEntry } from '../models/types';

export class SchemeService {
    constructor(private driver: Driver) {}

    async makeDirectory(path: string): Promise<void> {
        const scheme = this.driver.createClient(SchemeServiceDefinition);
        const fullPath = path.startsWith('/') ? path : `${this.driver.database}/${path}`.replace(/\/+$/, '');
        const response = await scheme.makeDirectory({ path: fullPath });

        const op = response.operation;
        if (!op || (op.status !== StatusIds_StatusCode.SUCCESS && op.status !== StatusIds_StatusCode.STATUS_CODE_UNSPECIFIED)) {
            const issues = (op?.issues ?? []).map((i: { message?: string }) => i.message).join('; ');
            throw new Error(`MakeDirectory failed: ${issues || 'unknown error'}`);
        }
    }

    async removeDirectory(path: string): Promise<void> {
        const scheme = this.driver.createClient(SchemeServiceDefinition);
        const fullPath = path.startsWith('/') ? path : `${this.driver.database}/${path}`.replace(/\/+$/, '');
        const response = await scheme.removeDirectory({ path: fullPath });

        const op = response.operation;
        if (!op || (op.status !== StatusIds_StatusCode.SUCCESS && op.status !== StatusIds_StatusCode.STATUS_CODE_UNSPECIFIED)) {
            const issues = (op?.issues ?? []).map((i: { message?: string }) => i.message).join('; ');
            throw new Error(`RemoveDirectory failed: ${issues || 'unknown error'}`);
        }
    }

    async listDirectory(path: string): Promise<SchemeEntry[]> {
        const scheme = this.driver.createClient(SchemeServiceDefinition);
        const fullPath = path.startsWith('/') ? path : `${this.driver.database}/${path}`.replace(/\/+$/, '');
        const response = await scheme.listDirectory({ path: fullPath });

        const op = response.operation;
        if (!op || (op.status !== StatusIds_StatusCode.SUCCESS && op.status !== StatusIds_StatusCode.STATUS_CODE_UNSPECIFIED)) {
            const issues = (op?.issues ?? []).map((i: { message?: string }) => i.message).join('; ');
            throw new Error(`ListDirectory failed: ${issues || 'unknown error'}`);
        }

        if (!op.result) {
            return [];
        }

        const result = anyUnpack(op.result, ListDirectoryResultSchema) as ListDirectoryResult | undefined;
        if (!result) {
            return [];
        }

        const children = result.children ?? [];
        return children.map((child: Entry) => this.mapEntry(child));
    }

    async describePath(path: string): Promise<SchemeEntry & { self: boolean }> {
        const scheme = this.driver.createClient(SchemeServiceDefinition);
        const fullPath = path.startsWith('/') ? path : `${this.driver.database}/${path}`.replace(/\/+$/, '');
        const response = await scheme.describePath({ path: fullPath });

        const op = response.operation;
        if (!op || (op.status !== StatusIds_StatusCode.SUCCESS && op.status !== StatusIds_StatusCode.STATUS_CODE_UNSPECIFIED)) {
            const issues = (op?.issues ?? []).map((i: { message?: string }) => i.message).join('; ');
            throw new Error(`DescribePath failed: ${issues || 'unknown error'}`);
        }

        if (!op.result) {
            throw new Error('DescribePath returned empty result');
        }

        const result = anyUnpack(op.result, DescribePathResultSchema) as DescribePathResult | undefined;
        if (!result?.self) {
            throw new Error('DescribePath returned empty self');
        }

        const entry = result.self;
        return {
            self: true,
            ...this.mapEntry(entry),
        };
    }

    private mapEntry(entry: Entry): SchemeEntry {
        return {
            name: entry.name ?? '',
            type: (entry.type as number) as SchemeEntryType,
            owner: entry.owner ?? undefined,
            effectivePermissions: this.mapPermissions(entry.effectivePermissions),
            permissions: this.mapPermissions(entry.permissions),
        };
    }

    private mapPermissions(perms: { subject?: string; permissionNames?: string[] }[] | null | undefined): PermissionEntry[] {
        if (!perms) {return [];}
        return perms.map(p => ({
            subject: p.subject ?? '',
            permissionNames: p.permissionNames ?? [],
        }));
    }
}
