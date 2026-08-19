const crypto = require('node:crypto');
const vscode = require('vscode');

class SidebarProvider {
  constructor(getModel, handleAction) {
    this.getModel = getModel;
    this.handleAction = handleAction;
    this.view = undefined;
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage(async (message) => {
      try {
        await this.handleAction(message);
      } catch (error) {
        await vscode.window.showErrorMessage(error.message);
      } finally {
        await this.refresh();
      }
    });
    view.onDidDispose(() => {
      this.view = undefined;
    });
    void this.refresh();
  }

  async refresh() {
    if (!this.view) {
      return;
    }
    try {
      this.view.webview.html = render(await this.getModel());
    } catch (error) {
      this.view.webview.html = renderError(error.message);
    }
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function options(values, selectedValue, placeholder) {
  if (values.length === 0) {
    return `<option value="">${escapeHtml(placeholder)}</option>`;
  }
  return values.map((value) => {
    const selected = value === selectedValue ? ' selected' : '';
    return `<option value="${escapeHtml(value)}"${selected}>${escapeHtml(value)}</option>`;
  }).join('');
}

function document(body, script = '') {
  const nonce = crypto.randomBytes(16).toString('hex');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; padding: 12px; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
    h2 { margin: 2px 0 3px; font-size: 15px; font-weight: 600; letter-spacing: 0; }
    .path { color: var(--vscode-descriptionForeground); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin: 14px 0 16px; }
    button, select, .value { min-height: 28px; width: 100%; border: 1px solid var(--vscode-dropdown-border, var(--vscode-input-border)); border-radius: 4px; color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); font: inherit; letter-spacing: 0; }
    button { cursor: pointer; }
    button:hover { background: var(--vscode-list-hoverBackground); }
    button.primary { border-color: var(--vscode-button-background); color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    button.primary:hover { background: var(--vscode-button-hoverBackground); }
    section { padding: 12px 0; border-top: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border)); }
    .field { margin-bottom: 12px; }
    label { display: block; margin-bottom: 5px; color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 600; text-transform: uppercase; }
    select { padding: 4px 7px; }
    .picker { padding: 4px 7px; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .value { display: flex; align-items: center; padding: 4px 7px; overflow-wrap: anywhere; }
    .row { display: grid; grid-template-columns: minmax(0, 1fr) 30px; gap: 5px; }
    .browse { font-size: 16px; padding: 0; }
    details summary { cursor: pointer; color: var(--vscode-descriptionForeground); font-weight: 600; margin-bottom: 10px; }
    .toggle { display: flex; align-items: center; gap: 8px; text-transform: none; font-size: inherit; font-weight: normal; }
    .toggle input { margin: 0; }
    .empty { color: var(--vscode-descriptionForeground); padding: 8px 0; }
  </style>
</head>
<body>${body}<script nonce="${nonce}">${script}</script></body>
</html>`;
}

function render(model) {
  if (!model) {
    return document('<div class="empty">No folder containing .project and .cproject was found.</div>');
  }
  const launchNames = model.launches.map((launch) => launch.name);
  const body = `
    <h2>${escapeHtml(model.projectName)}</h2>
    <div class="path" title="${escapeHtml(model.projectDirectory)}">${escapeHtml(model.projectDirectory)}</div>
    <div class="actions">
      <button class="primary" data-action="build">Build</button>
      <button class="primary" data-action="flash">Flash</button>
    </div>
    <section>
      <div class="field">
        <label>GD32 Embedded Builder</label>
        <button class="picker" data-action="selectInstallation" title="${escapeHtml(model.installationPath)}">${escapeHtml(model.installationPath || 'Select IDE executable...')}</button>
      </div>
      <div class="field">
        <label for="buildConfiguration">Build configuration</label>
        <select id="buildConfiguration">${options(model.configurations, model.configuration, 'No build configuration found')}</select>
      </div>
    </section>
    <section>
      <div class="field">
        <label for="launchConfiguration">Flash configuration</label>
        <select id="launchConfiguration"${model.launches.length === 0 ? ' disabled' : ''}>${options(launchNames, model.launchConfiguration, 'No Eclipse launch configuration found')}</select>
      </div>
      <div class="field">
        <label>ELF file</label>
        <div class="row">
          <button class="picker" data-action="selectElf" title="${escapeHtml(model.elfPath)}">${escapeHtml(model.elfPath || 'Select .elf file...')}</button>
          <button class="browse" data-action="selectElf" title="Select ELF file">...</button>
        </div>
      </div>
      <div class="field">
        <label>Debugger</label>
        <div class="value">${escapeHtml(model.debugger || 'Not configured')}</div>
      </div>
    </section>
    <details>
      <summary>Headless Build</summary>
      <div class="field">
        <label>Workspace</label>
        <button class="picker" data-action="selectWorkspace" title="${escapeHtml(model.workspacePath)}">${escapeHtml(model.workspaceLabel)}</button>
      </div>
      <label class="toggle"><input id="autoImport" type="checkbox"${model.autoImport ? ' checked' : ''}> Automatically import project</label>
    </details>`;
  const script = `
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('[data-action]').forEach((element) => {
      element.addEventListener('click', () => vscode.postMessage({ action: element.dataset.action }));
    });
    document.getElementById('buildConfiguration')?.addEventListener('change', (event) => {
      vscode.postMessage({ action: 'setBuildConfiguration', value: event.target.value });
    });
    document.getElementById('launchConfiguration')?.addEventListener('change', (event) => {
      vscode.postMessage({ action: 'setLaunchConfiguration', value: event.target.value });
    });
    document.getElementById('autoImport')?.addEventListener('change', (event) => {
      vscode.postMessage({ action: 'setAutoImport', value: event.target.checked });
    });`;
  return document(body, script);
}

function renderError(message) {
  return document(`<div class="empty">${escapeHtml(message)}</div>`);
}

module.exports = { SidebarProvider };
