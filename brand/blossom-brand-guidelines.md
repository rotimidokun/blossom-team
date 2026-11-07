# Blossom by TC — Brand Guidelines

Single source of truth for Mae (Chord knowledge bundle) and for the `buildPrompt()` brand block in `vending-api/src/imagegen.ts`. Every design the agent creates should pass the guardrail rules at the bottom.

## Brand at a glance

| Field | Value |
|---|---|
| Brand name | **Blossom by TC** — never invent another name (see the "LITTLE THREADS" incident below) |
| What it is | Girls' fashion — 3 months to 18 years |
| Website | **blossombytc.com.ng** |
| Instagram | **@blossombytc** |
| TikTok | **@blossombytc** |
| Voice | Warm, joyful, authentic, playful, child-friendly, clean |

## Logo

- **File:** [`brand/blossom-logo.jpg`](blossom-logo.jpg) — the official logo file (yellow square, bubbly rounded "Blossom" letters with a thick white outline, "BY TC" in green caps beneath).
- **Look:** sunny yellow background; letters in primary colours — blue `B`, yellow, red, green; white sticker-style outline.
- **Rules:**
  - **The logo is never drawn, redrawn, or restyled by the image model.** The model leaves the top area clear and empty; the real logo file is composited onto the image in code, with the yellow background removed and the artwork untouched. Proof this matters: test design `des_f14911f3` came back with a curved, restyled "Blossom by TC" — that is tampering and it is not allowed.
  - The model does not render the brand name as lettering either — brand identity = the real logo file (composited in code) + the handle/website text at the bottom.

## Colours

Sampled from the official logo — approximate hexes, confirm exact values with the owner:

| Role | Colour | Hex (approx) |
|---|---|---|
| Primary background | Sunny yellow | `#FFE24D` |
| Letter / accent | Blue | `#2B78D4` |
| Letter / accent | Red | `#E33F3B` |
| Letter / accent | Green | `#34B44C` |
| Outline / negative space | White | `#FFFFFF` |
| Supporting pastel | Pink | `#F7C9D8` |
| Supporting pastel | Lilac | `#C9B6E4` |
| Supporting pastel | Mint | `#BCE3D0` |

**Usage:** flyer/social backgrounds default to sunny yellow or soft pastels; model shots use pastel studio backdrops (pink / lilac / mint). Never dark, moody, or neon palettes.

## Size

- Instagram portrait is the reference: **3:4 (1080 × 1440)** is the new portrait standard, **4:5 (1080 × 1350)** the traditional one, **1:1 (1080 × 1080)** square.
- OpenAI's image models support `3:4` but **not** `4:5`.
- The per-kind sizes live in `ASPECT_RATIO_BY_KIND` in `vending-api/src/imagegen.ts` — **owner-maintained** (Instagram portrait for feed designs, `16:9` for slides).

## Brand voice in visuals

- Cheerful and warm; plenty of white space; clean modern layouts.
- Headlines short; **the exact wording always comes from the owner** — the model sets it in type, it never writes its own tagline.
- **Handles and website go on EVERY design** — `@blossombytc` and `blossombytc.com.ng`, small, at the bottom. Non-negotiable brand rule; the prompt block injects them on every generation.
- Illustrative AI imagery only — no watermarks, no stock-photo cheesy framing.

## Official prompt templates

### Model shot — primary template (owner's own, verbatim)

> A candid iPhone photo of a cute Nigerian girl aged 5-8 years old, dark skin, natural hair in two afro puffs, modelling a children's clothing brand outfit. Shot on iPhone 15 Pro, natural daylight, slightly warm tones, authentic candid feel, shallow depth of field with soft bokeh background. The girl is smiling naturally, full of energy and personality. Background is a clean outdoor setting — a bright wall or garden. Slightly imperfect framing like a real lifestyle photo, not overly posed. UGC-style content, authentic, warm, joyful. Photorealistic, 4K, lifestyle fashion photography, natural skin texture, true-to-life colors.

> A candid-style photo of a cute Nigerian girl aged 5-8 years old, dark skin, natural hair, modelling a children's clothing brand outfit. Shot on iPhone 15 Pro, natural studio lighting, warm tones. The girl is posing confidently, full of personality and energy, bright natural smile. Background is a soft solid-color studio backdrop — pastel pink, lilac, or mint — with smooth gradient lighting that creates subtle depth and shadow on the floor, giving a clean but warm editorial feel. Professional seamless paper backdrop, soft shadow underneath, slight vignette on edges. Lifestyle children's fashion photography, authentic skin texture, true-to-life colors, photorealistic, 4K.

