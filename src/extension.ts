import * as vscode from "vscode";
import * as path from "path";
import * as cp from "child_process";

const FALKON_EXTENSIONS = new Set([".flk"]);
let hasShownInSession = false;
let statusBarItem: vscode.StatusBarItem | undefined;

function isFalkonFile(fsPath: string): boolean {
  return FALKON_EXTENSIONS.has(path.extname(fsPath).toLowerCase());
}

async function buildAndRun(document: vscode.TextDocument): Promise<void> {
  const filePath = document.uri.fsPath;
  if (!isFalkonFile(filePath)) {
    return;
  }

  // Save the document first so the latest changes are compiled
  if (document.isDirty) {
    await document.save();
  }

  const folder = path.dirname(filePath);
  const fileName = path.parse(filePath).name;
  const isWindows = process.platform === "win32";
  const exeName = isWindows ? `${fileName}.exe` : fileName;

  // Always dispose and recreate terminal so cwd is always correct
  const existingTerminal = vscode.window.terminals.find(
    (t: vscode.Terminal) => t.name === "Falkon Run"
  );
  if (existingTerminal) {
    existingTerminal.dispose();
  }
  const terminal = vscode.window.createTerminal({
    name: "Falkon Run",
    cwd: folder,
    shellPath: isWindows ? "powershell.exe" : undefined,
  });

  terminal.show(true);

  // Build and conditionally run (only if build succeeds)
  const buildCmd = `falkon build "${path.basename(filePath)}"`;
  const runCmd = isWindows ? `& ".\\${exeName}"` : `./"${exeName}"`;
  const fullCmd = isWindows
    ? `${buildCmd} ; if ($LASTEXITCODE -eq 0) { ${runCmd} }`
    : `${buildCmd} && ${runCmd}`;

  terminal.sendText(fullCmd);
}

