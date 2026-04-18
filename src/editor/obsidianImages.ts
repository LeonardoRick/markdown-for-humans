/**
 * Obsidian wiki-link image support — custom patch, not upstream.
 *
 * Obsidian writes images as `![[filename.png]]` and stores them in the
 * folder configured by `.obsidian/app.json > attachmentFolderPath`
 * (default: same folder as the .md). This module bidirectionally maps
 * between that syntax and standard markdown `![alt](path)` so Tiptap
 * can render and re-serialize without losing the wiki-link form.
 *
 * On read  (wrap):   ![[image.png]]                       → ![image.png](../_attachments/image.png)
 * On write (unwrap): ![image.png](../_attachments/image.png) → ![[image.png]]
 *
 * The unwrap is gated on the image path resolving to inside the vault's
 * attachment folder, so standard markdown images with explicit paths
 * outside that folder are left untouched.
 */

import * as fs from 'fs';
import * as path from 'path';

interface VaultInfo {
  vaultRoot: string;
  attachmentFolder: string; // absolute path
}

const vaultCache = new Map<string, VaultInfo | null>();

/**
 * Walk up from the given file's directory looking for `.obsidian/` —
 * that marks the vault root. Returns null if not inside a vault.
 */
export function findVaultInfo(filePath: string): VaultInfo | null {
  const dir = path.dirname(filePath);
  if (vaultCache.has(dir)) return vaultCache.get(dir)!;

  let current = dir;
  const root = path.parse(current).root;
  while (current && current !== root) {
    if (fs.existsSync(path.join(current, '.obsidian'))) {
      const vaultRoot = current;
      let attachmentFolder = vaultRoot; // Obsidian default: vault root

      // Read .obsidian/app.json to get the configured attachmentFolderPath
      const appJsonPath = path.join(vaultRoot, '.obsidian', 'app.json');
      try {
        const raw = fs.readFileSync(appJsonPath, 'utf-8');
        const cfg = JSON.parse(raw) as { attachmentFolderPath?: string };
        if (typeof cfg.attachmentFolderPath === 'string' && cfg.attachmentFolderPath.length > 0) {
          attachmentFolder = path.isAbsolute(cfg.attachmentFolderPath)
            ? cfg.attachmentFolderPath
            : path.join(vaultRoot, cfg.attachmentFolderPath);
        }
      } catch {
        // app.json missing or unreadable — fall back to vault root
      }

      const info: VaultInfo = { vaultRoot, attachmentFolder };
      vaultCache.set(dir, info);
      return info;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  vaultCache.set(dir, null);
  return null;
}

/**
 * Transform `![[filename]]` wiki-links to standard `![filename](relpath)`
 * so Tiptap can render them. Only applies if the file is inside an
 * Obsidian vault. Resolves by searching the attachment folder (and
 * subfolders) for a filename match.
 */
export function wrapObsidianImagesForWebview(content: string, filePath: string): string {
  const vault = findVaultInfo(filePath);
  if (!vault) return content;

  return content.replace(/!\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g, (match, target, alias) => {
    const filename = target.trim();
    // Only handle image extensions; leave non-image wiki-links untouched.
    if (!/\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i.test(filename)) return match;

    const resolved = findAttachmentPath(vault.attachmentFolder, filename);
    if (!resolved) return match;

    const relativePath = path.relative(path.dirname(filePath), resolved);
    const alt = (alias || filename).trim();
    // Use forward slashes for URL-like paths (Windows too)
    const urlPath = relativePath.split(path.sep).join('/');
    return `![${alt}](${encodeURI(urlPath)})`;
  });
}

/**
 * Transform standard markdown images back to `![[filename]]` wiki-link
 * form, but ONLY when the image resolves into the vault's attachment
 * folder. Leaves regular markdown images untouched.
 */
export function unwrapObsidianImagesFromWebview(content: string, filePath: string): string {
  const vault = findVaultInfo(filePath);
  if (!vault) return content;

  return content.replace(/!\[([^\]]*)\]\(([^)]+?)\)/g, (match, alt, url) => {
    // Skip absolute URLs (http://, https://, data:, etc.)
    if (/^[a-z]+:/i.test(url)) return match;

    const decoded = decodeURI(url.trim());
    const absolutePath = path.resolve(path.dirname(filePath), decoded);

    // Check if the path is inside the attachment folder
    const rel = path.relative(vault.attachmentFolder, absolutePath);
    const isInsideAttachments = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    if (!isInsideAttachments) return match;

    // Use the filename only (Obsidian wiki-links are filename-based)
    const filename = path.basename(absolutePath);
    // Preserve alias if user set one different from filename
    if (alt && alt !== filename) {
      return `![[${filename}|${alt}]]`;
    }
    return `![[${filename}]]`;
  });
}

/**
 * Find a file named `filename` inside `attachmentFolder` or any
 * subfolder. Returns the absolute path, or null if not found.
 *
 * Obsidian stores attachments flatly in one folder by default, but we
 * walk subfolders as a robustness measure. Cached per-query during
 * the process lifetime.
 */
const attachmentLookupCache = new Map<string, string | null>();

function findAttachmentPath(attachmentFolder: string, filename: string): string | null {
  const cacheKey = `${attachmentFolder}::${filename}`;
  if (attachmentLookupCache.has(cacheKey)) return attachmentLookupCache.get(cacheKey)!;

  let result: string | null = null;
  // Fast path: direct hit in the attachment folder
  const direct = path.join(attachmentFolder, filename);
  if (fs.existsSync(direct)) {
    result = direct;
  } else if (fs.existsSync(attachmentFolder)) {
    // Walk subfolders (depth-first, bounded)
    result = walkForFilename(attachmentFolder, filename, 3);
  }

  attachmentLookupCache.set(cacheKey, result);
  return result;
}

function walkForFilename(dir: string, filename: string, maxDepth: number): string | null {
  if (maxDepth < 0) return null;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name === filename) {
      return path.join(dir, entry.name);
    }
  }
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      const hit = walkForFilename(path.join(dir, entry.name), filename, maxDepth - 1);
      if (hit) return hit;
    }
  }
  return null;
}
