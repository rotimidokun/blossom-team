/**
 * Image-generation client for Mae — provider-agnostic with fallback chain.
 *
 * One entry point, three tiers (cheapest first):
 *   1. mock   — no key / MAE_MOCK=1: placeholder PNG, free, used by tests
 *   2. gemini — Google AI Studio key (GEMINI_API_KEY), free tier if available
 *   3. openrouter — OpenRouter key (OPENROUTER_API_KEY), paid credit, fallback
 *
 * kind -> model routing lives here (MODEL_BY_KIND), so a flyer can go to a
 * text-capable image model while a model-shot goes to a photoreal one.
 * The chosen provider + model are returned so the design record shows
 * exactly which model produced the image.
 *
 * Env:
 *   GEMINI_API_KEY      Google AI Studio key (optional)
 *   GEMINI_MODEL        override the Gemini model name
 *   OPENROUTER_API_KEY  OpenRouter key (optional)
 *   OPENROUTER_MODEL    override the OpenRouter model name
 *   MAE_MOCK            "1" forces mock mode even with keys set
 *
 * Error codes thrown (the skill branches on these):
 *   GEMINI_NOT_CONFIGURED / IMAGE_API_UNAVAILABLE / NO_IMAGE_PROVIDER
 */

import { randomUUID } from 'node:crypto';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com';
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

// kind -> { provider, model } — the routing table. Swap models without
// touching the skill or the routes.
const MODEL_BY_KIND = {
  'model-shot': { provider: 'gemini', model: 'gemini-2.5-flash-image' },
  flyer: { provider: 'openrouter', model: 'openai/gpt-image-1' },
  slide: { provider: 'openrouter', model: 'openai/gpt-image-1' },
  social: { provider: 'gemini', model: 'gemini-2.5-flash-image' }
};

const DEFAULT_ROUTE = { provider: 'gemini', model: 'gemini-2.5-flash-image' };

// Each provider's own default model — used when falling back to a provider
// that isn't the routed one (never send provider A a provider B model name).
const PROVIDER_DEFAULT_MODEL = {
  gemini: 'gemini-2.5-flash-image',
  openrouter: 'openai/gpt-image-1'
};

/** Mock mode: forced, or no provider key at all. */
export function isMockMode() {
  if (process.env.MAE_MOCK === '1') return true;
  return !process.env.GEMINI_API_KEY && !process.env.OPENROUTER_API_KEY;
}

/** Which providers are actually configured (have a key). */
function configuredProviders() {
  return {
    gemini: Boolean(process.env.GEMINI_API_KEY),
    openrouter: Boolean(process.env.OPENROUTER_API_KEY)
  };
}

/**
 * Build the full image prompt from a design brief.
 * Kept here so the exact prompt sent to the model is recorded on the design —
 * auditable, and tweakable without re-publishing the skill.
 */
export function buildPrompt({ kind, brief, garment }) {
  const style = {
    'model-shot':
      'Photorealistic fashion editorial photo of a young girl model wearing the garment described, ' +
      'studio lighting, plain neutral background, full outfit visible, e-commerce catalogue style. ' +
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
  }[kind] || 'Clean commercial image for a childrenswear brand.';

  return `${style}\n\nBrief: ${brief}${garment ? `\nGarment: ${garment}` : ''}`;
}

/**
 * Generate an image for a design.
 * Returns { prompt, imageBase64, mimeType, provider, model, mock }.
 * Tries the routed provider first, then falls back to any other configured
 * provider, then throws NO_IMAGE_PROVIDER if none worked.
 */
