/**
 * Logo stamping — guardrail #1 from brand/blossom-brand-guidelines.md.
 *
 * The image model is told NEVER to draw the logo (BRAND_BLOCK leaves the top
 * area of the design clear). The real logo is then composited in by code, so
 * what ships is always the actual file — never a redrawn approximation
 * (incident: des_f14911f3 came back with a curved, restyled logo).
 *
 * Background removal: the source brand/blossom-logo.jpg is a solid yellow
 * square. We flood-fill from the image borders only, keyed on the corner
 * colour — so yellow *inside* the letters (surrounded by their white outline)
 * is preserved, unlike a global colour key which would punch holes.
 *
 * Position: top centre, because BRAND_BLOCK explicitly keeps the top area
 * clear and empty for exactly this.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

type SharpPipeline = ReturnType<typeof sharp>;

// src/ -> vending-api/ -> repo root -> brand/blossom-logo.jpg
const LOGO_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'brand', 'blossom-logo.jpg');

/** Euclidean RGB distance under which a pixel counts as background yellow. */
const KEY_TOLERANCE = 72;
/** Logo width as a fraction of the design width. */
const LOGO_WIDTH_RATIO = 0.3;
/** Margin from the top edge (fraction of design height). */
const TOP_MARGIN_RATIO = 0.01;

interface RgbaImage {
  data: Buffer;
  width: number;
  height: number;
}

/** Distance^2 between a pixel and the key colour, without allocating. */
function distSq(data: Buffer, i: number, kr: number, kg: number, kb: number): number {
  const dr = (data[i] as number) - kr;
  const dg = (data[i + 1] as number) - kg;
  const db = (data[i + 2] as number) - kb;
  return dr * dr + dg * dg + db * db;
}

/**
 * Remove the background that is connected to the image borders.
 * Marks matching border-connected pixels transparent, in place.
 */
function keyOutBackground(img: RgbaImage): void {
  const { data, width, height } = img;
  const px = width * height;

  // Key colour = average of the four corners (all background in this asset).
  let kr = 0;
  let kg = 0;
  let kb = 0;
  for (const i of [0, (width - 1) * 4, (height - 1) * width * 4, (px - 1) * 4]) {
    kr += data[i] as number;
    kg += data[i + 1] as number;
    kb += data[i + 2] as number;
  }
  kr = Math.round(kr / 4);
  kg = Math.round(kg / 4);
  kb = Math.round(kb / 4);
  const tolSq = KEY_TOLERANCE * KEY_TOLERANCE;

  // BFS flood fill seeded from every border pixel that matches the key colour.
  const seen = new Uint8Array(px);
  const queue = new Int32Array(px);
  let head = 0;
  let tail = 0;
  const seed = (p: number) => {
    if (!seen[p] && distSq(data, p * 4, kr, kg, kb) <= tolSq) {
      seen[p] = 1;
      queue[tail++] = p;
    }
  };
  for (let x = 0; x < width; x++) {
    seed(x);
    seed((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    seed(y * width);
    seed(y * width + width - 1);
  }

  while (head < tail) {
    const p = queue[head++] as number;
    const x = p % width;
    const y = (p / width) | 0;
    if (x > 0) seed(p - 1);
    if (x < width - 1) seed(p + 1);
    if (y > 0) seed(p - width);
    if (y < height - 1) seed(p + width);
  }

  // Soft edge: fully transparent where solid background, partial alpha on the
  // anti-aliased boundary so the cut-out doesn't look jagged.
  const inner = (KEY_TOLERANCE * 0.75) ** 2;
  for (let p = 0; p < px; p++) {
    if (!seen[p]) continue;
    const i = p * 4;
    const d = distSq(data, i, kr, kg, kb);
    data[i + 3] = d <= inner ? 0 : Math.round(255 * Math.sqrt(d / tolSq));
  }
}

/** Mean horizontal-gradient energy in [left, left+winWidth) of a greyscale band — lower = emptier. */
function windowEnergy(band: Buffer, bandWidth: number, left: number, winWidth: number, rows: number): number {
  let sum = 0;
  let count = 0;
  const right = Math.min(bandWidth - 1, left + winWidth - 1);
  for (let y = 0; y < rows; y++) {
    const row = y * bandWidth;
    for (let x = Math.max(1, left); x <= right; x++) {
      sum += Math.abs((band[row + x] as number) - (band[row + x - 1] as number));
      count++;
    }
  }
  return count ? sum / count : Number.MAX_SAFE_INTEGER;
}

/**
 * Choose WHERE in the top band to place the logo: centre first, then left,
 * then right — scored on how empty each slot is in the actual generated image.
 * The prompt asks the model to keep the top 15% clear, but it doesn't always
 * obey (des_736a56d3 put "Happy" right at the top), so we read the image and
 * put the logo where nothing else is. Strict `<` means ties keep the centre.
 */
async function pickSlotLeft(
  imageBuffer: Buffer,
  logoWidth: number,
  width: number,
  height: number
): Promise<number> {
  const margin = Math.round(width * 0.02);
  const bandHeight = Math.min(Math.round(height * 0.28), height);
  const candidates = [
    Math.round((width - logoWidth) / 2), // centre
    margin, // top-left
    width - logoWidth - margin // top-right
  ].filter((left) => left >= 0 && left + logoWidth <= width);

  const { data } = await sharp(imageBuffer)
    .extract({ left: 0, top: 0, width, height: bandHeight })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let best = candidates[0] ?? 0;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const left of candidates) {
    const score = windowEnergy(data, width, left, logoWidth, bandHeight);
    if (score < bestScore) {
      bestScore = score;
      best = left;
    }
  }
  return best;
}

/** The logo with its yellow background keyed out, at native resolution. */
async function loadCutLogo(): Promise<SharpPipeline> {
  const raw = await sharp(LOGO_PATH)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const img: RgbaImage = { data: raw.data, width: raw.info.width, height: raw.info.height };
  keyOutBackground(img);
  return sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } });
}

/**
 * Composite the real logo onto a generated design.
 * Returns a PNG buffer; throws if anything is wrong (caller logs and falls
 * back to the unstamped image — a logo problem never fails a generation).
 */
export async function stampLogo(imageBuffer: Buffer): Promise<Buffer> {
  if (!existsSync(LOGO_PATH)) {
    throw new Error(`logo not found at ${LOGO_PATH}`);
  }

  const design = sharp(imageBuffer).png(); // normalise: stamped output is PNG
  const meta = await sharp(imageBuffer).metadata();
  const width = meta.width || 1024;
  const height = meta.height || 1024;

  const logoWidth = Math.max(80, Math.round(width * LOGO_WIDTH_RATIO));
  const top = Math.round(height * TOP_MARGIN_RATIO);

  // No withoutEnlargement: the source logo is only 150x150, so it MUST upscale
  // to hold its proportion on a ~1152px design (lanczos3 keeps text reasonably
  // crisp; a >=600px logo file would remove the softness entirely).
  const overlay = await (await loadCutLogo())
    .resize({ width: logoWidth, kernel: 'lanczos3' })
    .png() // raw input has no implicit output format — composite needs a real PNG
    .toBuffer();

  // TOP_MARGIN_RATIO from the top; horizontally chosen from the real image so
  // the logo lands on empty space instead of on the headline.
  const left = await pickSlotLeft(imageBuffer, logoWidth, width, height);
  return design.composite([{ input: overlay, top, left }]).toBuffer();
}

/** Exposed for tests — the logo file the stamping uses. */
export const LOGO_FILE = LOGO_PATH;
