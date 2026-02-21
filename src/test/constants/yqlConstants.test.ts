import { describe, it, expect } from 'vitest';
import {
    SimpleTypes,
    SimpleFunctions,
    AggregateFunctions,
    WindowFunctions,
    TableFunctions,
    Udfs,
    Pragmas,
    EntitySettings,
} from '../../constants/yqlConstants';

describe('yqlConstants', () => {
    it('SimpleTypes contains common types', () => {
        expect(SimpleTypes).toContain('Int32');
        expect(SimpleTypes).toContain('String');
        expect(SimpleTypes).toContain('Bool');
        expect(SimpleTypes).toContain('Utf8');
        expect(SimpleTypes).toContain('Timestamp');
        expect(SimpleTypes).toContain('Json');
        expect(SimpleTypes.length).toBeGreaterThan(30);
    });

    it('SimpleFunctions contains common functions', () => {
        expect(SimpleFunctions).toContain('CAST');
        expect(SimpleFunctions).toContain('COALESCE');
        expect(SimpleFunctions).toContain('IF');
        expect(SimpleFunctions).toContain('ListCreate');
        expect(SimpleFunctions).toContain('DictCreate');
        expect(SimpleFunctions.length).toBeGreaterThan(100);
    });

    it('AggregateFunctions contains common aggregates', () => {
        expect(AggregateFunctions).toContain('COUNT');
        expect(AggregateFunctions).toContain('SUM');
        expect(AggregateFunctions).toContain('AVG');
        expect(AggregateFunctions).toContain('MIN');
        expect(AggregateFunctions).toContain('MAX');
        expect(AggregateFunctions.length).toBeGreaterThan(20);
    });

    it('WindowFunctions contains window functions', () => {
        expect(WindowFunctions).toContain('ROW_NUMBER');
        expect(WindowFunctions).toContain('LAG');
        expect(WindowFunctions).toContain('LEAD');
        expect(WindowFunctions).toContain('RANK');
    });

    it('Udfs are in Module::Function format', () => {
        expect(Udfs.length).toBeGreaterThan(100);
        for (const udf of Udfs) {
            expect(udf).toMatch(/^[A-Za-z0-9]+::[A-Za-z]/);
        }
    });

    it('Udfs contains common UDFs', () => {
        expect(Udfs).toContain('DateTime::Format');
        expect(Udfs).toContain('String::Contains');
        expect(Udfs).toContain('Math::Abs');
        expect(Udfs).toContain('Digest::Md5Hex');
    });

    it('Pragmas is non-empty', () => {
        expect(Pragmas).toContain('TablePathPrefix');
        expect(Pragmas.length).toBeGreaterThan(0);
    });

    it('EntitySettings has table settings', () => {
        expect(EntitySettings.table).toContain('AUTO_PARTITIONING_BY_SIZE');
        expect(EntitySettings.table.length).toBeGreaterThan(5);
    });

    it('EntitySettings has topic settings', () => {
        expect(EntitySettings.topic).toContain('retention_period');
    });

    it('TableFunctions is an array', () => {
        expect(Array.isArray(TableFunctions)).toBe(true);
    });
});
