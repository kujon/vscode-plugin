import * as vscode from 'vscode';
import { CoreProblem, DiagnosticProvider } from './DiagnosticsProvider';
import { spawn } from 'child_process';
import { getToolPath } from './ToolManager';
import { writeFileSync, rmSync, mkdtempSync, readFileSync, readdirSync } from 'fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'crypto';

type CueFileType =
    'definition' |
    'parameter' |
    'template' |
    'resource';
export class CueVetDiagnosticsProvider implements DiagnosticProvider {
    private collection: vscode.DiagnosticCollection

    private tempDirectory: string | undefined;

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
        return 'cue';
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

    private getCueFileType(document: vscode.TextDocument): CueFileType {
        const dir = dirname(document.fileName);
        const baseName = basename(document.fileName);

        switch (true) {
            case baseName === 'parameter.cue':
                return 'parameter';
            case baseName === 'template.cue':
                return 'template';
            case dir.endsWith('resources'):
                return 'resource';
            case dir.endsWith('definitions'):
            default:
                return 'definition';
        }
    }

    private additionalContent(document: vscode.TextDocument): string {
        switch (this.getCueFileType(document)) {
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
                const addonDir = dirname(document.fileName);
                const parameterFilePath = join(addonDir, 'parameter.cue');
                const parameterContent = readFileSync(parameterFilePath, 'utf-8')
                    .replace(/package .+\n/, '')
                    .replace(/parameter:/, '#Parameter:');

                const resourcesDir = join(addonDir, 'resources');
                const resourcesContent = readdirSync(resourcesDir)
                    .filter(file => file.endsWith('.cue'))
                    .map(file => readFileSync(join(resourcesDir, file), 'utf-8'))
                    .map(content => content.replace(/package .+\n/, ''))
                    .join('\n');
                return `
                    ${parameterContent}
                    parameter: close(#Parameter)
                    ${resourcesContent}
                `;
            }
            case 'resource': {
                const resourceDir = dirname(document.fileName);
                const addonDir = dirname(resourceDir);
                const parameterFilePath = join(addonDir, 'parameter.cue');
                const parameterContent = readFileSync(parameterFilePath, 'utf-8')
                    .replace(/package .+\n/, '')
                    .replace(/parameter:/, '#Parameter:');
                return `
                    ${parameterContent}
                    parameter: close(#Parameter)
                `;
            }
        }
    }

    runCommand(document: vscode.TextDocument): Promise<string> {
        // This aims to replicate the technique suggested in https://kubevela-docs.oss-cn-beijing.aliyuncs.com/docs/v1.0/platform-engineers/debug-test-cue#debug-cue-template
        const additionalContent = this.additionalContent(document);
        const tempFileContent = document.getText().concat('\n').concat(additionalContent);

        const fileName = `${randomBytes(16).toString("hex")}.cue`;

        writeFileSync(`${this.tempDirectory}/${fileName}`, tempFileContent);

        const command = `${getToolPath('cue')} vet ${this.tempDirectory}/${fileName}`;

        const process = spawn(command, { shell: true });

        return new Promise((resolve, reject) => {
            process.stdout.on('data', (data) => {
                resolve(data.toString());
            });

            process.stderr.on('data', (data) => {
                const problem = data.toString();
                if (this.shouldTemporarilyIgnore(problem)) {
                    resolve(problem);
                } else {
                    reject(problem);
                }
            });
        });
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
        // "vtx-static-site".attributes.status.details.buildUrl: reference "parameter" not found:
        //     ./var/folders/1r/ftxlxmpx6g3dv3gng89htxdh0000gn/T/vela-vscode-extension-VZwSMs/e95cc7df99ba39b2f9ce74f365bf33ee.cue:10:59
        return problem
            .replace(/\n$/, '') // replace trailing newline
            .split('\n')
            .reduce<[string, string][]>((result, value, index) => {
                if (index % 2 == 0) {
                    // Start a new pair for even indices
                    result.push([value, '']);
                } else {
                    // Add to the previous pair for odd indices.
                    result[result.length - 1] = [result[result.length - 1][0], value]
                }
                return result;
            }, [])
            .map(([message, location]) => ({
                message,
                range: this.findRange(document, location),
                severity: vscode.DiagnosticSeverity.Error
            }));
    }
}