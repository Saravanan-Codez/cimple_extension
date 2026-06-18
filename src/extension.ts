import * as vscode from "vscode";
import * as path from "path";
import * as cp from "child_process";

const FALKON_EXTENSIONS = new Set([".flk"]);
let hasShownInSession = false;
let statusBarItem: vscode.StatusBarItem | undefined;
let welcomePanel: vscode.WebviewPanel | undefined;

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
    cp.exec("falkon -v", { timeout: 5000 }, (error, stdout, stderr) => {
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
      checkCompletionStatus(context);
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
      checkCompletionStatus(context);
      vscode.commands.executeCommand("workbench.action.openSettings", "falkon");
    })
  );

  // Command: falkon.showWalkthrough (opens our custom welcome webview)
  context.subscriptions.push(
    vscode.commands.registerCommand("falkon.showWalkthrough", () => {
      showWelcomeWebview(context);
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
      if (welcomePanel) {
        welcomePanel.webview.postMessage({ command: "resetProgress" });
      }
      vscode.window.showInformationMessage("Falkon onboarding state has been reset.");
    })
  );

  // Listen for config changes to track shortcut configuration step completion
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("falkon.shortcutPreset") || e.affectsConfiguration("falkon.enableDebugIntercept")) {
        context.globalState.update("falkon.hasOpenedSettings", true);
        checkCompletionStatus(context);
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

  // ─── Auto-open welcome page ────────────────────────────────────────────────
  const lastVersion = context.globalState.get<string>("lastVersion");
  
  // If version changes (update scenario), reset completion states so onboarding runs again
  if (lastVersion && lastVersion !== currentVersion) {
    context.globalState.update("falkon.walkthroughCompleted", undefined);
    context.globalState.update("falkon.hasVerifiedCli", undefined);
    context.globalState.update("falkon.hasOpenedSettings", undefined);
  }

  const isCompleted = context.globalState.get<boolean>("falkon.walkthroughCompleted", false);
  if (!isCompleted && (!hasShownInSession || lastVersion !== currentVersion)) {
    hasShownInSession = true;
    context.globalState.update("lastVersion", currentVersion);
    console.log("Falkon: scheduling welcome page open");
    setTimeout(() => {
      console.log("Falkon: opening welcome page");
      showWelcomeWebview(context);
    }, 1000);
  }
}

export function deactivate(): void {}

