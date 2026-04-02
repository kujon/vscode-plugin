import { spawn } from 'child_process';

export interface CommandResult {
    stdout: string;
    stderr: string;
}

/**
 * Executes a shell command and accumulates all output until the process completes.
 * This prevents issues where output arrives in multiple chunks and only the first chunk is captured.
 */
export function runCommand(command: string): Promise<CommandResult> {
    const process = spawn(command, { shell: true });

    return new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';

        process.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        process.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        process.on('close', (code) => {
            // Always resolve with both stdout and stderr, let the caller decide how to handle it
            resolve({ stdout, stderr });
        });

        process.on('error', (error) => {
            reject(error);
        });
    });
}
