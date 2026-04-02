import { tmpdir } from "node:os";
import { normalize } from "node:path";

export function isTempFile(filePath: string): boolean {
    const systemTempDir = normalize(tmpdir());
    const normalizedPath = normalize(filePath);
    return normalizedPath.startsWith(systemTempDir);
}