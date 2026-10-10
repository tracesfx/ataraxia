/**
 * Pure helpers for canvas text: thresholding rasterised glyphs to a 1-bit mask, and writing
 * numbers into reusable character-code buffers so the frame loop never builds strings.
 */

/** Alpha at or above this becomes opaque; below it, transparent. */
export const GLYPH_ALPHA_THRESHOLD = 128;

/**
 * Threshold RGBA pixel data in place: every pixel becomes opaque white or fully transparent, so
 * glyphs have no anti-aliased fringe. Returns the number of opaque pixels.
 */
export function thresholdGlyphPixels(
  rgba: Uint8ClampedArray | Uint8Array,
  threshold = GLYPH_ALPHA_THRESHOLD,
): number {
  let on = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const opaque = (rgba[i + 3] ?? 0) >= threshold;
    const v = opaque ? 255 : 0;
    rgba[i] = v;
    rgba[i + 1] = v;
    rgba[i + 2] = v;
    rgba[i + 3] = v;
    if (opaque) on += 1;
  }
  return on;
}

const ZERO = 48;
const PLUS = 43;
const MINUS = 45;
const DOT = 46;
const COLON = 58;
const PERCENT = 37;
const SLASH = 47;

/** A reusable text buffer: character codes plus a length. */
export interface CodeBuffer {
  codes: Uint8Array;
  length: number;
}

export function codeBuffer(capacity: number): CodeBuffer {
  return { codes: new Uint8Array(capacity), length: 0 };
}

/** Append the decimal digits of a non-negative integer (at least `minDigits` digits). */
function pushUint(buf: CodeBuffer, value: number, minDigits = 1): void {
  let n = Math.max(0, Math.floor(value));
  let digits = 1;
  for (let p = 10; p <= n; p *= 10) digits += 1;
  digits = Math.max(digits, minDigits);
  const start = buf.length;
  const end = Math.min(buf.codes.length, start + digits);
  for (let i = start + digits - 1; i >= start; i--) {
    if (i < end) buf.codes[i] = ZERO + (n % 10);
    n = Math.floor(n / 10);
  }
  buf.length = end;
}

function push(buf: CodeBuffer, code: number): void {
  if (buf.length < buf.codes.length) buf.codes[buf.length++] = code;
}

/** "1234" */
export function writeInt(buf: CodeBuffer, value: number): CodeBuffer {
  buf.length = 0;
  if (value < 0) push(buf, MINUS);
  pushUint(buf, Math.abs(Math.round(value)));
  return buf;
}

/** A non-negative integer zero-padded to at least `digits` digits: "0012480". */
export function writePadded(buf: CodeBuffer, value: number, digits: number): CodeBuffer {
  buf.length = 0;
  pushUint(buf, Math.max(0, Math.round(value)), digits);
  return buf;
}

/** Two non-negative integers as "judged/total": "123/456". */
export function writeFraction(buf: CodeBuffer, a: number, b: number): CodeBuffer {
  buf.length = 0;
  pushUint(buf, Math.max(0, Math.round(a)));
  push(buf, SLASH);
  pushUint(buf, Math.max(0, Math.round(b)));
  return buf;
}

/**
 * A timing error in whole ms with the debug overlay's sign convention: "+60" late, "-34" early,
 * "0" when it rounds to zero.
 */
export function writeSignedMs(buf: CodeBuffer, errorMs: number): CodeBuffer {
  buf.length = 0;
  const n = Math.round(errorMs);
  if (n > 0) push(buf, PLUS);
  else if (n < 0) push(buf, MINUS);
  pushUint(buf, Math.abs(n));
  return buf;
}

/** Accuracy in percent with two decimals: "98.76%". `hundredths` is the value x 100, rounded. */
export function writePercent(buf: CodeBuffer, hundredths: number): CodeBuffer {
  buf.length = 0;
  const n = Math.max(0, Math.round(hundredths));
  pushUint(buf, Math.floor(n / 100));
  push(buf, DOT);
  pushUint(buf, n % 100, 2);
  push(buf, PERCENT);
  return buf;
}

/** Song clock "m:ss" (negative times as "-m:ss"), from whole seconds. */
export function writeClock(buf: CodeBuffer, totalSeconds: number): CodeBuffer {
  buf.length = 0;
  const s = Math.round(totalSeconds);
  if (s < 0) push(buf, MINUS);
  const abs = Math.abs(s);
  pushUint(buf, Math.floor(abs / 60));
  push(buf, COLON);
  pushUint(buf, abs % 60, 2);
  return buf;
}

/** The buffer as a string (tests and debugging only). */
export function bufferText(buf: CodeBuffer): string {
  return String.fromCharCode(...buf.codes.subarray(0, buf.length));
}
