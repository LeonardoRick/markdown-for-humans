/**
 * Multi-line cursor jump extension — custom patch, not upstream.
 *
 * Ctrl+ArrowUp/Down: move cursor 5 visible lines (with Cmd: 10 lines).
 * fn+ArrowUp/Down on macOS arrives as PageUp/PageDown, so those are
 * handled identically.
 *
 * Uses `sel.modify('move', dir, 'line')` which asks the browser to
 * move by one visible line. Running it N times gives a multi-line
 * jump. Works inside paragraphs, headings, and code blocks because
 * the browser handles line boundaries natively. After the jump we
 * scroll the cursor's nearest scrollable ancestor so the viewport
 * follows the cursor.
 */

import { Extension } from '@tiptap/core';

const LINES = 5;
const LINES_WITH_CMD = 10;

function findScrollContainer(node: Node | null): HTMLElement | null {
  let el: HTMLElement | null =
    node?.nodeType === Node.ELEMENT_NODE
      ? (node as HTMLElement)
      : ((node?.parentElement as HTMLElement | null) ?? null);
  while (el) {
    if (el.scrollHeight > el.clientHeight) {
      const ov = getComputedStyle(el).overflowY;
      if (ov === 'auto' || ov === 'scroll') return el;
    }
    el = el.parentElement;
  }
  // Fallback: the root scrolling element (usually <html>). Webviews
  // typically scroll at the document level without any explicit
  // overflow on the editor container.
  return (document.scrollingElement ?? document.documentElement) as HTMLElement;
}

function scrollCursorIntoView() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;

  const container = findScrollContainer(sel.focusNode);
  if (!container) return;

  let rect = sel.getRangeAt(0).getBoundingClientRect();
  if (rect.height === 0 && sel.focusNode) {
    const parent =
      sel.focusNode.nodeType === Node.ELEMENT_NODE
        ? (sel.focusNode as Element)
        : (sel.focusNode as Text).parentElement;
    if (parent) rect = parent.getBoundingClientRect();
  }
  if (rect.height === 0) return;

  // Viewport bounds: the visible region inside the scroll container.
  // For nested overflow:auto elements this is their getBoundingClientRect.
  // For document.scrollingElement (the <html>) its rect.top is NEGATIVE
  // when scrolled (the element is off-screen), so use viewport bounds
  // instead — otherwise the "above viewport" check never triggers for
  // upward scrolls.
  const isRootScroller =
    container === document.scrollingElement || container === document.documentElement;
  const viewTop = isRootScroller ? 0 : container.getBoundingClientRect().top;
  const viewBottom = isRootScroller
    ? window.innerHeight
    : container.getBoundingClientRect().bottom;

  // 80px margin so the sync triggers before the cursor reaches the edge.
  const margin = 80;
  if (rect.top < viewTop + margin) {
    container.scrollTop -= viewTop + margin - rect.top;
  } else if (rect.bottom > viewBottom - margin) {
    container.scrollTop += rect.bottom - viewBottom + margin;
  }
}

function jump(dir: 'forward' | 'backward', lines: number): boolean {
  const sel = window.getSelection();
  if (!sel) return false;
  for (let i = 0; i < lines; i++) {
    sel.modify('move', dir, 'line');
  }
  scrollCursorIntoView();
  // sel.modify fires selectionchange natively, so the custom caret
  // overlay will pick up the new position on its own — no explicit
  // refresh call needed here.
  return true; // handled — prevent Tiptap/browser default
}

export const MultiLineJump = Extension.create({
  name: 'multiLineJump',

  addKeyboardShortcuts() {
    return {
      // Ctrl+ArrowUp/Down — 5 lines
      'Ctrl-ArrowUp': () => jump('backward', LINES),
      'Ctrl-ArrowDown': () => jump('forward', LINES),
      // Ctrl+Cmd+ArrowUp/Down — 10 lines
      'Ctrl-Mod-ArrowUp': () => jump('backward', LINES_WITH_CMD),
      'Ctrl-Mod-ArrowDown': () => jump('forward', LINES_WITH_CMD),
      // fn+ArrowUp/Down arrives as PageUp/PageDown (macOS)
      PageUp: () => jump('backward', LINES),
      PageDown: () => jump('forward', LINES),
      'Mod-PageUp': () => jump('backward', LINES_WITH_CMD),
      'Mod-PageDown': () => jump('forward', LINES_WITH_CMD),
    };
  },
});
