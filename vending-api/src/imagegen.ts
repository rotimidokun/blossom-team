/**
 * Image-generation client for Mae — provider-agnostic with fallback chain.
 *
 * One entry point, three tiers (cheapest first):
 *   1. mock       — no key / MAE_MOCK=1: placeholder PNG, free, used by tests
 *   2. openrouter — OpenRouter key (OPENROUTER_API_KEY), paid credit, via the
 *                   dedicated POST /api/v1/images endpoint (b64_json response)
 *   3. gemini     — Google AI Studio key (GEMINI_API_KEY), disabled for now
 *                   (prepay credits depleted); re-enable by setting the key
 *
 * kind -> model routing lives here (MODEL_BY_KIND), so a flyer can go to a
 * text-capable image model while a model-shot goes to a photoreal one.
 * The chosen provider + model are returned so the design record shows
 * exactly which model produced the image.
 *
 * Env:
 *   GEMINI_API_KEY      Google AI Studio key (optional, currently unset)
 *   GEMINI_MODEL        override the Gemini model name
 *   OPENROUTER_API_KEY  OpenRouter key (optional)
 *   OPENROUTER_MODEL    override the OpenRouter model name
 *   MAE_MOCK            "1" forces mock mode even with keys set
 *
 * Error codes thrown (the skill branches on these):
 *   IMAGE_API_UNAVAILABLE / NO_IMAGE_PROVIDER
 */

import { randomUUID } from 'node:crypto';
import type { DesignKind, ErrorCode, GeneratedImage, ImageGenError } from './types.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com';
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

/** Providers that can actually be called (mock is handled before this point). */
type ProviderName = 'gemini' | 'openrouter';

interface Route {
  provider: ProviderName;
  model: string;
}

// kind -> { provider, model } — the routing table. Swap models without
// touching the skill or the routes.
const MODEL_BY_KIND: Record<DesignKind, Route> = {
  'model-shot': { provider: 'openrouter', model: 'openai/gpt-image-2.5-flare' },
  flyer: { provider: 'openrouter', model: 'openai/gpt-image-2.5-flare' },
  slide: { provider: 'openrouter', model: 'openai/gpt-image-2.5-flare' },
  social: { provider: 'openrouter', model: 'openai/gpt-image-2.5-flare' }
};

const DEFAULT_ROUTE: Route = { provider: 'openrouter', model: 'openai/gpt-image-2.5-flare' };

// Each provider's own default model — used when falling back to a provider
// that isn't the routed one (never send provider A a provider B model name).
const PROVIDER_DEFAULT_MODEL: Record<ProviderName, string> = {
  gemini: 'gemini-2.5-flash-image',
  openrouter: 'openai/gpt-image-2.5-flare'
};

// kind -> aspect ratio for the OpenRouter Images API. Its enum is
// 1:1, 3:2, 2:3, 4:3, 3:4, 16:9, 9:16, 21:9, auto — no 4:5, so model-shot
// uses 3:4 (the nearest portrait to the brand's usual 4:5 crop).
const ASPECT_RATIO_BY_KIND: Record<DesignKind, string> = {
  'model-shot': '3:4',
  flyer: '3:4',
  slide: '16:9',
  social: '3:4'
};

/**
 * Brand guardrails injected into every prompt — source of truth:
 * brand/blossom-brand-guidelines.md. Two lines exist because of real test
 * failures: the first flyer came back branded "LITTLE THREADS" (invented
 * brand name), and des_f14911f3 came back with a curved, restyled logo
 * (model drew its own logo instead of leaving room for the real one).
 */
const BRAND_BLOCK =
  'Brand: Blossom by TC — girls fashion, ages 3 months to 18 years. ' +
  'Every design must include the text "@blossombytc" and "blossombytc.com.ng" small at the bottom. ' +
  'The only brand mark is the real logo, stamped on afterwards by our system — so never set the brand name ' +
  '("Blossom by TC", "Blossom", or any lettering of it) as a graphic, headline, wordmark, badge, or stylised text ' +
  'anywhere in the image; the only brand text allowed is the small handle and website line at the bottom. ' +
  'Never draw, redraw, or restyle a logo or brand lettering — keep the top 15% of the image completely clear and empty; no headline or graphic may enter that band. ' +
  'Show exactly what the brief describes — never invent dresses, styles, or patterns beyond it. ' +
  'Palette: sunny yellow with primary blue, red and green accents and white outlines; soft pastel backdrops (pink, lilac, mint). ' +
  'Mood: cheerful, warm, clean, child-friendly, generous white space, no watermark.';