export async function generateImage({ kind, brief, garment }) {
  const prompt = buildPrompt({ kind, brief, garment });

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
  const attempts = [];
  if (providers[route.provider]) {
    attempts.push({ provider: route.provider, model: route.model });
  }
  for (const name of ['gemini', 'openrouter']) {
    if (name !== route.provider && providers[name]) {
      attempts.push({ provider: name, model: PROVIDER_DEFAULT_MODEL[name] });
    }
  }

  if (attempts.length === 0) {
    const err = new Error(
      'No image provider configured — set GEMINI_API_KEY or OPENROUTER_API_KEY, or MAE_MOCK=1 for mock mode'
    );
    err.code = 'NO_IMAGE_PROVIDER';
    throw err;
  }

  let lastErr = null;
  for (const attempt of attempts) {
    try {
      const result =
        attempt.provider === 'gemini'
          ? await callGemini(attempt.model, prompt)
          : await callOpenRouter(attempt.model, prompt);
      return { prompt, provider: attempt.provider, model: attempt.model, ...result };
    } catch (err) {
      lastErr = err; // try the next provider
    }
  }

  // All configured providers failed — surface the last real error.
  throw lastErr || Object.assign(new Error('All image providers failed'), { code: 'IMAGE_API_UNAVAILABLE' });
}

// --- providers ---------------------------------------------------------------

async function callGemini(model, prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    const err = new Error('GEMINI_API_KEY not set');
    err.code = 'GEMINI_NOT_CONFIGURED';
    throw err;
  }

  let response;
  try {
    response = await fetch(`${GEMINI_BASE}/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
  } catch (networkErr) {
    const cause = networkErr.cause?.code || networkErr.cause?.message || '';
    const err = new Error(`Gemini unreachable: ${networkErr.message}${cause ? ` (${cause})` : ''}`);
    err.code = 'IMAGE_API_UNAVAILABLE';
    throw err;
  }

  const json = await response.json().catch(() => null);
  if (!response.ok || !json) {
    const err = new Error(json?.error?.message || `Gemini returned HTTP ${response.status}`);
    err.code = 'IMAGE_API_UNAVAILABLE';
    throw err;
  }

  const parts = json?.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find((p) => p.inlineData?.data);
  if (!imagePart) {
    const text = parts.map((p) => p.text).filter(Boolean).join(' ');
    const err = new Error(text || 'Gemini returned no image for this prompt');
    err.code = 'IMAGE_API_UNAVAILABLE';
    throw err;
  }

  return {
    imageBase64: imagePart.inlineData.data,
    mimeType: imagePart.inlineData.mimeType || 'image/png'
  };
}

async function callOpenRouter(model, prompt) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    const err = new Error('OPENROUTER_API_KEY not set');
    err.code = 'IMAGE_API_UNAVAILABLE';
    throw err;
  }

  let response;
  try {
    response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        // Ask for an image; OpenRouter image models return it in the message.
        modalities: ['image', 'text']
      })
    });
  } catch (networkErr) {
    const cause = networkErr.cause?.code || networkErr.cause?.message || '';
    const err = new Error(`OpenRouter unreachable: ${networkErr.message}${cause ? ` (${cause})` : ''}`);
    err.code = 'IMAGE_API_UNAVAILABLE';
    throw err;
  }

  const json = await response.json().catch(() => null);
  if (!response.ok || !json) {
    const err = new Error(json?.error?.message || `OpenRouter returned HTTP ${response.status}`);
    err.code = 'IMAGE_API_UNAVAILABLE';
    throw err;
  }

  // Image models return content as an array of parts, one with image_url.
  const content = json?.choices?.[0]?.message?.content;
  const parts = Array.isArray(content) ? content : [];
  const imagePart = parts.find((p) => p.image_url?.url);
  if (!imagePart) {
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    const err = new Error(text || 'OpenRouter returned no image for this prompt');
    err.code = 'IMAGE_API_UNAVAILABLE';
    throw err;
  }

  const url = imagePart.image_url.url; // data URL or https URL
  if (url.startsWith('data:')) {
    const [header, base64] = url.split(',');
    const mimeType = header.match(/data:([^;]+)/)?.[1] || 'image/png';
    return { imageBase64: base64, mimeType };
  }
  // Remote URL — fetch the bytes so the caller stores the file locally.
  const imgRes = await fetch(url);
  const buf = Buffer.from(await imgRes.arrayBuffer());
  return { imageBase64: buf.toString('base64'), mimeType: imgRes.headers.get('content-type') || 'image/png' };
}

// --- mock image -------------------------------------------------------------

/**
 * A real (tiny) PNG so the mock path exercises the exact same
 * save-file -> serve-image code as the real path. No dependencies.
 */
function mockPngBase64() {
  const RED_1PX =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  void randomUUID;
  return RED_1PX;
}