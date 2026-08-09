// lib/color.js — WCAG-style color contrast helpers.
//
// Used by the freeform renderer to guarantee text is never invisible: before placing any text, we
// compute the effective background behind it (the topmost panel containing it, else the slide bg)
// and, if the contrast ratio is too low, override the text color to a readable white or near-black.
// This deterministically fixes "字体看不清 / 看不见" regardless of the colors the LLM chose.

function norm(hex) {
  if (hex == null) return null;
  let s = String(hex).trim().replace(/^#/, '');
  if (/^[0-9A-Fa-f]{3}$/.test(s)) s = s.split('').map((c) => c + c).join('');
  return /^[0-9A-Fa-f]{6}$/.test(s) ? s.toUpperCase() : null;
}

function lum(hex) {
  const s = norm(hex);
  if (!s) return 0;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(s.substr(i, 2), 16) / 255);
  const f = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

// WCAG contrast ratio between two hex colors (1..21).
function contrast(a, b) {
  const L1 = lum(a), L2 = lum(b);
  return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
}

function isDark(hex) { return lum(hex) < 0.22; }

// Mix a hex color toward white by `amt` (0..1) — used to force ghost backdrops faint.
function lighten(hex, amt) {
  const s = norm(hex);
  if (!s) return hex;
  const a = Math.max(0, Math.min(1, amt == null ? 0.7 : amt));
  const mix = (c) => Math.round(parseInt(c, 16) + (255 - parseInt(c, 16)) * a);
  const r = mix(s.substr(0, 2)).toString(16).padStart(2, '0');
  const g = mix(s.substr(2, 2)).toString(16).padStart(2, '0');
  const b = mix(s.substr(4, 2)).toString(16).padStart(2, '0');
  return (r + g + b).toUpperCase();
}

// Coarse fill category for consistency checks: 'light' | 'dark' | 'accent'.
function fillCategory(hex) {
  const L = lum(hex);
  if (L >= 0.72) return 'light';
  if (L <= 0.32) return 'dark';
  return 'accent';
}

// If `textHex` already meets `min` contrast against `bgHex`, keep it. Otherwise return whichever
// of white / near-black contrasts more with the background (preserving the intended light/dark
// intent as well as possible while guaranteeing readability).
function readableOn(textHex, bgHex, min) {
  min = min || 4.5;
  const t = norm(textHex), bg = norm(bgHex);
  if (!t || !bg) return textHex;
  if (contrast(t, bg) >= min) return t;
  const WHITE = 'FFFFFF', INK = '111827';
  return contrast(WHITE, bg) >= contrast(INK, bg) ? WHITE : INK;
}

module.exports = { norm, lum, contrast, isDark, readableOn, lighten, fillCategory };
