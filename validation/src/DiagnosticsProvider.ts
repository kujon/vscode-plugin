import * as vscode from 'vscode';

export type CoreProblem = {
    message: string,
    range: vscode.Range,
    severity: vscode.DiagnosticSeverity
}

export interface DiagnosticProvider {
    getName(): string

    isApplicable(document: vscode.TextDocument): boolean

    getCollection(): vscode.DiagnosticCollection

    runCommand(document: vscode.TextDocument): Promise<string>

    findCoreProblems(document: vscode.TextDocument, problem: string): CoreProblem[]

    activate(): void

    deactivate(): void
}