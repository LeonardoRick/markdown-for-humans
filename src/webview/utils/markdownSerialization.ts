/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

import type { Editor, JSONContent } from '@tiptap/core';

type MarkdownManager = {
  serialize?: (json: JSONContent) => string;
  /**
   * @tiptap/markdown 3.22+ HTML-escapes `>`, `<`, and `&` in text
   * on serialize (so `-> foo` becomes `-&gt; foo`). Those chars are
   * valid in markdown body — blockquote markers, ampersand in prose,
   * arrows — and shouldn't be encoded. We override this method to a
   * pass-through for every manager instance on first touch.
   */
  encodeTextForMarkdown?: (text: string, node: unknown, parentNode?: unknown) => string;
  __mfhNoEncodePatched?: boolean;
};

export function disableHtmlEntityEncoding(manager: MarkdownManager): void {
  if (manager.__mfhNoEncodePatched) return;
  manager.encodeTextForMarkdown = (text: string) => text;
  manager.__mfhNoEncodePatched = true;
}

/**
 * Apply the entity-encoding patch to the editor's markdown manager.
 * Call this once after editor creation so every serializer caller
 * (sync-on-edit, copy-as-markdown, export…) benefits — not only the
 * ones that route through `getEditorMarkdownForSync`.
 */
export function disableHtmlEntityEncodingFor(editor: Editor): void {
  const editorUnknown = editor as unknown as {
    markdown?: MarkdownManager;
    storage?: { markdown?: MarkdownManager };
  };
  const manager = editorUnknown.markdown || editorUnknown.storage?.markdown;
  if (manager) disableHtmlEntityEncoding(manager);
}

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

  // Defensive: the patch is normally applied once at editor creation
  // (see `disableHtmlEntityEncodingFor` in editor.ts). Calling again
  // is idempotent via the __mfhNoEncodePatched flag, so this protects
  // any future code path that reaches the serializer without going
  // through editor.ts's init.
  disableHtmlEntityEncoding(markdownManager);

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
 *
 * Pattern 4 — fixed upstream in @tiptap/markdown >= 3.22. Earlier
 * versions returned active marks in insertion (open) order from
 * `findMarksToClose`/`findMarksToCloseAtEnd`, so a text span with
 * [bold, code] serialized as `CODE**\`` instead of `CODE\`**`. We
 * used to carry a patch-package fix for this; the upgrade made it
 * obsolete. Leaving this note so the pattern isn't reintroduced.
 */
export function fixBoldCodeSerialization(markdown: string): string {
  return markdown
    .replace(/\*\*([^*\n]*?)\s+\*\*(`[^`\n]+`)/g, '**$1 $2**')
    .replace(/`\*\*([^`\n]+?)\*\*`/g, '**`$1`**')
    .replace(/`\[([^\]\n]+)\]\(([^)\n]+)\)`/g, '[`$1`]($2)');
}