/** Build an Error that carries a machine-readable code (what the skill branches on). */
function genError(message: string, code: ErrorCode): ImageGenError {
  const err = new Error(message) as ImageGenError;
  err.code = code;
  return err;
}

/** Mock mode: forced, or no provider key at all. */
export function isMockMode(): boolean {
  if (process.env.MAE_MOCK === '1') return true;
  return !process.env.GEMINI_API_KEY && !process.env.OPENROUTER_API_KEY;
}

/** Which providers are actually configured (have a key). */
function configuredProviders(): Record<ProviderName, boolean> {
  return {
    gemini: Boolean(process.env.GEMINI_API_KEY),
    openrouter: Boolean(process.env.OPENROUTER_API_KEY)
  };
}

export interface PromptInput {
  kind: DesignKind;
  brief: string;
  garment?: string | null;
  /** Data URLs of real reference photos (the actual dress) — sent as input_references. */
  referenceUrls?: string[] | null;
}

/**
 * Build the full image prompt from a design brief.
 * Kept here so the exact prompt sent to the model is recorded on the design —
 * auditable, and tweakable without re-publishing the skill.
 */
export function buildPrompt({ kind, brief, garment }: PromptInput): string {
  const style = (
    {
      'model-shot':
        'Photorealistic fashion editorial photo of a young girl model wearing the garment described, ' +
        'studio lighting, plain neutral background, full outfit visible, e-commerce catalogue style. ' +
        'Candid iPhone lifestyle feel, warm natural tones, pastel backdrop (pink, lilac, or mint). ' +
        'Illustrative AI-generated image — not a real child.',
      flyer:
        'Clean modern social-media sale flyer for a childrenswear brand, bold headline text from the brief, ' +
        'soft pastel palette, dress illustrations, plenty of white space, no watermark.',
      slide:
        'Minimal presentation slide background for a childrenswear business deck, one clear visual theme, ' +
        'space for a title and three bullet points, brand-neutral.',
      social:
        'Instagram-style product post image for a girls dress brand, lifestyle composition, ' +
        'square format, cheerful pastel tones.'
    } satisfies Record<DesignKind, string>
  )[kind] || 'Clean commercial image for a childrenswear brand.';

  return `${BRAND_BLOCK}\n\n${style}\n\nBrief: ${brief}${garment ? `\nGarment: ${garment}` : ''}`;
}

/**
 * Generate an image for a design.
 * Returns { prompt, imageBase64, mimeType, provider, model, mock }.
 * Tries the routed provider first, then falls back to any other configured
 * provider, then throws NO_IMAGE_PROVIDER if none worked.
 */
export async function generateImage({
  kind,
  brief,
  garment,
  referenceUrls
}: PromptInput): Promise<GeneratedImage> {
  let prompt = buildPrompt({ kind, brief, garment });
  // One-line model override — lets us swap models without a code change.
  const modelOverride = process.env.OPENROUTER_MODEL;
  const aspectRatio = ASPECT_RATIO_BY_KIND[kind] || 'auto';
  // OpenRouter caps input_references at 16 per generation.
  const references = (referenceUrls || []).slice(0, 16);

  // 1. Mock tier — free, deterministic, used by tests.
  if (isMockMode()) {
    return {
      prompt,
      imageBase64: mockPngBase64(),
      mimeType: 'image/png',
      provider: 'mock',
      model: 'placeholder',
      mock: true
    };
  }

  const route = MODEL_BY_KIND[kind] || DEFAULT_ROUTE;
  const providers = configuredProviders();

  // 2. Build the attempt list: routed provider first, then the others.
  const attempts: { provider: ProviderName; model: string }[] = [];
  if (providers[route.provider]) {
    attempts.push({
      provider: route.provider,
      model:
        route.provider === 'openrouter' && modelOverride ? modelOverride : route.model
    });
  }
  for (const name of ['gemini', 'openrouter'] as const) {
    if (name !== route.provider && providers[name]) {
      attempts.push({
        provider: name,
        model:
          name === 'openrouter' && modelOverride ? modelOverride : PROVIDER_DEFAULT_MODEL[name]
      });
    }
  }

  if (attempts.length === 0) {
    throw genError(
      'No image provider configured — set OPENROUTER_API_KEY (or GEMINI_API_KEY), or MAE_MOCK=1 for mock mode',
      'NO_IMAGE_PROVIDER'
    );
  }

  let lastErr: unknown = null;
  for (const attempt of attempts) {
    try {
      const result =
        attempt.provider === 'gemini'
          ? await callGemini(attempt.model, prompt)
          : await callOpenRouter(attempt.model, prompt, aspectRatio, references);
      return { prompt, provider: attempt.provider, model: attempt.model, mock: false, ...result };
    } catch (err) {
      lastErr = err; // try the next provider
    }
  }

  // All configured providers failed — surface the last real error.
  throw lastErr || genError('All image providers failed', 'IMAGE_API_UNAVAILABLE');
}

