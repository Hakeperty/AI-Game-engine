/**
 * Turning engine tool results into transcript content: images become image blocks, their base64
 * is stripped from the JSON text, long results are truncated, and a one-line summary is made for the UI.
 */
import type { ImageBlock, ImageMediaType, TextBlock, ToolCallError, ToolImage } from './types.ts';

const IMAGE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

export function isToolImage(x: unknown): x is ToolImage {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return typeof o.data === 'string' && typeof o.mimeType === 'string' && IMAGE_TYPES.includes(o.mimeType);
}

/**
 * Extracts `result.images` (top level). Returns the images and a copy of the result whose images
 * keep only their metadata (label, path, size) so the JSON text stays small.
 */
export function splitImages(result: unknown): { images: ToolImage[]; stripped: unknown } {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return { images: [], stripped: result };
  const r = result as Record<string, unknown>;
  if (!Array.isArray(r.images)) return { images: [], stripped: result };
  const images = r.images.filter(isToolImage);
  if (images.length === 0) return { images: [], stripped: result };
  const meta = r.images.map((img) => {
    if (!isToolImage(img)) return img;
    const { data: _data, ...rest } = img;
    return rest;
  });
  return { images, stripped: { ...r, images: meta } };
}

export function imageBlock(img: ToolImage): ImageBlock {
  const block: ImageBlock = {
    type: 'image',
    source: { type: 'base64', media_type: img.mimeType as ImageMediaType, data: img.data },
  };
  const label = img.label ?? img.path;
  if (label) block.label = label;
  return block;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const omitted = text.length - max;
  return `${text.slice(0, max)}\n…[truncated ${omitted} characters; ask for less, e.g. a narrower query]`;
}

export function resultText(stripped: unknown): string {
  if (stripped === undefined || stripped === null) return 'OK';
  if (typeof stripped === 'string') return stripped;
  try {
    return JSON.stringify(stripped) ?? 'OK';
  } catch {
    return String(stripped);
  }
}

export function errorText(err: ToolCallError): string {
  return `${err.code}: ${err.message}${err.hint ? `\nHint: ${err.hint}` : ''}`;
}

export function textBlock(text: string): TextBlock {
  return { type: 'text', text };
}

/** Short one-line summary of a tool result for the UI and the progress log. */
export function summarizeResult(stripped: unknown, imageCount = 0, max = 140): string {
  let s: string;
  if (stripped === undefined || stripped === null) s = 'ok';
  else if (typeof stripped === 'string') s = stripped;
  else if (typeof stripped === 'object' && !Array.isArray(stripped)) {
    const o = stripped as Record<string, unknown>;
    const preferred = ['summary', 'message', 'id', 'path', 'model', 'name', 'ok', 'errors', 'warnings'];
    const parts: string[] = [];
    for (const k of preferred) {
      if (!(k in o) || o[k] === undefined) continue;
      const v = o[k];
      if (Array.isArray(v)) parts.push(`${k}: ${v.length}`);
      else if (typeof v !== 'object') parts.push(`${k}: ${String(v)}`);
      if (parts.length >= 4) break;
    }
    s = parts.length ? parts.join(', ') : compactJson(o);
  } else s = compactJson(stripped);
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > max) s = `${s.slice(0, max - 1)}…`;
  return imageCount ? `${s} (+${imageCount} image${imageCount > 1 ? 's' : ''})` : s;
}

export function compactJson(v: unknown, max = 200): string {
  let s: string;
  try {
    s = JSON.stringify(v) ?? String(v);
  } catch {
    s = String(v);
  }
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
