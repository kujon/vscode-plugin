import * as vscode from 'vscode';
import { CoreProblem, DiagnosticProvider } from './DiagnosticsProvider';
import { getToolPath } from './ToolManager';
import { dirname, join, relative } from 'path';
import { getCueFileType, getCueFileTypeFromPath, findResourcesDir, CueFileType } from './utils/cue';
import { runCommand } from './utils/command';
import { mkdtempSync, existsSync, rmSync, promises as fs } from 'fs';
import { tmpdir } from 'os';
import { createHash } from 'crypto';

export class CueVetDiagnosticsProvider implements DiagnosticProvider {
    private collection: vscode.DiagnosticCollection
    private tempDirectory: string | undefined;
    private tempDirMap: Map<string, string> = new Map();

    constructor(collection: vscode.DiagnosticCollection) {
        this.collection = collection;
    }

    activate(): void {
        const directory = mkdtempSync(join(tmpdir(), 'vela-vscode-extension-'));
        console.log(directory);
        this.tempDirectory = directory;
    }

    deactivate(): void {
        if (this.tempDirectory) {
            rmSync(this.tempDirectory, { recursive: true });
        }
    }

    getName(): string {
        return 'cue vet';
    }

    isApplicable(document: vscode.TextDocument): boolean {
        return document.languageId === 'cue';
    }

    // This is a temporary measure to supress certain messages until all of the data injected by Kubevela controller can be mocked.
    // So far only context has been mocked.
    private shouldTemporarilyIgnore(problem: string): boolean {
        const regexes = [
            // some instances are incomplete; use the -c flag to show errors or suppress this message
            /some instances are incomplete/
        ];

        for (const regex of regexes) {
            const match = problem.match(regex);
            if (match !== null) {
                console.debug(`excluding ${match}`)
                return true;
            }
        }

        return false;
    }

    getCollection(): vscode.DiagnosticCollection {
        return this.collection;
    }

    getTempDirPath(document: vscode.TextDocument): string | undefined {
        return this.tempDirMap.get(document.uri.toString());
    }

    private getAddonDirectory(document: vscode.TextDocument): string {
        const currentDir = dirname(document.fileName);
        const fileType = getCueFileType(document);

        if (fileType === 'resource') {
            // For nested resources, find the resources dir then go up one level
            const resourcesDir = findResourcesDir(document.fileName);
            return resourcesDir ? dirname(resourcesDir) : dirname(currentDir);
        } else if (fileType === 'definition') {
            return dirname(currentDir);
        } else {
            return currentDir;
        }
    }

    /**
     * Transforms CUE file content by adding necessary context based on file type.
     * @param content - Original file content
     * @param fileType - Type of CUE file
     * @returns Transformed content with additional context
     */
    private transformCueContent(content: string, fileType: CueFileType): string {
        switch (fileType) {
            case 'definition':
                return `
                    ${content}
                    #Context: close({
                        appRevision:    string
                        appRevisionNum: int
                        appName:        string
                        name:           string
                        namespace:      string
                        output:         _
                        outputs:        _
                    })
                    context: #Context
                `;
            case 'parameter':
                const textWithRenamedParameter = content.replace('parameter:', '#Parameter:');
                return `
                    ${textWithRenamedParameter}
                    parameter: close(#Parameter)
                `;
            default:
                return content;
        }
    }

    private getWithAdditionalContent(document: vscode.TextDocument): string {
        const fileType = getCueFileType(document);
        const content = document.getText();
        return this.transformCueContent(content, fileType);
    }

    private async copyDirectoryFilesToTemp(addonDir: string, tempDir: string, currentFileName: string, relativePath: string = ''): Promise<void> {
        const currentDir = join(addonDir, relativePath);
        const files = await fs.readdir(currentDir);

        for (const file of files) {
            const sourcePath = join(currentDir, file);
            const relativeFilePath = join(relativePath, file);
            const stat = await fs.stat(sourcePath);

            // Skip cue.mod directory
            if (stat.isDirectory() && file === 'cue.mod') {
                continue;
            }

            // Recursively copy subdirectories
            if (stat.isDirectory()) {
                const destSubDir = join(tempDir, relativeFilePath);
                await fs.mkdir(destSubDir, { recursive: true });
                await this.copyDirectoryFilesToTemp(addonDir, tempDir, currentFileName, relativeFilePath);
                continue;
            }

            // Only copy .cue files
            if (!file.endsWith('.cue')) {
                continue;
            }

            const destPath = join(tempDir, relativeFilePath);

            // Don't copy the current file yet - we'll write it with additional content separately
            if (sourcePath === currentFileName) {
                continue;
            }

            // Read, transform, and write the file
            const content = await fs.readFile(sourcePath, 'utf-8');
            const fileType = getCueFileTypeFromPath(sourcePath, content);
            const transformedContent = this.transformCueContent(content, fileType);
            await fs.writeFile(destPath, transformedContent);
        }
    }

