/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import * as vscode from 'vscode';
import { MarkdownEditorProvider } from './editor/MarkdownEditorProvider';
import { WordCountFeature } from './features/wordCount';
import { getActiveWebviewPanel } from './activeWebview';
import { outlineViewProvider } from './features/outlineView';

export function activate(context: vscode.ExtensionContext) {
  // Register the custom editor provider
  const provider = MarkdownEditorProvider.register(context);
  context.subscriptions.push(provider);

  // Clear active context when switching to non-markdown-for-humans editors
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(editor => {
      // Custom editors appear as undefined in activeTextEditor, so if we get a text editor here, disable context
      if (editor && editor.document.languageId !== 'markdown') {
        // If a regular text editor is active, clear our active context
        // Note: markdown languageId for default text editor; webview handled via view state events
        vscode.commands.executeCommand('setContext', 'markdownForHumans.isActive', false);
      }
    })
  );

  // Register outline tree view provider (Explorer)
  const outlineTreeView = vscode.window.createTreeView('markdownForHumansOutline', {
    treeDataProvider: outlineViewProvider,
    showCollapseAll: true,
  });
  outlineViewProvider.setTreeView(outlineTreeView);
  context.subscriptions.push(outlineTreeView);

  // Initialize Word Count feature
  const wordCount = new WordCountFeature();
  wordCount.activate(context);

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('markdownForHumans.openFile', async (uri?: vscode.Uri) => {
      let targetUri = uri;

      const activeEditor = vscode.window.activeTextEditor;

      // If no URI passed (e.g. run from command palette), prefer the active markdown editor
      if (!targetUri && activeEditor && activeEditor.document.languageId === 'markdown') {
        const document = activeEditor.document;

        // Support both file and untitled schemes
        if (document.uri.scheme === 'file' || document.uri.scheme === 'untitled') {
          targetUri = document.uri;
        }
      }

      // If we still don't have a URI, ask user to pick a file
      if (!targetUri) {
        const uris = await vscode.window.showOpenDialog({
          canSelectMany: false,
          filters: {
            Markdown: ['md', 'markdown'],
          },
        });
        if (uris && uris[0]) {
          targetUri = uris[0];
        }
      }

      if (targetUri) {
        await vscode.commands.executeCommand(
          'vscode.openWith',
          targetUri,
          'markdownForHumans.editor'
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('markdownForHumans.toggleSource', () => {
      // This will be handled by the webview
      vscode.window.activeTextEditor?.show();
    })
  );

  // Short time window after a toggle during which the tab-open guard
  // below skips its force-switch. Otherwise the listener would instantly
  // undo our own toggle-to-text call.
  let toggleInProgressUntil = 0;

  // Toggle the active markdown file between the MFH editor and VS Code's
  // default text editor. Bound to Ctrl+Cmd+M in the user's keybindings.
  context.subscriptions.push(
    vscode.commands.registerCommand('markdownForHumans.toggleEditor', async () => {
      const activeTab = vscode.window.tabGroups.activeTabGroup?.activeTab;
      if (!activeTab) return;

      const input = activeTab.input as { uri?: vscode.Uri; viewType?: string } | undefined;
      const uri = input?.uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!uri) return;

      const fsPath = uri.fsPath;
      if (!fsPath.endsWith('.md') && !fsPath.endsWith('.markdown')) return;

      const isInMFH =
        input !== undefined &&
        typeof input.viewType === 'string' &&
        input.viewType === 'markdownForHumans.editor';

      toggleInProgressUntil = Date.now() + 800;
      await vscode.commands.executeCommand(
        'vscode.openWith',
        uri,
        isInMFH ? 'default' : 'markdownForHumans.editor'
      );
    })
  );

  // Auto-switch .md text tabs to MFH. We react to `e.opened` (fresh
  // tabs from "open file" actions) and run a one-shot scan at
  // activation time (catches tabs restored from previous session).
  // We do NOT react to `e.changed` — that fires on navigation /
  // dirty / pin events and was the root cause of an earlier "raw
  // tab closes when I click it" bug.
  const maybeSwitch = (tab: vscode.Tab) => {
    const input = tab.input;
    if (!(input instanceof vscode.TabInputText)) return;
    if (input.uri.scheme !== 'file') return;
    const fsPath = input.uri.fsPath;
    if (!fsPath.endsWith('.md') && !fsPath.endsWith('.markdown')) return;

    const column = tab.group.viewColumn;
    const uri = input.uri;
    void vscode.window.tabGroups.close(tab).then(() => {
      void vscode.commands.executeCommand(
        'vscode.openWith',
        uri,
        'markdownForHumans.editor',
        { viewColumn: column }
      );
    });
  };

  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(e => {
      // DIAGNOSTIC: write to /tmp/mfh-guard.log so we can see what fires
      // on session restore, navigation, etc., without DevTools.
      const describe = (tab: vscode.Tab) => {
        const u = (tab.input as { uri?: vscode.Uri } | undefined)?.uri;
        const inputType = tab.input instanceof vscode.TabInputText
          ? 'text'
          : tab.input instanceof vscode.TabInputCustom
            ? 'custom'
            : tab.input instanceof vscode.TabInputTextDiff
              ? 'diff'
              : 'other';
        return { uri: u?.toString(), inputType, isActive: tab.isActive };
      };
      const md = (tab: vscode.Tab) => {
        const u = (tab.input as { uri?: vscode.Uri } | undefined)?.uri;
        return u?.fsPath?.endsWith('.md') || u?.fsPath?.endsWith('.markdown');
      };
      const o = e.opened.filter(md);
      const c = e.closed.filter(md);
      const ch = e.changed.filter(md);
      if (o.length || c.length || ch.length) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const fs = require('fs') as typeof import('fs');
          fs.appendFileSync('/tmp/mfh-guard.log', JSON.stringify({
            ts: new Date().toISOString(),
            grace: Date.now() < toggleInProgressUntil,
            opened: o.map(describe),
            closed: c.map(describe),
            changed: ch.map(describe),
          }) + '\n');
        } catch { /* ignore */ }
      }

      if (Date.now() < toggleInProgressUntil) return;
      for (const tab of e.opened) maybeSwitch(tab);
    })
  );

  // Activation-time scan: handles session-restored tabs. VS Code
  // fires `e.changed` (not `e.opened`) for tabs it restores from a
  // previous session, so the listener above misses them. Sweep all
  // currently-open tabs once at activation and force-switch any .md
  // text tabs to MFH.
  setTimeout(() => {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) maybeSwitch(tab);
    }
  }, 200);

  // Register word count detailed stats command
  context.subscriptions.push(
    vscode.commands.registerCommand('markdownForHumans.showDetailedStats', () => {
      wordCount.showDetailedStats();
    })
  );

  // Register TOC outline toggle command (Option 2 - TOC Overlay)
  context.subscriptions.push(
    vscode.commands.registerCommand('markdownForHumans.toggleTocOutlineView', () => {
      const panel = getActiveWebviewPanel();
      if (panel) {
        panel.webview.postMessage({ type: 'toggleTocOutlineView' });
      }
    })
  );

  // Navigate to heading from outline tree
  context.subscriptions.push(
    vscode.commands.registerCommand('markdownForHumans.navigateToHeading', (pos: number) => {
      const panel = getActiveWebviewPanel();
      if (panel) {
        panel.webview.postMessage({ type: 'navigateToHeading', pos });
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('markdownForHumans.outline.revealCurrent', () => {
      outlineViewProvider.revealActive(outlineTreeView);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('markdownForHumans.outline.filter', () => {
      outlineViewProvider.showFilterInput();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('markdownForHumans.outline.clearFilter', () => {
      outlineViewProvider.clearFilter();
    })
  );
}

export function deactivate() {
  // Cleanup handled by VS Code's subscription disposal
}
