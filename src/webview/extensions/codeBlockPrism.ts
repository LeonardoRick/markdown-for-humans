/**
 * Shiki-based syntax highlighting for Tiptap code blocks.
 *
 * We originally tried @tiptap/extension-code-block-lowlight (hljs)
 * and then Prism, but neither tokenizes TypeScript/JS deeply enough
 * — they don't tag imported namespaces, property-access chains, or
 * const binding names, so `vscode.window.tabGroups.activeTabGroup`
 * rendered as plain text.
 *
 * Shiki uses VS Code's actual TextMate grammars via the same
 * Oniguruma-compatible matcher that VS Code itself runs, and then
 * resolves each token through a VS Code color theme (one-dark-pro
 * here, the bundled Atom One Dark port). This gives pixel-parity
 * tokenization with the VS Code editor.
 *
 * Bundle note: ~300KB added vs ~80KB for Prism. Acceptable for a
 * custom editor that only ships on my machine.
 */

import { findChildren } from '@tiptap/core';
import CodeBlock from '@tiptap/extension-code-block';
import type { Node as ProsemirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

import { createHighlighterCoreSync, type HighlighterCore, type ThemedToken } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

// Theme — imported from akamud/vscode-theme-onedark (the actual
// `Atom One Dark` VS Code extension the user has installed). Using
// shiki's bundled `one-dark-pro` was close but a different port with
// different scope-to-color decisions (e.g. variable declarations
// painted yellow instead of gray). Loading the real extension's
// theme JSON gives exact token-for-token parity with VS Code.
import atomOneDark from '../themes/atom-one-dark.json';

// Languages — keep the set focused. Add imports here to support
// more fences. Grammars embed as JSON so each adds 20-80KB.
import ts from 'shiki/langs/typescript.mjs';
import tsx from 'shiki/langs/tsx.mjs';
import js from 'shiki/langs/javascript.mjs';
import jsx from 'shiki/langs/jsx.mjs';
import python from 'shiki/langs/python.mjs';
import bash from 'shiki/langs/bash.mjs';
import json from 'shiki/langs/json.mjs';
import yaml from 'shiki/langs/yaml.mjs';
import md from 'shiki/langs/markdown.mjs';
import html from 'shiki/langs/html.mjs';
import css from 'shiki/langs/css.mjs';
import go from 'shiki/langs/go.mjs';
import rust from 'shiki/langs/rust.mjs';
import java from 'shiki/langs/java.mjs';
import sql from 'shiki/langs/sql.mjs';
import diff from 'shiki/langs/diff.mjs';

const THEME = 'OneDark';

const LANGUAGE_ALIASES: Record<string, string> = {
  ts: 'typescript',
  typescriptreact: 'tsx',
  js: 'javascript',
  javascriptreact: 'jsx',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  md: 'markdown',
  py: 'python',
  rs: 'rust',
  xml: 'html',
  svg: 'html',
  plaintext: 'text',
  txt: 'text',
};

let highlighterInstance: HighlighterCore | null = null;

function getHighlighter(): HighlighterCore {
  if (!highlighterInstance) {
    highlighterInstance = createHighlighterCoreSync({
      // `atomOneDark` is the raw tmTheme JSON from akamud's
      // extension. Shiki accepts tmTheme objects alongside its own
      // ThemeRegistration format; the cast tells TS to stop
      // complaining about the shape it doesn't recognize.
      themes: [atomOneDark as unknown as Parameters<typeof createHighlighterCoreSync>[0]['themes'][number]],
      langs: [ts, tsx, js, jsx, python, bash, json, yaml, md, html, css, go, rust, java, sql, diff],
      engine: createJavaScriptRegexEngine(),
    });
  }
  return highlighterInstance;
}

function resolveLanguage(lang: string | null | undefined, highlighter: HighlighterCore): string | null {
  if (!lang) return null;
  const key = lang.toLowerCase();
  if (key === 'text' || key === 'none') return null;
  const resolved = LANGUAGE_ALIASES[key] ?? key;
  const loaded = highlighter.getLoadedLanguages();
  return loaded.includes(resolved as never) ? resolved : null;
}

function getDecorations({
  doc,
  name,
  defaultLanguage,
}: {
  doc: ProsemirrorNode;
  name: string;
  defaultLanguage: string | null | undefined;
}) {
  const decorations: Decoration[] = [];
  const highlighter = getHighlighter();

  findChildren(doc, node => node.type.name === name).forEach(block => {
    const lang = resolveLanguage(block.node.attrs.language || defaultLanguage, highlighter);
    if (!lang) return;

    let tokensPerLine: ThemedToken[][];
    try {
      tokensPerLine = highlighter.codeToTokensBase(block.node.textContent, {
        lang,
        theme: THEME,
      });
    } catch {
      // Invalid grammar for this text or internal shiki error — skip
      // decorations; the default code-block styling still applies.
      return;
    }

    // Decoration positions are relative to the ProseMirror document.
    // `block.pos + 1` skips the block's opening token; within each
    // token we advance `from` by token.content.length. Newlines
    // between lines are NOT part of tokens, so we also advance by 1
    // per line break.
    let from = block.pos + 1;
    tokensPerLine.forEach((line, lineIdx) => {
      for (const token of line) {
        const to = from + token.content.length;
        if (token.color) {
          const style = [
            `color: ${token.color}`,
            token.fontStyle === 1 ? 'font-style: italic' : '',
            token.fontStyle === 2 ? 'font-weight: bold' : '',
            token.fontStyle === 4 ? 'text-decoration: underline' : '',
          ]
            .filter(Boolean)
            .join('; ');
          decorations.push(Decoration.inline(from, to, { style }));
        }
        from = to;
      }
      // Account for the newline between lines (not present on the
      // final line since that line has no trailing newline).
      if (lineIdx < tokensPerLine.length - 1) {
        from += 1;
      }
    });
  });

  return DecorationSet.create(doc, decorations);
}

function ShikiPlugin({
  name,
  defaultLanguage,
}: {
  name: string;
  defaultLanguage: string | null | undefined;
}) {
  const shikiPlugin: Plugin<DecorationSet> = new Plugin<DecorationSet>({
    key: new PluginKey('shiki'),
    state: {
      init: (_, { doc }) => getDecorations({ doc, name, defaultLanguage }),
      apply: (transaction, decorationSet, oldState, newState) => {
        const oldNodeName = oldState.selection.$head.parent.type.name;
        const newNodeName = newState.selection.$head.parent.type.name;
        const oldNodes = findChildren(oldState.doc, node => node.type.name === name);
        const newNodes = findChildren(newState.doc, node => node.type.name === name);

        if (
          transaction.docChanged &&
          ([oldNodeName, newNodeName].includes(name) ||
            newNodes.length !== oldNodes.length ||
            transaction.steps.some(step => {
              const anyStep = step as unknown as { from?: number; to?: number };
              return (
                anyStep.from !== undefined &&
                anyStep.to !== undefined &&
                oldNodes.some(node => {
                  return (
                    anyStep.from! <= node.pos &&
                    anyStep.to! >= node.pos + node.node.nodeSize
                  );
                })
              );
            }))
        ) {
          return getDecorations({ doc: transaction.doc, name, defaultLanguage });
        }

        return decorationSet.map(transaction.mapping, transaction.doc);
      },
    },
    props: {
      decorations(state) {
        return shikiPlugin.getState(state);
      },
    },
  });

  return shikiPlugin;
}

export interface CodeBlockPrismOptions {
  defaultLanguage: string | null | undefined;
  HTMLAttributes: Record<string, unknown>;
  enableTabIndentation: boolean;
  tabSize: number;
}

// Name kept as CodeBlockPrism to avoid touching editor.ts imports,
// but under the hood it's powered by shiki now.
export const CodeBlockPrism = CodeBlock.extend<CodeBlockPrismOptions>({
  addOptions() {
    return {
      ...this.parent?.(),
      defaultLanguage: null,
      HTMLAttributes: {},
      enableTabIndentation: false,
      tabSize: 2,
    };
  },

  addProseMirrorPlugins() {
    return [
      ...(this.parent?.() || []),
      ShikiPlugin({
        name: this.name,
        defaultLanguage: this.options.defaultLanguage,
      }),
    ];
  },
});
