/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import type { Editor, JSONContent } from '@tiptap/core';

type MarkdownManager = {
  serialize?: (json: JSONContent) => string;
};

function isMeaningfulInlineNode(node: JSONContent): boolean {
  if (!node || typeof node.type !== 'string') return false;

  if (node.type === 'hardBreak' || node.type === 'hard_break') return false;

  if (node.type === 'text') {
    const text = typeof node.text === 'string' ? node.text : '';
    return text.trim().length > 0;
  }

  return true;
}

function isEmptyParagraph(node: JSONContent): boolean {
  if (node.type !== 'paragraph') return false;

  const content = node.content;
  if (!Array.isArray(content) || content.length === 0) return true;

  return !content.some(isMeaningfulInlineNode);
}

export function stripEmptyDocParagraphsFromJson(doc: JSONContent): JSONContent {
  if (doc.type !== 'doc' || !Array.isArray(doc.content)) {
    return doc;
  }

  const nextContent = doc.content.filter(child => !isEmptyParagraph(child));

  return {
    ...doc,
    content: nextContent,
  };
}

export function getEditorMarkdownForSync(editor: Editor): string {
  const editorUnknown = editor as unknown as {
    markdown?: MarkdownManager;
    storage?: {
      markdown?: MarkdownManager;
    };
    getMarkdown?: () => string;
  };

  const markdownManager = editorUnknown.markdown || editorUnknown.storage?.markdown;

  const getFallbackMarkdown = (): string => {
    const getMarkdown = editorUnknown.getMarkdown;
    if (typeof getMarkdown === 'function') {
      return getMarkdown.call(editor);
    }
    return '';
  };

  if (!markdownManager?.serialize || typeof editor.getJSON !== 'function') {
    return getFallbackMarkdown();
  }

  try {
    const normalizedJson = stripEmptyDocParagraphsFromJson(editor.getJSON());
    return fixBoldCodeSerialization(markdownManager.serialize(normalizedJson));
  } catch {
    return getFallbackMarkdown();
  }
}

/**
 * Post-process serializer output for bold/link vs code bugs.
 *
 * Pattern 1 — bold closes before an adjacent code span:
 *   Input (serializer output):  **If **`CODE`:
 *   User intent (source):       **If `CODE`**:
 * Gated on a trailing space before `**`, which is the telltale
 * serializer artifact; a normal `**bold**` doesn't have that so the
 * rule won't mis-fire on a legit separate bold + code pair.
 *
 * Pattern 2 — bold-wrapping-code gets flipped, ending as a code
 * span with literal asterisks inside:
 *   Input (serializer output):  `**dots/**`
 *   User intent (source):       **`dots/`**
 * Matches `` `**X**` `` exactly — code that both starts and ends
 * with `**` is almost certainly a mis-serialized bold-code combo.
 *
 * Pattern 3 — link-wrapping-code gets flipped, ending as a code
 * span containing literal [text](url) syntax:
 *   Input (serializer output):  `[file.md](path)`
 *   User intent (source):       [`file.md`](path)
 * A code span whose entire content is a well-formed markdown link
 * is almost certainly a mis-serialized link+code combo — a legit
 * code span documenting markdown link syntax is rare, and users
 * writing such docs typically escape the brackets.
 */
export function fixBoldCodeSerialization(markdown: string): string {
  return markdown
    .replace(/\*\*([^*\n]*?)\s+\*\*(`[^`\n]+`)/g, '**$1 $2**')
    .replace(/`\*\*([^`\n]+?)\*\*`/g, '**`$1`**')
    .replace(/`\[([^\]\n]+)\]\(([^)\n]+)\)`/g, '[`$1`]($2)');
}
