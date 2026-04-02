import * as vscode from 'vscode';
import { CoreProblem, DiagnosticProvider } from './DiagnosticsProvider';
import { getToolPath } from './ToolManager';
import { writeFileSync, rmSync, mkdtempSync, readFileSync } from 'fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'crypto';
import { getCueFileType, findResourcesDir } from './utils/cue';
import { runCommand } from './utils/command';
import { findCueFilesRecursively } from './utils/files';
export class CueVetDiagnosticsProvider implements DiagnosticProvider {
    private collection: vscode.DiagnosticCollection

    private tempDirectory: string | undefined;
    private tempFileMap: Map<string, string> = new Map();

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

    getTempFilePath(document: vscode.TextDocument): string | undefined {
        return this.tempFileMap.get(document.uri.toString());
    }

    private processAdditionalContent(content: string): string {
        // package cannot be defined multiple times in a single file,
        // so we remove it from the content we append to the main file.
        return content.replace(/package .+\n/, '');
    }

    private getParameterContent(document: vscode.TextDocument): string {
        const currentDir = dirname(document.fileName);
        const fileType = getCueFileType(document);
        let addonDir: string;

        if (fileType == 'resource') {
            // For nested resources, find the resources dir then go up one level
            const resourcesDir = findResourcesDir(document.fileName);
            addonDir = resourcesDir ? dirname(resourcesDir) : dirname(currentDir);
        } else if (fileType == 'definition') {
            addonDir = dirname(currentDir);
        } else {
            addonDir = currentDir;
        }

        const parameterFilePath = join(addonDir, 'parameter.cue');
        const parameterContent = this.processAdditionalContent(
            readFileSync(parameterFilePath, 'utf-8').replace(/parameter:/, '#Parameter:')
        );

        return `
            ${parameterContent}
            parameter: close(#Parameter)
        `
    }

    private getResourcesContent(document: vscode.TextDocument): string {
        const currentDir = dirname(document.fileName);
        const fileType = getCueFileType(document);
        let resourcesDir: string = '';
        if (fileType === 'resource') {
            // For nested resources, find the root resources directory
            resourcesDir = findResourcesDir(document.fileName);
        } else if (fileType === 'definition') {
            resourcesDir = join(dirname(currentDir), 'resources');
        } else if (fileType === 'parameter' || fileType === 'template') {
            resourcesDir = join(currentDir, 'resources');
        }

        const cueFiles = findCueFilesRecursively(resourcesDir, document.fileName);

        return cueFiles
            .map(file => readFileSync(file, 'utf-8'))
            .map(content => this.processAdditionalContent(content))
            .join('\n');
    }

    // Extra cue needs to be appended to the end of the file we are editing.
    // Appended, so that we are not messing with original line numbers.
    private additionalContent(document: vscode.TextDocument): string {
        switch (getCueFileType(document)) {
            case 'definition':
                return `#Context: close({
                    appRevision:    string
                    appRevisionNum: int
                    appName:        string
                    name:           string
                    namespace:      string
                    output:         _
                    outputs:        _
                })
                context: #Context`;
            case 'parameter':
                return '';
            case 'template': {
                return `
                    ${this.getParameterContent(document)}
                    ${this.getResourcesContent(document)}
                `;
            }
            case 'resource': {
                return `
                    ${this.getParameterContent(document)}
                    ${this.getResourcesContent(document)}
                `;
            }
            case 'unknown':
                return '';
            case 'generated':
                return '';
        }
    }

    async runCommand(document: vscode.TextDocument): Promise<string> {
        // This aims to replicate the technique suggested in https://kubevela-docs.oss-cn-beijing.aliyuncs.com/docs/v1.0/platform-engineers/debug-test-cue#debug-cue-template
        const additionalContent = this.additionalContent(document);
        const tempFileContent = document.getText().concat('\n').concat(additionalContent);

        const fileName = `${randomBytes(16).toString("hex")}.cue`;
        const tempFilePath = `${this.tempDirectory}/${fileName}`;

        writeFileSync(tempFilePath, tempFileContent);

        // Store the temp file path for this document
        this.tempFileMap.set(document.uri.toString(), tempFilePath);

        const command = `${getToolPath('cue')} vet ${tempFilePath}`;
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

    private findRange(document: vscode.TextDocument, problem: string): vscode.Range {
        // ./var/folders/1r/ftxlxmpx6g3dv3gng89htxdh0000gn/T/vela-vscode-extension-VZwSMs/e95cc7df99ba39b2f9ce74f365bf33ee.cue:10:21
        const lineAndColumn = problem.match(/(.+)\:(\d+)\:(\d+)\n?$/)?.slice(2).map(val => parseInt(val, 10) - 1);

        if (lineAndColumn?.length == 2) {
            let [line, column] = lineAndColumn;

            return new vscode.Range(
                new vscode.Position(line, column),
                document.positionAt(document.offsetAt(new vscode.Position(line + 1, 0)) - 1)
            );
        } else {
            return new vscode.Range(new vscode.Position(0, 0), new vscode.Position(document.lineCount, 0));
        }
    }

    findCoreProblems(document: vscode.TextDocument, problem: string): CoreProblem[] {
        // Sample error:
        //
        // "vtx-static-site".attributes.status.details.buildUrl: reference "parameter" not found:
        //     ./var/folders/1r/ftxlxmpx6g3dv3gng89htxdh0000gn/T/vela-vscode-extension-VZwSMs/e95cc7df99ba39b2f9ce74f365bf33ee.cue:10:21
        //
        // Or with multiple locations:
        // awsProvider.properties.objects.0.spec.package: invalid interpolation: undefined field: awsProviderVersio:
        //     ./var/folders/.../23f6fd7cc9374e8f0edf8f898054d4f8.cue:18:13
        //     ./var/folders/.../23f6fd7cc9374e8f0edf8f898054d4f8.cue:18:67

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

            // Create a problem for each location
            for (const location of locations) {
                problems.push({
                    message,
                    range: this.findRange(document, location),
                    severity: vscode.DiagnosticSeverity.Error
                });
            }
        }

        return problems;
    }
}