class FalkonDebugConfigurationProvider
  implements vscode.DebugConfigurationProvider
{
  provideDebugConfigurations(
    folder: vscode.WorkspaceFolder | undefined,
    token?: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.DebugConfiguration[]> {
    return [{ type: "falkon", name: "Launch", request: "launch" }];
  }

  async resolveDebugConfiguration(
    folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
    token?: vscode.CancellationToken
  ): Promise<vscode.DebugConfiguration | undefined> {
    const falkonConfig = vscode.workspace.getConfiguration("falkon");
    if (!falkonConfig.get<boolean>("enableDebugIntercept", true)) {
      return undefined;
    }

    if (!config.type && !config.request && !config.name) {
      config.type = "falkon";
      config.name = "Launch";
      config.request = "launch";
    }

    const editor = vscode.window.activeTextEditor;
    if (editor && isFalkonFile(editor.document.uri.fsPath)) {
      await buildAndRun(editor.document);
    } else {
      vscode.window.showErrorMessage(
        editor ? "Active file is not a .flk file." : "No active Falkon file to run."
      );
    }

    return undefined;
  }
}

function checkFalkonInstallation(
  bar: vscode.StatusBarItem,
  showNotification: boolean
): Promise<boolean> {
  return new Promise((resolve) => {
    cp.exec("falkon -v", (error, stdout, stderr) => {
      if (error) {
        bar.text = `$(alert) Falkon: CLI Missing`;
        bar.tooltip = `Falkon compiler not found in PATH. Click to verify.`;
        bar.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
        if (showNotification) {
          vscode.window.showErrorMessage(
            "Falkon CLI not found in PATH. Please install it and add it to your system PATH."
          );
        }
        resolve(false);
      } else {
        const version = stdout.trim() || stderr.trim() || "unknown version";
        bar.text = `$(check) Falkon: Ready`;
        bar.tooltip = `Falkon compiler is ready.\nVersion: ${version}`;
        bar.backgroundColor = undefined;
        if (showNotification) {
          vscode.window.showInformationMessage(`Falkon CLI is ready! (${version})`);
        }
        resolve(true);
      }
    });
  });
}

export function activate(context: vscode.ExtensionContext): void {
  console.log("Falkon extension activating...");

  // context.extension is guaranteed available in VS Code 1.74+ (we require 1.90+).
  // Using it directly is the most reliable way to get the exact extension ID and
  // version without path-comparison heuristics that can fail on Windows.
  const extensionId = context.extension.id.toLowerCase();
  const currentVersion: string = context.extension.packageJSON.version;

  console.log(`Falkon: extensionId = "${extensionId}", version = "${currentVersion}"`);

  // Status bar item
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = "falkon.checkCli";
  context.subscriptions.push(statusBarItem);

  // Debug configuration provider (intercepts F5 for .flk files)
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider("falkon", new FalkonDebugConfigurationProvider())
  );

  // Command: falkon.buildAndRun
  context.subscriptions.push(
    vscode.commands.registerCommand("falkon.buildAndRun", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage("No active editor.");
        return;
      }
      if (!isFalkonFile(editor.document.uri.fsPath)) {
        vscode.window.showWarningMessage("Active file is not a .flk Falkon source file.");
        return;
      }
      await buildAndRun(editor.document);
    })
  );

  const checkCompletionStatus = () => {
    const hasVerifiedCli = context.globalState.get<boolean>("falkon.hasVerifiedCli", false);
    const hasOpenedSettings = context.globalState.get<boolean>("falkon.hasOpenedSettings", false);
    if (hasVerifiedCli && hasOpenedSettings) {
      context.globalState.update("falkon.walkthroughCompleted", true);
    }
  };

  let hasPromptedThisSession = false;

  const triggerOnboardingPrompt = () => {
    if (hasPromptedThisSession) {
      return;
    }
    const isCompleted = context.globalState.get<boolean>("falkon.walkthroughCompleted", false);
    const isDismissed = context.globalState.get<boolean>("falkon.walkthroughPromptDismissed", false);

    if (!isCompleted && !isDismissed) {
      hasPromptedThisSession = true;
      vscode.window.showInformationMessage(
        "Welcome to Falkon! Get started by verifying the compiler CLI and configuring your shortcuts.",
        "Open Walkthrough",
        "Don't Show Again"
      ).then((selection) => {
        if (selection === "Open Walkthrough") {
          context.globalState.update("falkon.walkthroughPromptDismissed", true);
          vscode.commands.executeCommand("falkon.showWalkthrough");
        } else if (selection === "Don't Show Again") {
          context.globalState.update("falkon.walkthroughPromptDismissed", true);
        }
      });
    }
  };

  // Command: falkon.checkCli
  context.subscriptions.push(
    vscode.commands.registerCommand("falkon.checkCli", async () => {
      context.globalState.update("falkon.hasVerifiedCli", true);
      checkCompletionStatus();
      const existing = vscode.window.terminals.find(
        (t: vscode.Terminal) => t.name === "Falkon Check"
      );
      if (existing) { existing.dispose(); }
      const isWindows = process.platform === "win32";
      const checkTerminal = vscode.window.createTerminal({
        name: "Falkon Check",
        shellPath: isWindows ? "powershell.exe" : undefined,
      });
      checkTerminal.show(false);
      checkTerminal.sendText("falkon -v");
      if (statusBarItem) {
        await checkFalkonInstallation(statusBarItem, true);
      }
    })
  );

  // Command: falkon.openSettings
  context.subscriptions.push(
    vscode.commands.registerCommand("falkon.openSettings", () => {
      context.globalState.update("falkon.hasOpenedSettings", true);
      checkCompletionStatus();
      vscode.commands.executeCommand("workbench.action.openSettings", "falkon");
    })
  );

  // Command: falkon.showWalkthrough
  // The walkthrough ID "falkonWalkthrough" must match the "id" field in package.json exactly.
  const WALKTHROUGH_ID = `${extensionId}#falkonWalkthrough`;
  context.subscriptions.push(
    vscode.commands.registerCommand("falkon.showWalkthrough", () => {
      console.log(`Falkon: opening walkthrough "${WALKTHROUGH_ID}"`);
      vscode.commands.executeCommand("workbench.action.openWalkthrough", WALKTHROUGH_ID, false);
    })
  );

  // Command: falkon.resetOnboarding
  context.subscriptions.push(
    vscode.commands.registerCommand("falkon.resetOnboarding", async () => {
      await context.globalState.update("falkon.hasVerifiedCli", undefined);
      await context.globalState.update("falkon.hasOpenedSettings", undefined);
      await context.globalState.update("falkon.walkthroughCompleted", undefined);
      await context.globalState.update("falkon.walkthroughPromptDismissed", undefined);
      hasPromptedThisSession = false;
      vscode.window.showInformationMessage("Falkon onboarding state has been reset.");
    })
  );

  // Listen for config changes to track shortcut configuration step completion
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("falkon.shortcutPreset") || e.affectsConfiguration("falkon.enableDebugIntercept")) {
        context.globalState.update("falkon.hasOpenedSettings", true);
        checkCompletionStatus();
      }
    })
  );

  // Status bar: show only when a .flk file is active
  const updateStatusBar = (editor?: vscode.TextEditor) => {
    if (!statusBarItem) { return; }
    if (editor && isFalkonFile(editor.document.uri.fsPath)) {
      statusBarItem.show();
      triggerOnboardingPrompt();
    } else {
      statusBarItem.hide();
    }
  };
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(updateStatusBar));
  updateStatusBar(vscode.window.activeTextEditor);

  // Silent CLI check on activation to set initial status bar state
  checkFalkonInstallation(statusBarItem, false);

  // ─── Auto-open walkthrough ────────────────────────────────────────────────
  // activationEvents includes "onStartupFinished" which guarantees:
  //   1. All extension contribution points (including walkthroughs) are fully
  //      registered in VS Code's getting-started service before this runs.
  //   2. The workbench Welcome panel is initialised and ready.
  //
  // This activation event ALSO fires after VS Code restarts the extension host
  // during a mid-session VSIX install, covering both first-install and reinstall.
  //
  // Condition: show on every new extension-host process (!hasShownInSession)
  // OR when the extension version changes (update scenario).
  // hasShownInSession is a module-level var, so it resets to false on every
  // extension-host restart — meaning every install/reload shows the walkthrough.
  const lastVersion = context.globalState.get<string>("lastVersion");
  if (!hasShownInSession || lastVersion !== currentVersion) {
    hasShownInSession = true;
    context.globalState.update("lastVersion", currentVersion);
    console.log(`Falkon: scheduling walkthrough open with ID "${WALKTHROUGH_ID}"`);
    setTimeout(() => {
      console.log(`Falkon: firing openWalkthrough "${WALKTHROUGH_ID}"`);
      vscode.commands.executeCommand("workbench.action.openWalkthrough", WALKTHROUGH_ID, false);
    }, 1000);
  }
}

export function deactivate(): void {}