// --- providers ---------------------------------------------------------------

/** Shape of a fetch failure's cause (undici wraps the real error). */
interface FetchCause {
  code?: string;
  message?: string;
}

function unreachable(provider: string, networkErr: unknown): ImageGenError {
  const e = networkErr as { message?: string; cause?: FetchCause };
  const cause = e.cause?.code || e.cause?.message || '';
  return genError(
    `${provider} unreachable: ${e.message || 'fetch failed'}${cause ? ` (${cause})` : ''}`,
    'IMAGE_API_UNAVAILABLE'
  );
}

async function callGemini(
  model: string,
  prompt: string
): Promise<{ imageBase64: string; mimeType: string }> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw genError('GEMINI_API_KEY not set', 'IMAGE_API_UNAVAILABLE');
  }

  let response: Response;
  try {
    response = await fetch(`${GEMINI_BASE}/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
  } catch (networkErr) {
    throw unreachable('Gemini', networkErr);
  }

  const json: any = await response.json().catch(() => null);
  if (!response.ok || !json) {
    throw genError(
      json?.error?.message || `Gemini returned HTTP ${response.status}`,
      'IMAGE_API_UNAVAILABLE'
    );
  }

  const parts = json?.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find((p: { inlineData?: { data?: string } }) => p.inlineData?.data);
  if (!imagePart) {
    const text = parts
      .map((p: { text?: string }) => p.text)
      .filter(Boolean)
      .join(' ');
    throw genError(text || 'Gemini returned no image for this prompt', 'IMAGE_API_UNAVAILABLE');
  }

  return {
    imageBase64: imagePart.inlineData.data,
    mimeType: imagePart.inlineData.mimeType || 'image/png'
  };
}

async function callOpenRouter(
  model: string,
  prompt: string,
  aspectRatio?: string,
  referenceUrls?: string[]
): Promise<{ imageBase64: string; mimeType: string }> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    throw genError('OPENROUTER_API_KEY not set', 'IMAGE_API_UNAVAILABLE');
  }

  // ContentPartImage shape, verified against openrouter.ai/openapi.json:
  // { type: 'image_url', image_url: { url: <data URL or https URL> } }
  const inputReferences = (referenceUrls || []).map((url) => ({
    type: 'image_url',
    image_url: { url }
  }));

  let response: Response;
  try {
    // Dedicated image endpoint — returns base64 bytes directly.
    // Billing is all-or-nothing: a failed generation is not charged.
    response = await fetch(`${OPENROUTER_BASE}/images`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        prompt,
        ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
        ...(inputReferences.length ? { input_references: inputReferences } : {})
      })
    });
  } catch (networkErr) {
    throw unreachable('OpenRouter', networkErr);
  }

  const json: any = await response.json().catch(() => null);
  if (!response.ok || !json) {
    throw genError(
      json?.error?.message || json?.message || `OpenRouter returned HTTP ${response.status}`,
      'IMAGE_API_UNAVAILABLE'
    );
  }

  // Response shape: { created, data: [{ b64_json, media_type }], usage? }
  const entry = json?.data?.[0];
  const b64 = entry?.b64_json;
  if (!b64) {
    const text = JSON.stringify(json);
    throw genError(
      `OpenRouter returned no image for this prompt${text ? `: ${text.slice(0, 200)}` : ''}`,
      'IMAGE_API_UNAVAILABLE'
    );
  }
  if (json?.usage?.cost !== undefined) {
    // Surface the actual charge — quoted in field notes.
    console.log(`[imagegen] openrouter ${model} cost=$${json.usage.cost}`);
  }
  return { imageBase64: b64, mimeType: entry?.media_type || 'image/png' };
}

// --- mock image -------------------------------------------------------------

/**
 * A real (tiny) PNG so the mock path exercises the exact same
 * save-file -> serve-image code as the real path. No dependencies.
 */
function mockPngBase64(): string {
  const RED_1PX =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  void randomUUID;
  return RED_1PX;
}