    async runCommand(document: vscode.TextDocument): Promise<string> {
        const addonDir = this.getAddonDirectory(document);

        // Create a stable temp directory for this document (based on hash of file path)
        const docHash = createHash('md5').update(document.fileName).digest('hex').substring(0, 8);
        const tempDir = join(this.tempDirectory!, docHash);

        // Clean up old temp dir if it exists
        if (existsSync(tempDir)) {
            rmSync(tempDir, { recursive: true });
        }
        await fs.mkdir(tempDir, { recursive: true });

        // Store the temp directory path for this document
        this.tempDirMap.set(document.uri.toString(), tempDir);

        // Copy all CUE files from addon directory to temp
        await this.copyDirectoryFilesToTemp(addonDir, tempDir, document.fileName);

        // Write the current document with any additional content needed
        // Preserve the relative path from addon directory
        const relativeFilePath = relative(addonDir, document.fileName);
        const fileContent = this.getWithAdditionalContent(document);
        const tempFilePath = join(tempDir, relativeFilePath);

        // Ensure parent directory exists
        await fs.mkdir(dirname(tempFilePath), { recursive: true });
        await fs.writeFile(tempFilePath, fileContent);

        // Vet all CUE files in the temp directory
        // https://github.com/cue-lang/cue/discussions/2747#discussioncomment-7972009
        const command = `cd "${tempDir}" && ${getToolPath('cue')} vet $(find . -not -path "./cue.mod/**/*" -name "*.cue") -c=false`;
        console.debug('Running command', command);

        const { stdout, stderr } = await runCommand(command);

        if (stderr) {
            if (this.shouldTemporarilyIgnore(stderr)) {
                return stderr;
            } else {
                throw stderr;
            }
        }

        return stdout;
    }

    private findRange(document: vscode.TextDocument, addonDir: string, locationLine: string): vscode.Range | null {
        // Parse location line like: "    ./component/vtx-job.cue:10:21"
        const match = locationLine.trim().match(/^\.\/(.+):(\d+):(\d+)$/);

        if (!match) {
            return null;
        }

        const [, relativeFilePath, lineStr, columnStr] = match;

        // Calculate the relative path of the current document from addon directory
        const currentDocRelativePath = relative(addonDir, document.fileName);

        // Only return a range if this error is for the current document
        if (relativeFilePath !== currentDocRelativePath) {
            return null;
        }

        const line = parseInt(lineStr, 10) - 1;
        const column = parseInt(columnStr, 10) - 1;

        return new vscode.Range(
            new vscode.Position(line, column),
            document.positionAt(document.offsetAt(new vscode.Position(line + 1, 0)) - 1)
        );
    }

    findCoreProblems(document: vscode.TextDocument, problem: string): CoreProblem[] {
        // Sample error:
        //
        // output.spec.components: reference "sagemakerdomain" not found:
        //     ./template.cue:16:4
        //
        // Or with multiple locations:
        // awsProvider.properties.objects.0.spec.package: invalid interpolation: undefined field: awsProviderVersio:
        //     ./provider.cue:18:13
        //     ./provider.cue:18:67

        const addonDir = this.getAddonDirectory(document);
        const lines = problem.replace(/\n$/, '').split('\n');
        const problems: CoreProblem[] = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // Lines starting with whitespace are file locations
            if (line.match(/^\s+/)) {
                // Skip location lines - they're handled when we see the message
                continue;
            }

            // This is an error message line
            const message = line;

            // Collect all following location lines
            const locations: string[] = [];
            for (let j = i + 1; j < lines.length && lines[j].match(/^\s+/); j++) {
                locations.push(lines[j]);
                i = j; // Skip these lines in outer loop
            }

            // Create a problem for each location that belongs to the current document
            for (const location of locations) {
                const range = this.findRange(document, addonDir, location);
                if (range) {
                    problems.push({
                        message,
                        range,
                        severity: vscode.DiagnosticSeverity.Error
                    });
                }
            }
        }

        return problems;
    }
}