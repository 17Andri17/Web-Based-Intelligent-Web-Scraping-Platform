'use strict';

/* ===========================================================================
   chromePath
   ---------------------------------------------------------------------------
   Resolve a usable Chrome/Chromium executable across environments so the
   self-healing verification browser can launch wherever the platform runs:

     - the developer's Windows machine (the hard-coded path the rest of the
       project assumes),
     - a Linux CI / container that ships a Playwright or puppeteer Chromium,
     - anything the operator points us at via CHROME_PATH /
       PUPPETEER_EXECUTABLE_PATH.

   Returns `undefined` when nothing is found on disk — callers pass that
   straight to puppeteer.launch(), which then falls back to its own bundled
   download. Keeping this in one place means the verification browser and any
   future server-side browser share the same resolution logic.
   ========================================================================= */

const fs = require('fs');
const path = require('path');

// Static, well-known locations checked in order. The first that exists wins.
const STATIC_CANDIDATES = [
  process.env.CHROME_PATH,
  process.env.PUPPETEER_EXECUTABLE_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

// Directories that contain versioned browser folders (Playwright, puppeteer
// cache). We glob one level down for a `chrome` / `chrome.exe` binary.
const GLOB_ROOTS = [
  '/opt/pw-browsers',
  process.env.PUPPETEER_CACHE_DIR && path.join(process.env.PUPPETEER_CACHE_DIR, 'chrome'),
  path.join(require('os').homedir() || '', '.cache', 'puppeteer', 'chrome'),
];

let cached; // memoise the resolved path (or null) for the process lifetime.

function existsFile(p) {
  try { return !!p && fs.statSync(p).isFile(); } catch (_) { return false; }
}

// Shallow recursive scan (depth ≤ 3) for a chrome binary under a root dir.
function findUnder(root, depth = 0) {
  if (!root || depth > 3) return null;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch (_) { return null; }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isFile() && (e.name === 'chrome' || e.name === 'chrome.exe' || e.name === 'chromium')) {
      return full;
    }
  }
  // Recurse into subdirectories only after checking files at this level.
  for (const e of entries) {
    if (e.isDirectory()) {
      const hit = findUnder(path.join(root, e.name), depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

function resolveChromePath() {
  if (cached !== undefined) return cached || undefined;

  for (const c of STATIC_CANDIDATES) {
    if (existsFile(c)) { cached = c; return cached; }
  }

  // Try puppeteer's own computed path (exists when its Chromium was downloaded).
  try {
    const p = require('puppeteer').executablePath();
    if (existsFile(p)) { cached = p; return cached; }
  } catch (_) {}

  for (const root of GLOB_ROOTS) {
    const hit = findUnder(root);
    if (existsFile(hit)) { cached = hit; return cached; }
  }

  cached = null;
  return undefined;
}

module.exports = { resolveChromePath };
