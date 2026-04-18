/**
 * Custom caret overlay — custom patch, not upstream.
 *
 * Browsers don't expose a way to set caret width (CSS has caret-color
 * but the width is fixed by the browser). This hides the native caret
 * and renders a fixed-position <div> at the cursor, blinking to match
 * VS Code's text cursor feel.
 *
 * Usage: call initCustomCaret() once from editor.ts after the Tiptap
 * view is attached. Returns a { refresh, destroy } handle — call
 * refresh() after programmatic cursor moves (like multi-line jumps)
 * where selectionchange may not fire immediately.
 */

const CARET_WIDTH_PX = 3;
const BLINK_MS = 530; // VS Code default

export function initCustomCaret(): { refresh: () => void; destroy: () => void } {
  // Overlay element
  const caret = document.createElement('div');
  caret.id = 'custom-caret';
  caret.style.cssText = `
    position: fixed;
    width: ${CARET_WIDTH_PX}px;
    pointer-events: none;
    z-index: 10000;
    background: var(--vscode-editorCursor-foreground, #007acc);
    display: none;
  `;
  document.body.appendChild(caret);

  // Hide native caret on the editor (Tiptap's ProseMirror contenteditable)
  const style = document.createElement('style');
  style.id = 'custom-caret-style';
  style.textContent = `
    .markdown-editor, .markdown-editor * {
      caret-color: transparent !important;
    }
  `;
  document.head.appendChild(style);

  let blinkOn = true;
  let blinkTimer: ReturnType<typeof setInterval> | null = null;
  let visible = false;

  function resetBlink() {
    blinkOn = true;
    caret.style.opacity = '1';
    if (blinkTimer) clearInterval(blinkTimer);
    blinkTimer = setInterval(() => {
      blinkOn = !blinkOn;
      if (visible) caret.style.opacity = blinkOn ? '1' : '0';
    }, BLINK_MS);
  }

  function update() {
    const sel = window.getSelection();
    if (!sel || !sel.isCollapsed || sel.rangeCount === 0) {
      caret.style.display = 'none';
      visible = false;
      return;
    }

    const range = sel.getRangeAt(0);
    let rect = range.getBoundingClientRect();

    // Collapsed ranges at text-node boundaries sometimes return zero —
    // fall back to parent element's rect to get the line position.
    if (rect.height === 0) {
      const node = range.startContainer;
      const el =
        node.nodeType === Node.ELEMENT_NODE
          ? (node as Element)
          : (node as Text).parentElement;
      if (el) {
        const elRect = el.getBoundingClientRect();
        const lh = parseFloat(getComputedStyle(el).lineHeight) || 20;
        rect = new DOMRect(elRect.left, elRect.top, 0, lh);
      }
    }

    if (rect.height === 0) {
      caret.style.display = 'none';
      visible = false;
      return;
    }

    // Only show the custom caret when the editor has focus — otherwise
    // we'd see a blinking caret even when the user is in the find bar.
    const editor = document.querySelector('.markdown-editor');
    const active = document.activeElement;
    if (!editor || !editor.contains(active)) {
      caret.style.display = 'none';
      visible = false;
      return;
    }

    caret.style.left = `${rect.left}px`;
    caret.style.top = `${rect.top}px`;
    caret.style.height = `${rect.height}px`;
    caret.style.display = 'block';
    visible = true;
  }

  const onSelectionChange = () => {
    update();
    resetBlink();
  };
  const onScroll = () => update();
  const onResize = () => update();
  const onFocus = () => update();
  const onBlur = () => {
    // Defer — focus may immediately transfer to another element
    setTimeout(update, 0);
  };

  document.addEventListener('selectionchange', onSelectionChange);
  window.addEventListener('scroll', onScroll, { passive: true, capture: true });
  window.addEventListener('resize', onResize, { passive: true });
  window.addEventListener('focus', onFocus);
  window.addEventListener('blur', onBlur);

  return {
    refresh() {
      update();
      resetBlink();
    },
    destroy() {
      document.removeEventListener('selectionchange', onSelectionChange);
      window.removeEventListener('scroll', onScroll, { capture: true });
      window.removeEventListener('resize', onResize);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      if (blinkTimer) clearInterval(blinkTimer);
      caret.remove();
      style.remove();
    },
  };
}
