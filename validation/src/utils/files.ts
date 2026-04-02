import { tmpdir } from "node:os";
import { normalize, join } from "node:path";
import { readdirSync, statSync } from "fs";

export function isTempFile(filePath: string): boolean {
    const systemTempDir = normalize(tmpdir());
    const normalizedPath = normalize(filePath);
    return normalizedPath.startsWith(systemTempDir);
}

/**
 * Recursively find all .cue files in a directory and its subdirectories.
 * @param dir - The directory to search
 * @param excludeFile - Optional file path to exclude from results
 * @returns Array of absolute paths to .cue files
 */
export function findCueFilesRecursively(dir: string, excludeFile?: string): string[] {
    const files: string[] = [];

    try {
        const entries = readdirSync(dir);

        for (const entry of entries) {
            const fullPath = join(dir, entry);

            // Skip the excluded file if specified
            if (excludeFile && fullPath === excludeFile) {
                continue;
            }

            const stat = statSync(fullPath);

            if (stat.isDirectory()) {
                // Recursively search subdirectories
                files.push(...findCueFilesRecursively(fullPath, excludeFile));
            } else if (entry.endsWith('.cue')) {
                files.push(fullPath);
            }
        }
    } catch (err) {
        // Directory might not exist or be readable, silently skip
        console.debug('Error reading directory:', dir, err);
    }

    return files;
}