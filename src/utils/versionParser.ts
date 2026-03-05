export interface YdbVersion {
    major: number;
    minor: number;
    raw: string;
    isStable: boolean;
}

/**
 * Parses a YDB version string (possibly base64-encoded) into structured form.
 * Examples: "stable-25-4", "stable-26-1-8", base64-encoded versions, "main", "trunk", "dev"
 */
export function parseYdbVersion(version: string): YdbVersion | undefined {
    if (!version || !version.trim()) {
        return undefined;
    }

    let decoded = version.trim();

    // Try base64 decoding
    try {
        const candidate = Buffer.from(decoded, 'base64').toString('utf-8');
        if (/^[a-z0-9.-]+$/i.test(candidate)) {
            decoded = candidate;
        }
    } catch {
        // not base64, use as-is
    }

    if (decoded.startsWith('stable-')) {
        const match = decoded.match(/^stable-(\d+)-(\d+)/);
        if (match) {
            return {
                major: parseInt(match[1], 10),
                minor: parseInt(match[2], 10),
                raw: decoded,
                isStable: true,
            };
        }
        return undefined;
    }

    // Non-stable builds (main, trunk, dev, etc.)
    if (/^[a-z]/i.test(decoded)) {
        return {
            major: Infinity,
            minor: Infinity,
            raw: decoded,
            isStable: false,
        };
    }

    return undefined;
}

/**
 * Checks if the YDB version meets minimum requirements.
 */
export function isVersionSupported(version: string, minMajor: number, minMinor: number): boolean {
    const parsed = parseYdbVersion(version);
    if (!parsed) {
        return false;
    }

    // Non-stable builds are always supported
    if (!parsed.isStable) {
        return true;
    }

    return parsed.major > minMajor || (parsed.major === minMajor && parsed.minor >= minMinor);
}