function showWelcomeWebview(context: vscode.ExtensionContext) {
  if (welcomePanel) {
    welcomePanel.reveal(vscode.ViewColumn.One);
    return;
  }

  welcomePanel = vscode.window.createWebviewPanel(
    "falkonWelcome",
    "Welcome to Falkon",
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(context.extensionPath, "resources")),
      ],
    }
  );

  // Convert SVG paths to webview URIs
  const welcomeSvgUri = welcomePanel.webview.asWebviewUri(
    vscode.Uri.file(path.join(context.extensionPath, "resources", "images", "welcome.svg"))
  );
  const verifyCliSvgUri = welcomePanel.webview.asWebviewUri(
    vscode.Uri.file(path.join(context.extensionPath, "resources", "images", "verify_cli.svg"))
  );
  const configureShortcutSvgUri = welcomePanel.webview.asWebviewUri(
    vscode.Uri.file(path.join(context.extensionPath, "resources", "images", "configure_shortcut.svg"))
  );

  // Load configuration
  const config = vscode.workspace.getConfiguration("falkon");
  const initialShortcutPreset = config.get<string>("shortcutPreset", "f4");
  const hasVerifiedCli = context.globalState.get<boolean>("falkon.hasVerifiedCli", false);
  const hasOpenedSettings = context.globalState.get<boolean>("falkon.hasOpenedSettings", false);

  // Load initial HTML Content
  welcomePanel.webview.html = getWelcomeHtml(
    welcomeSvgUri,
    verifyCliSvgUri,
    configureShortcutSvgUri,
    initialShortcutPreset,
    hasVerifiedCli,
    hasOpenedSettings
  );

  // Function to update CLI status inside webview
  const updateCliStatusInWebview = (status: "ready" | "missing", version?: string) => {
    if (welcomePanel) {
      welcomePanel.webview.postMessage({
        command: "updateCliStatus",
        status: status,
        version: version || "",
      });
    }
  };

  // Perform initial background CLI check to update badge
  cp.exec("falkon -v", { timeout: 5000 }, (error, stdout, stderr) => {
    if (error) {
      updateCliStatusInWebview("missing");
    } else {
      context.globalState.update("falkon.hasVerifiedCli", true);
      checkCompletionStatus(context);
      const version = stdout.trim() || stderr.trim() || "unknown";
      updateCliStatusInWebview("ready", version);
    }
  });

  // Handle messages from Webview
  welcomePanel.webview.onDidReceiveMessage(
    async (message) => {
      switch (message.command) {
        case "verifyCli": {
          context.globalState.update("falkon.hasVerifiedCli", true);
          // Spawn the verify terminal
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
          
          // Check installation and send back result
          if (statusBarItem) {
            const isInstalled = await checkFalkonInstallation(statusBarItem, true);
            if (isInstalled) {
              context.globalState.update("falkon.hasVerifiedCli", true);
              checkCompletionStatus(context);
              cp.exec("falkon -v", { timeout: 5000 }, (error, stdout, stderr) => {
                const version = stdout.trim() || stderr.trim() || "unknown";
                updateCliStatusInWebview("ready", version);
              });
            } else {
              updateCliStatusInWebview("missing");
            }
          }
          break;
        }
        case "changeShortcut": {
          const newPreset = message.preset;
          await vscode.workspace
            .getConfiguration("falkon")
            .update("shortcutPreset", newPreset, vscode.ConfigurationTarget.Global);
          context.globalState.update("falkon.hasOpenedSettings", true);
          checkCompletionStatus(context);
          break;
        }
        case "createFile": {
          // Complete walkthrough state
          context.globalState.update("falkon.walkthroughCompleted", true);
          
          // Create new main.flk safely
          let targetUri: vscode.Uri | undefined;
          const workspaceFolders = vscode.workspace.workspaceFolders;
          if (workspaceFolders && workspaceFolders.length > 0) {
            const rootPath = workspaceFolders[0].uri.fsPath;
            const filePath = path.join(rootPath, "main.flk");
            const fileUri = vscode.Uri.file(filePath);
            
            // Safety Check: Check if main.flk already exists before writing
            try {
              await vscode.workspace.fs.stat(fileUri);
              // File exists, skip writing template to prevent data loss
            } catch {
              // File does not exist, safe to write template content
              const content = `# Falkon Source File\nprint("Hello from Falkon!")\n`;
              await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, "utf8"));
            }
            targetUri = fileUri;
          } else {
            // Open an untitled file
            targetUri = vscode.Uri.parse("untitled:main.flk");
          }
          
          if (targetUri) {
            const doc = await vscode.workspace.openTextDocument(targetUri);
            await vscode.window.showTextDocument(doc);
          }

          // Close the welcome page
          if (welcomePanel) {
            welcomePanel.dispose();
          }
          break;
        }
        case "close": {
          context.globalState.update("falkon.walkthroughCompleted", true);
          if (welcomePanel) {
            welcomePanel.dispose();
          }
          break;
        }
        case "skip": {
          context.globalState.update("falkon.walkthroughCompleted", true);
          if (welcomePanel) {
            welcomePanel.dispose();
          }
          break;
        }
      }
    },
    undefined,
    context.subscriptions
  );

  // Sync settings configuration changes
  const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
    if (welcomePanel && (e.affectsConfiguration("falkon.shortcutPreset") || e.affectsConfiguration("falkon.enableDebugIntercept"))) {
      const currentPreset = vscode.workspace
        .getConfiguration("falkon")
        .get<string>("shortcutPreset", "f4");
      welcomePanel.webview.postMessage({
        command: "updateSettings",
        shortcutPreset: currentPreset,
      });
    }
  });

  welcomePanel.onDidDispose(() => {
    welcomePanel = undefined;
    configListener.dispose();
  });
}

