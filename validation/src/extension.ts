import { ExtensionContext, languages, Disposable, workspace, window } from 'vscode';
import * as vscode from 'vscode';

import { DiagnosticProvider } from './DiagnosticsProvider';
import { CueVetDiagnosticsProvider } from './CueVetDiagnosticsProvider';
import { VelaVetDiagnosticsProvider } from './VelaVetDiagnosticsProvider';
import { VelaYamlSchemaProvider } from './VelaYamlSchemaProvider';
import { CueVetCodeLensProvider } from './CueVetCodeLensProvider';
import { checkTools } from './ToolManager';

let disposables: Disposable[] = [];


async function updateDiagnostics(document: vscode.TextDocument, diagnosticProvider: DiagnosticProvider, codeLensProvider?: CueVetCodeLensProvider): Promise<void> {
  if (diagnosticProvider.isApplicable(document)) {
    try {
      await diagnosticProvider.runCommand(document);
      diagnosticProvider.getCollection().clear();

      // Refresh CodeLens after running command
      if (codeLensProvider && diagnosticProvider instanceof CueVetDiagnosticsProvider) {
        codeLensProvider.refresh();
      }
    } catch (problem) {
      console.debug(problem);

      const problems = diagnosticProvider.findCoreProblems(document, problem as string);

      diagnosticProvider.getCollection().set(
        document.uri,
        problems.map(problem => ({
          message: problem.message,
          range: problem.range,
          severity: problem.severity,
          source: diagnosticProvider.getName(),
          relatedInformation: [
            new vscode.DiagnosticRelatedInformation(new vscode.Location(document.uri, problem.range), problem.message)
          ]
        }))
      );

      // Refresh CodeLens after diagnostics are set
      if (codeLensProvider && diagnosticProvider instanceof CueVetDiagnosticsProvider) {
        codeLensProvider.refresh();
      }
    }
  } else {
    diagnosticProvider.getCollection().clear();
  }
}

const cueVetDiagnosticsProvider = new CueVetDiagnosticsProvider(languages.createDiagnosticCollection('cue vet'));

const diagnosticProviders: DiagnosticProvider[] = [
  new VelaVetDiagnosticsProvider(languages.createDiagnosticCollection('vela vet')),
  cueVetDiagnosticsProvider
];

export async function activate(context: ExtensionContext) {
  checkTools();

  const yamlSchemaProvider = new VelaYamlSchemaProvider(context.globalStorageUri.fsPath);
  await yamlSchemaProvider.register();

  // Register CodeLens provider for CUE files
  const cueVetCodeLensProvider = new CueVetCodeLensProvider(cueVetDiagnosticsProvider);
  context.subscriptions.push(
    languages.registerCodeLensProvider(
      { language: 'cue' },
      cueVetCodeLensProvider
    )
  );

  for (const provider of diagnosticProviders) {
    provider.activate();
  }

  if (window.activeTextEditor) {
    for (const provider of diagnosticProviders) {
      updateDiagnostics(window.activeTextEditor.document, provider, cueVetCodeLensProvider);
    }
  }

  context.subscriptions.push(workspace.onDidChangeTextDocument(documentEvent => {
    if (documentEvent) {
      for (const provider of diagnosticProviders) {
        updateDiagnostics(documentEvent.document, provider, cueVetCodeLensProvider);
      }
    }
  }));

  context.subscriptions.push(window.onDidChangeActiveTextEditor(editor => {
    if (editor) {
      for (const provider of diagnosticProviders) {
        updateDiagnostics(editor.document, provider, cueVetCodeLensProvider);
      }
    }
  }));
}

// this method is called when your extension is deactivated
export function deactivate() {
  if (disposables) {
    disposables.forEach(item => item.dispose());
  }
  disposables = [];

  for (const provider of diagnosticProviders) {
    provider.deactivate();
  }
}