/**
 * Heading fold — collapse/expand sections by clicking the chevron
 * that appears in the gutter next to each heading.
 *
 * Design notes:
 *  - No document-model changes. Fold state lives in plugin state; the
 *    markdown saved to disk is unchanged regardless of which sections
 *    are folded.
 *  - A "section" is the range from a heading's start to just before
 *    the next heading at the same or shallower level (or end of doc).
 *  - State is a Set of collapsed heading positions. Positions are
 *    remapped across transactions so edits don't drift the state.
 *  - UI is delivered via ProseMirror decorations:
 *      • one Widget per heading (the chevron)
 *      • one Node decoration on each top-level block inside the
 *        folded section, with a class that hides it via CSS.
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import type { Node as ProsemirrorNode } from '@tiptap/pm/model';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

interface FoldState {
  collapsed: Set<number>;
}

const pluginKey = new PluginKey<FoldState>('headingFold');

/** Toggle metadata key — set by the click handler to request a fold change. */
const TOGGLE_META = 'headingFold/toggle';

/**
 * For the heading at `startPos`, find the end of its section — the
 * position just before the next heading at ≤ same level, or the end
 * of the document. `headingNode` is the heading itself (needed to
 * determine its level).
 */
function sectionEnd(doc: ProsemirrorNode, headingNode: ProsemirrorNode, startPos: number): number {
  const level = (headingNode.attrs.level ?? 1) as number;
  let endPos = doc.content.size;
  // Walk top-level children starting after the heading and stop at
  // the next heading with level <= this one.
  doc.descendants((node, pos) => {
    if (pos <= startPos) return;
    if (node.type.name === 'heading') {
      const nodeLevel = (node.attrs.level ?? 1) as number;
      if (nodeLevel <= level) {
        endPos = pos;
        return false; // short-circuit
      }
    }
    return true;
  });
  return endPos;
}

function buildDecorations(state: EditorState, collapsed: Set<number>): DecorationSet {
  const decorations: Decoration[] = [];
  const doc = state.doc;

  doc.descendants((node, pos) => {
    if (node.type.name !== 'heading') return;
    const isCollapsed = collapsed.has(pos);

    // Chevron widget — Lucide-style `chevron-right` SVG in the
    // gutter. Always points right by default; the expanded state
    // rotates it 90° via CSS so the animation is smooth and the
    // icon stays the same visual weight across toggle.
    const widget = Decoration.widget(pos + 1, () => {
      const el = document.createElement('button');
      el.className = `heading-fold-toggle ${isCollapsed ? 'is-collapsed' : ''}`;
      el.setAttribute('type', 'button');
      el.setAttribute('aria-label', isCollapsed ? 'Expand section' : 'Collapse section');
      el.setAttribute('contenteditable', 'false');
      el.dataset.headingPos = String(pos);
      el.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"
             aria-hidden="true" focusable="false">
          <path d="m9 18 6-6-6-6"/>
        </svg>
      `;
      return el;
    }, { side: -1, ignoreSelection: true });
    decorations.push(widget);

    if (isCollapsed) {
      const end = sectionEnd(doc, node, pos);
      // Iterate top-level blocks inside the section and hide each one.
      doc.nodesBetween(pos + node.nodeSize, end, (child, childPos, _parent, index) => {
        if (index === 0 && childPos === pos + node.nodeSize) {
          // Only top-level children of doc — skip once we descend.
        }
        // `nodesBetween` yields deeply; we only want top-level blocks
        // (parent === doc). Detect that by checking childPos against
        // direct-children positions.
        return true;
      });
      // Simpler + correct: walk `doc.content` directly.
      let offset = 0;
      doc.forEach((child, childOffset) => {
        const childPos = childOffset;
        const childEnd = childPos + child.nodeSize;
        if (childPos > pos && childPos < end) {
          decorations.push(
            Decoration.node(childPos, childEnd, { class: 'heading-folded' })
          );
        }
        offset += child.nodeSize;
      });
    }
    // We don't descend into the heading itself (inline content only).
    return false;
  });

  return DecorationSet.create(doc, decorations);
}

/**
 * Remap collapsed positions across a transaction. Positions that
 * no longer point at a heading (deleted or changed type) are dropped.
 */
function remapCollapsed(
  collapsed: Set<number>,
  tr: Transaction
): Set<number> {
  const next = new Set<number>();
  for (const pos of collapsed) {
    const mapped = tr.mapping.map(pos, 1);
    // Drop if the mapped position is invalid or no longer a heading.
    if (mapped < 0 || mapped >= tr.doc.content.size) continue;
    const node = tr.doc.nodeAt(mapped);
    if (node && node.type.name === 'heading') {
      next.add(mapped);
    }
  }
  return next;
}

export const HeadingFold = Extension.create({
  name: 'headingFold',

  addProseMirrorPlugins() {
    const plugin: Plugin<FoldState> = new Plugin<FoldState>({
      key: pluginKey,
      state: {
        init: () => ({ collapsed: new Set<number>() }),
        apply(tr, pluginState) {
          const toggle = tr.getMeta(TOGGLE_META) as number | undefined;
          let collapsed = pluginState.collapsed;
          if (tr.docChanged) {
            collapsed = remapCollapsed(collapsed, tr);
          }
          if (typeof toggle === 'number') {
            const next = new Set(collapsed);
            if (next.has(toggle)) next.delete(toggle);
            else next.add(toggle);
            return { collapsed: next };
          }
          if (collapsed !== pluginState.collapsed) {
            return { collapsed };
          }
          return pluginState;
        },
      },
      props: {
        decorations(state) {
          const pluginState = plugin.getState(state);
          if (!pluginState) return null;
          return buildDecorations(state, pluginState.collapsed);
        },
        handleDOMEvents: {
          // Handle the toggle on mousedown, not click. Click fires
          // AFTER ProseMirror has already processed mousedown (focus
          // + selection moves), and when the editor didn't have
          // focus yet, the first click's side-effects can race with
          // the widget rebuild and swallow our handler — the user
          // then has to click again to actually toggle. Mousedown
          // runs first, so our state update lands before anything
          // else happens.
          mousedown(view, event) {
            const target = event.target as HTMLElement | null;
            const button = target?.closest('.heading-fold-toggle') as HTMLElement | null;
            if (!button) return false;
            const headingPos = Number(button.dataset.headingPos ?? NaN);
            if (Number.isNaN(headingPos)) return false;
            event.preventDefault();
            event.stopPropagation();
            const tr = view.state.tr.setMeta(TOGGLE_META, headingPos);
            view.dispatch(tr);
            return true;
          },
          // Also swallow the trailing click so ProseMirror doesn't
          // react to it (would reset selection right after we've
          // already committed the toggle).
          click(_view, event) {
            const target = event.target as HTMLElement | null;
            if (!target?.closest('.heading-fold-toggle')) return false;
            event.preventDefault();
            event.stopPropagation();
            return true;
          },
        },
      },
    });
    return [plugin];
  },
});
