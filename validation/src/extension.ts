import { ExtensionContext, languages, Disposable, workspace, window } from 'vscode';
import * as vscode from 'vscode';

import { DiagnosticProvider } from './DiagnosticsProvider';
import { CueVetDiagnosticsProvider } from './CueVetDiagnosticsProvider';
import { VelaVetDiagnosticsProvider } from './VelaVetDiagnosticsProvider';
import { VelaYamlSchemaProvider } from './VelaYamlSchemaProvider';
import { CueVetCodeLensProvider } from './CueVetCodeLensProvider';
import { checkTools } from './ToolManager';

let disposables: Disposable[] = [];
const documentUpdateTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DEBOUNCE_DELAY = 500; // milliseconds

async function updateDiagnostics(document: vscode.TextDocument, diagnosticProvider: DiagnosticProvider, codeLensProvider?: CueVetCodeLensProvider): Promise<void> {
  if (await diagnosticProvider.isApplicable(document)) {
    try {
      await diagnosticProvider.runCommand(document);
      diagnosticProvider.getCollection().clear();

      // Refresh CodeLens after running command
      if (codeLensProvider && diagnosticProvider instanceof CueVetDiagnosticsProvider) {
        codeLensProvider.refresh();
      }
    } catch (problem) {
      console.debug(problem);

      const problems = await diagnosticProvider.findCoreProblems(document, problem as string);

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

function updateDiagnosticsDebounced(document: vscode.TextDocument, diagnosticProviders: DiagnosticProvider[], codeLensProvider?: CueVetCodeLensProvider): void {
  const key = document.uri.toString();

  // Clear existing timer for this document
  const existingTimer = documentUpdateTimers.get(key);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  // Set new timer
  const timer = setTimeout(() => {
    documentUpdateTimers.delete(key);
    for (const provider of diagnosticProviders) {
      updateDiagnostics(document, provider, codeLensProvider).catch((err) => {
        console.error('Error updating diagnostics:', err);
      });
    }
  }, DEBOUNCE_DELAY);

  documentUpdateTimers.set(key, timer);
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
      updateDiagnosticsDebounced(documentEvent.document, diagnosticProviders, cueVetCodeLensProvider);
    }
  }));

  context.subscriptions.push(window.onDidChangeActiveTextEditor(editor => {
    if (editor) {
      // Don't debounce when switching editors - run immediately
      for (const provider of diagnosticProviders) {
        updateDiagnostics(editor.document, provider, cueVetCodeLensProvider);
      }
    }
  }));
}

// this method is called when your extension is deactivated
export function deactivate() {
  // Clear all pending timers
  for (const timer of documentUpdateTimers.values()) {
    clearTimeout(timer);
  }
  documentUpdateTimers.clear();

  if (disposables) {
    disposables.forEach(item => item.dispose());
  }
  disposables = [];

  for (const provider of diagnosticProviders) {
    provider.deactivate();
  }
}