function getWelcomeHtml(
  welcomeSvgUri: vscode.Uri,
  verifyCliSvgUri: vscode.Uri,
  configureShortcutSvgUri: vscode.Uri,
  initialShortcutPreset: string,
  initialVerifiedCli: boolean,
  initialOpenedSettings: boolean
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome to Falkon</title>
  <style>
    body {
      background-color: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      padding: 40px 24px;
      margin: 0;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      box-sizing: border-box;
    }
    .container {
      max-width: 800px;
      width: 100%;
      animation: fadeIn 0.8s ease-out;
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(12px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .header {
      text-align: center;
      margin-bottom: 32px;
    }
    .logo {
      width: 110px;
      height: 110px;
      margin-bottom: 16px;
    }
    h1 {
      font-size: 32px;
      font-weight: 700;
      margin: 0 0 8px 0;
      letter-spacing: -0.5px;
    }
    .subtitle {
      font-size: 15px;
      opacity: 0.8;
      margin: 0;
    }
    .progress-section {
      background: var(--vscode-welcomePage-tileBackground, rgba(255, 255, 255, 0.02));
      border: 1px solid var(--vscode-welcomePage-tileBorder, rgba(255, 255, 255, 0.08));
      border-radius: 12px;
      padding: 20px 24px;
      margin-bottom: 32px;
    }
    .progress-text {
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 10px;
      display: flex;
      justify-content: space-between;
    }
    .progress-bar {
      height: 6px;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 4px;
      overflow: hidden;
      margin-bottom: 16px;
    }
    .progress-fill {
      height: 100%;
      background: linear-gradient(90deg, #8A2BE2, #00FFFF);
      width: 0%;
      transition: width 0.4s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .checklist {
      display: flex;
      gap: 28px;
      justify-content: center;
    }
    .check-item {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      opacity: 0.5;
      transition: opacity 0.3s, color 0.3s;
    }
    .check-item.completed {
      opacity: 1;
      color: #00FF87;
      font-weight: 600;
    }
    .check-item .check-icon {
      font-size: 14px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 24px;
      margin-bottom: 40px;
    }
    .card {
      background: var(--vscode-welcomePage-tileBackground, rgba(255, 255, 255, 0.03));
      border: 1px solid var(--vscode-welcomePage-tileBorder, rgba(255, 255, 255, 0.08));
      border-radius: 12px;
      padding: 28px 24px;
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
      position: relative;
    }
    .card:hover {
      transform: translateY(-4px);
      border-color: var(--vscode-focusBorder, #007fd4);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
    }
    .card-icon {
      width: 76px;
      height: 76px;
      margin-bottom: 16px;
    }
    .card h2 {
      font-size: 17px;
      margin: 0 0 10px 0;
      font-weight: 600;
    }
    .card p {
      font-size: 13px;
      line-height: 1.5;
      opacity: 0.7;
      margin: 0 0 20px 0;
      flex-grow: 1;
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      padding: 4px 10px;
      font-size: 9px;
      font-weight: bold;
      border-radius: 20px;
      margin-bottom: 16px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .badge-checking {
      background-color: var(--vscode-statusBarItem-warningBackground, #c97a00);
      color: var(--vscode-statusBarItem-warningForeground, #ffffff);
    }
    .badge-ready {
      background-color: #00FF87;
      color: #121214;
    }
    .badge-missing {
      background-color: #FF5F56;
      color: #ffffff;
    }
    .btn {
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 10px 16px;
      font-size: 13px;
      font-weight: 600;
      border-radius: 6px;
      cursor: pointer;
      width: 100%;
      transition: background-color 0.2s, box-shadow 0.3s;
      box-sizing: border-box;
    }
    .btn:hover {
      background-color: var(--vscode-button-hoverBackground);
    }
    .btn-secondary {
      background-color: var(--vscode-button-secondaryBackground, rgba(255, 255, 255, 0.08));
      color: var(--vscode-button-secondaryForeground, var(--vscode-editor-foreground));
    }
    .btn-secondary:hover {
      background-color: var(--vscode-button-secondaryHoverBackground, rgba(255, 255, 255, 0.12));
    }
    .select-input {
      background-color: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border, rgba(255, 255, 255, 0.15));
      padding: 10px 12px;
      font-size: 13px;
      border-radius: 6px;
      width: 100%;
      cursor: pointer;
      outline: none;
      box-sizing: border-box;
    }
    .footer {
      display: flex;
      justify-content: center;
      align-items: center;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      padding-top: 32px;
      gap: 16px;
    }
    .footer-btn {
      max-width: 180px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <img class="logo" src="${welcomeSvgUri}" alt="Falkon Logo" />
      <h1>Welcome to Falkon</h1>
      <p class="subtitle">Sleek, Python-compatible syntax highlighting and build tools for VS Code.</p>
    </div>

    <!-- Onboarding Progress Section -->
    <div class="progress-section">
      <div class="progress-text">
        <span>Onboarding Progress</span>
        <span id="progress-percent">0%</span>
      </div>
      <div class="progress-bar">
        <div id="progress-fill" class="progress-fill" style="width: 0%;"></div>
      </div>
      <div class="checklist">
        <div class="check-item" id="check-cli">
          <span class="check-icon">○</span> Verify Falkon CLI
        </div>
        <div class="check-item" id="check-shortcut">
          <span class="check-icon">○</span> Configure Shortcut Preset
        </div>
      </div>
    </div>

    <div class="grid">
      <!-- Card 1: Compiler Check -->
      <div class="card">
        <img class="card-icon" src="${verifyCliSvgUri}" alt="CLI Check" />
        <h2>Verify Compiler CLI</h2>
        <span id="cli-badge" class="status-badge badge-checking">Checking...</span>
        <p>The Falkon compiler (falkon) must be installed and added to your system's PATH configuration.</p>
        <button id="btn-verify" class="btn">Run Verification</button>
      </div>

      <!-- Card 2: Configuration -->
      <div class="card">
        <img class="card-icon" src="${configureShortcutSvgUri}" alt="Shortcut" />
        <h2>Build & Run Shortcut</h2>
        <span style="height: 16px; margin-bottom: 16px;"></span> <!-- Spacer to align with badge -->
        <p>Select your default keyboard shortcut preset to compile and execute Falkon files inside the editor.</p>
        <select id="select-shortcut" class="select-input">
          <option value="f4" ${initialShortcutPreset === "f4" ? "selected" : ""}>F4 (Default)</option>
          <option value="ctrl+f5" ${initialShortcutPreset === "ctrl+f5" ? "selected" : ""}>Ctrl + F5</option>
          <option value="f7" ${initialShortcutPreset === "f7" ? "selected" : ""}>F7</option>
          <option value="none" ${initialShortcutPreset === "none" ? "selected" : ""}>None (Disabled)</option>
        </select>
      </div>

      <!-- Card 3: New File -->
      <div class="card">
        <img class="card-icon" src="${welcomeSvgUri}" alt="Start Coding" />
        <h2>Start Coding</h2>
        <span style="height: 16px; margin-bottom: 16px;"></span> <!-- Spacer to align with badge -->
        <p>Initialize a new workspace with a sample template file and start compiling your Falkon projects.</p>
        <button id="btn-create-file" class="btn btn-secondary">Create main.flk</button>
      </div>
    </div>

    <div class="footer">
      <button id="btn-skip" class="btn btn-secondary footer-btn">Skip / Do Later</button>
      <button id="btn-close" class="btn footer-btn">Finish Setup</button>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    let isCliReady = ${initialVerifiedCli};
    let isShortcutConfigured = ${initialOpenedSettings};

    function updateProgress() {
      let completedCount = 0;
      if (isCliReady) {
        completedCount++;
        document.getElementById('check-cli').classList.add('completed');
        document.getElementById('check-cli').querySelector('.check-icon').innerText = '✓';
      } else {
        document.getElementById('check-cli').classList.remove('completed');
        document.getElementById('check-cli').querySelector('.check-icon').innerText = '○';
      }

      if (isShortcutConfigured) {
        completedCount++;
        document.getElementById('check-shortcut').classList.add('completed');
        document.getElementById('check-shortcut').querySelector('.check-icon').innerText = '✓';
      } else {
        document.getElementById('check-shortcut').classList.remove('completed');
        document.getElementById('check-shortcut').querySelector('.check-icon').innerText = '○';
      }

      const percent = Math.round((completedCount / 2) * 100);
      document.getElementById('progress-percent').innerText = percent + '%';
      document.getElementById('progress-fill').style.width = percent + '%';

      const closeBtn = document.getElementById('btn-close');
      if (percent === 100) {
        closeBtn.innerText = 'Complete Setup 🎉';
        closeBtn.style.boxShadow = '0 0 12px rgba(0, 255, 135, 0.4)';
      } else {
        closeBtn.innerText = 'Finish Setup';
        closeBtn.style.boxShadow = 'none';
      }
    }

    document.getElementById('btn-verify').addEventListener('click', () => {
      const badge = document.getElementById('cli-badge');
      badge.className = 'status-badge badge-checking';
      badge.innerText = 'Checking...';
      vscode.postMessage({ command: 'verifyCli' });
    });

    document.getElementById('select-shortcut').addEventListener('change', (e) => {
      isShortcutConfigured = true;
      updateProgress();
      vscode.postMessage({ command: 'changeShortcut', preset: e.target.value });
    });

    document.getElementById('btn-create-file').addEventListener('click', () => {
      vscode.postMessage({ command: 'createFile' });
    });

    document.getElementById('btn-close').addEventListener('click', () => {
      vscode.postMessage({ command: 'close' });
    });

    document.getElementById('btn-skip').addEventListener('click', () => {
      vscode.postMessage({ command: 'skip' });
    });

    window.addEventListener('message', event => {
      const message = event.data;
      switch (message.command) {
        case 'resetProgress': {
          isCliReady = false;
          isShortcutConfigured = false;
          const selectElement = document.getElementById('select-shortcut');
          if (selectElement) {
            selectElement.value = 'f4';
          }
          const badge = document.getElementById('cli-badge');
          if (badge) {
            badge.className = 'status-badge badge-checking';
            badge.innerText = 'Checking...';
          }
          vscode.postMessage({ command: 'verifyCli' });
          updateProgress();
          break;
        }
        case 'updateSettings':
          document.getElementById('select-shortcut').value = message.shortcutPreset;
          isShortcutConfigured = true;
          updateProgress();
          break;
        case 'updateCliStatus': {
          const badge = document.getElementById('cli-badge');
          if (badge) {
            if (message.status === 'ready') {
              badge.className = 'status-badge badge-ready';
              badge.innerText = 'Ready (' + message.version + ')';
              isCliReady = true;
            } else {
              badge.className = 'status-badge badge-missing';
              badge.innerText = 'Missing CLI';
              isCliReady = false;
            }
          }
          updateProgress();
          break;
        }
      }
    });

    // Run initial progress check
    updateProgress();
  </script>
</body>
</html>`;
}

function checkCompletionStatus(context: vscode.ExtensionContext) {
  const hasVerifiedCli = context.globalState.get<boolean>("falkon.hasVerifiedCli", false);
  const hasOpenedSettings = context.globalState.get<boolean>("falkon.hasOpenedSettings", false);
  if (hasVerifiedCli && hasOpenedSettings) {
    context.globalState.update("falkon.walkthroughCompleted", true);
  }
}