Variant A = outdoor/candid, Variant B = studio/pastel backdrop. Ages are fictional descriptors for AI-generated illustrative images — never real children (guardrail rule 8).

### UGC / influencer style — older templates (verbatim)

> A Nigerian girl influencer wearing our dress for Instagram shot using an iPhone with natural lighting

> Nigerian girl in our dress without the label doing a mirror selfie in a bedroom, phone visible in reflection, soft window light, scattered hair accessories on dresser, relatable UGC moment, warm and cozy feel. —ar 4:5 —style raw —v 6.1

**Translation notes:**
- "in our dress" means the owner supplies the actual dress photo as an image input → maps to the Images API `input_references` parameter.
- `--ar 4:5` → `aspect_ratio` (note: OpenAI models lack 4:5 — use 3:4); `--style raw` → keep the prompt literal and photographic; `--v 6.1` is Midjourney-only, ignore.

## Intake schema — the fields before every design

Adapted from the owner's own prompt-structure reference. Mae gathers (or infers and confirms) these before calling `POST /v1/designs/generate`, and folds them into the `brief`:

| Field | What it is | Default |
|---|---|---|
| **Context** | What it's for and where it posts — IG post, sale flyer, listing, deck, new-month greeting | — (ask) |
| **Words and elements** | Exact headline text, handles, website, items to show | Owner's wording, verbatim |
| **Mood** | Tone — playful, candid UGC, studio editorial, clean minimal | Warm and cheerful |
| **Palette** | Colours | Brand palette (sunny yellow + pastels) unless overridden |
| **Composition** | What appears — the dress(es) only, a model wearing the dress, or text-only | — (always confirm) |

**Two standing questions on every design request:**
1. **Requirements:** "Do you have any requirements, or shall I suggest some?" — the owner does not always know what to flag; Mae offers sensible defaults (size, handles, palette, composition) and confirms them.
2. **Composition:** dress(es) only, a model wearing the dress, or text-only with the right words?

## Garment store — the brand's own dresses only

- Only dresses from the brand's own catalogue appear in designs — **never random invented dresses**.
- The owner has photos for the first two dresses; they live in `brand/dresses/` and are served through the garment store (`GET /v1/garments`), then passed to the image model as reference images so the design shows the **actual** dress.
- Until a dress photo is supplied, Mae asks which dress from the catalogue the design should feature.

## Model characters — consistent faces

- A model is generated **once**, stored, and reused across designs so the same face appears every time — the stored image is passed as an `input_references` image on later generations.
- The owner can also preload already-generated model images into the store; either way the store, not the moment of generation, is what guarantees consistency.

## Occasions calendar

| Occasion | Kind |
|---|---|
| Happy New Month graphic (1st of every month) | `social` |
| Sales and promos — "June sale, 20% off" | `flyer` |
| New arrivals / weekend drops | `social` or `flyer` |
| Catalogue, listings, product shots | `model-shot` |
| Weekly / pitch deck backgrounds | `slide` |

## Guardrail rules (Mae + buildPrompt)

1. **Never invent a brand name or tagline.** Proof: the first real test flyer came back branded "LITTLE THREADS — kidswear for brighter days" because nothing said Blossom by TC.
2. **Never draw, redraw, or restyle the logo.** The model leaves the top area clear; the real logo file is composited in code with its yellow background removed. Proof: `des_f14911f3` came back with a curved restyled "Blossom by TC" — tampering, not allowed.
3. **Handles and website on every design** — `@blossombytc`, `blossombytc.com.ng`. Always.
4. **Correct size per kind** — Instagram portrait for feed designs, `16:9` for slides; `ASPECT_RATIO_BY_KIND` is owner-maintained.
5. **Only the brand's own dresses** — from the garment store, never random dresses; confirm composition (dress / model-wearing / text-only) every time.
6. **Garment accuracy** — only details the owner provided. Ask instead of inventing.
7. **Requirements are confirmed, not assumed** — "do you have requirements, or shall I suggest?"
8. **No real children** — all model imagery is AI-generated and illustrative; say so if asked.
9. **Palette defaults to the brand palette**; the owner can override per design.
10. **Every design is queued for the owner's approval — the agent never posts.**
11. **Rejections teach** — recurring `rejection_reason` values get folded back into the prompt block.

## How this document is used

1. **Chord knowledge bundle** — upload as Mae's knowledge so she writes on-brand briefs (agent side).
2. **`buildPrompt()` brand block** — the palette, voice, handles, and no-logo rule become a style prefix injected into every image prompt (code side).
3. **Garment + model stores** — dress photos and stored model images feed `input_references` so designs use the real dresses and consistent faces.
