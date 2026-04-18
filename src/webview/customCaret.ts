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

interface FallbackCoords {
  left: number;
  top: number;
  height: number;
}

export function initCustomCaret(
  getFallbackCoords?: () => FallbackCoords | null
): { refresh: () => void; destroy: () => void } {
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
    // Priority: try ProseMirror's per-position coords FIRST — they
    // work for any document position (including empty lines inside
    // a code block, where the DOM-range approach returns a
    // zero-height rect or points at the block's top-left corner).
    // Fall back to window.getSelection() only when PM coords aren't
    // available (e.g., getFallbackCoords not wired up yet).
    let left = 0;
    let top = 0;
    let height = 0;
    let haveRect = false;
    let usedFallback = false;

    if (getFallbackCoords) {
      const fb = getFallbackCoords();
      if (fb && fb.height > 0) {
        left = fb.left;
        top = fb.top;
        height = fb.height;
        haveRect = true;
        usedFallback = true;
      }
    }

    if (!haveRect) {
      const sel = window.getSelection();
      if (sel && sel.isCollapsed && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        if (rect.height > 0) {
          left = rect.left;
          top = rect.top;
          height = rect.height;
          haveRect = true;
        } else {
          // Collapsed range at text-node boundary — use parent element.
          const node = range.startContainer;
          const el =
            node.nodeType === Node.ELEMENT_NODE
              ? (node as Element)
              : (node as Text).parentElement;
          if (el) {
            const elRect = el.getBoundingClientRect();
            const lh = parseFloat(getComputedStyle(el).lineHeight) || 20;
            left = elRect.left;
            top = elRect.top;
            height = lh;
            haveRect = true;
          }
        }
      }
    }

    if (!haveRect || height === 0) {
      caret.style.display = 'none';
      visible = false;
      return;
    }

    // Focus gate:
    //  1. This specific webview iframe must have keyboard focus
    //     (`document.hasFocus()`). Without this, open background
    //     tabs would all blink because each keeps its own DOM
    //     selection rooted inside its editor.
    //  2. Selection must be rooted inside the editor. Naturally
    //     excludes the find bar (whose input has its own selection).
    //
    // We don't check `document.activeElement` because VS Code
    // sometimes pushes it to <body> during Ctrl+N focus transitions
    // even while the iframe still has keyboard focus and the user
    // can type normally.
    if (!document.hasFocus()) {
      caret.style.display = 'none';
      visible = false;
      return;
    }
    const editorEl = document.querySelector('.markdown-editor');
    if (!editorEl) {
      caret.style.display = 'none';
      visible = false;
      return;
    }
    if (!usedFallback) {
      const anchorNode = window.getSelection()?.anchorNode;
      if (!anchorNode || !editorEl.contains(anchorNode)) {
        caret.style.display = 'none';
        visible = false;
        return;
      }
    } else {
      // Fallback path: ProseMirror's selection head always lives
      // inside the editor, so we can't use anchor-in-editor as the
      // gate. Instead, suppress the caret when focus has clearly
      // moved to a non-editor interactive element — e.g. the
      // reading-width slider input, the find bar. Allowing `body`
      // through preserves the "Ctrl+N flipped activeElement to
      // body but user is still editing" case.
      const active = document.activeElement;
      const inEditor = !!active && editorEl.contains(active);
      const isBody = active === document.body;
      if (active && !inEditor && !isBody) {
        caret.style.display = 'none';
        visible = false;
        return;
      }
    }

    caret.style.left = `${left}px`;
    caret.style.top = `${top}px`;
    caret.style.height = `${height}px`;
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

  // Self-heal: every 200ms re-evaluate caret state. Catches cases
  // where rapid focus transitions (Ctrl+1/Ctrl+0 ping-pong) leave
  // the DOM selection cleared and no event fires once ProseMirror
  // finally re-applies its selection. Cheap — update() is a few
  // DOM reads + style writes.
  const healTimer = setInterval(update, 200);

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
      clearInterval(healTimer);
      caret.remove();
      style.remove();
    },
  };
}
