# Garment store — dress reference photos

Drop the real Blossom by TC dress photos here. These are the **only** garments
Mae is allowed to show in a design — the API reads this folder and passes the
photos to the image model as `input_references`, so the generated design shows
*the actual dress*, not an invented one.

## Naming

```
brand/dresses/<slug>.jpg
```

- One file per dress, flat in this folder (no subfolders).
- Slug = short lowercase name with dashes, e.g. `yellow-floral-ankara.jpg`,
  `blue-party-gown.jpg`.
- The slug is what Mae will say in chat ("using `yellow-floral-ankara`"),
  so keep it readable.
- `.jpg` or `.png`, well lit, dress fully visible, plain background if possible.

## Current stock

| slug | notes |
|------|-------|
| _(add row per photo you drop in)_ | |

## Rules

- Only the brand's own dresses — never stock/AI-invented dresses.
- Max 16 reference images per generation (OpenRouter `input_references` limit),
  so keep the folder to the dresses you actually sell.
- The model-shot skill asks the client: dress only / model wearing it / no dress?
