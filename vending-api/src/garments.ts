/**
 * Garment store — the brand's real dress photos, read from disk.
 *
 *   brand/dresses/<slug>.jpg   <- the ONLY garments Mae may show
 *
 * Mae lists them (GET /v1/garments), the client picks one, and the photo is
 * sent to the image model as an input_reference so the design shows *the
 * actual dress* instead of an invented one. This is guardrail #5 from
 * brand/blossom-brand-guidelines.md.
 *
 * OpenRouter input_references: max 16 per generation, each either an HTTP(S)
 * URL or a base64 data URL (verified against openrouter.ai/openapi.json,
 * schema ContentPartImage).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// src/ -> vending-api/ -> repo root -> brand/dresses
export const GARMENTS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'brand',
  'dresses'
);
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

export interface Garment {
  /** Filename without extension — what Mae says and what the API accepts. */
  slug: string;
  /** Human-readable name derived from the slug ("mint-green-dress" -> "Mint Green Dress"). */
  name: string;
  /** Where the photo is served from (no auth, shareable). */
  image_url: string;
}

function titleize(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function imageFiles(): string[] {
  try {
    return readdirSync(GARMENTS_DIR).filter((f) => IMAGE_EXTS.has(extname(f).toLowerCase()));
  } catch {
    return []; // folder absent -> empty store, not a crash
  }
}

/** Every dress in the store, sorted by slug. */
export function listGarments(): Garment[] {
  return imageFiles()
    .map((file) => {
      const slug = file.slice(0, -extname(file).length);
      return { slug, name: titleize(slug), image_url: `/garments/${file}` };
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Absolute path for a slug, or null if it isn't in the store. */
function pathForSlug(slug: string): string | null {
  if (typeof slug !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(slug)) return null; // no traversal
  const file = imageFiles().find((f) => f.slice(0, -extname(f).length) === slug);
  return file ? join(GARMENTS_DIR, file) : null;
}

/**
 * The dress photo as a data URL, ready for input_references.
 * Returns null when the slug isn't in the store (caller decides the error).
 */
export function garmentReferenceDataUrl(slug: string): string | null {
  const path = pathForSlug(slug);
  if (!path) return null;
  const ext = extname(path).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  return `data:${mime};base64,${readFileSync(path).toString('base64')}`;
}
