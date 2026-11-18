// Renders flyer/flyer.html to flyer/miva-irl-flyer.png (1080 x 1350) and checks
// that the QR on the finished image really opens the registration page.
//   node scripts/render-flyer.mjs [registration-url]
// Needs Playwright with Chromium. The QR check uses admin/site/vendor/jsQR.js (the gate's scanner).
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = process.argv[2] || 'https://miva-fest.vercel.app/#register';
const out = join(root, 'flyer', 'miva-irl-flyer.png');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1080, height: 1350 }, deviceScaleFactor: 1 });
await page.goto('file://' + join(root, 'flyer', 'flyer.html') + '?url=' + encodeURIComponent(url));
await page.evaluate(() => document.fonts.ready);
const fonts = await page.evaluate(() => [...document.fonts].filter((f) => f.status === 'loaded').length);
if (fonts < 3) throw new Error('flyer fonts did not load');
const overflow = await page.evaluate(() => document.querySelector('.page').scrollHeight - 1350);
if (overflow > 0) throw new Error(`flyer content is ${overflow}px too tall; shorten text or sizes`);
await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1080, height: 1350 } });

// Decode the QR from the rendered pixels.
const img = await page.evaluate(() => {
  const c = document.getElementById('qr');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height);
  return { w: d.width, h: d.height, data: Array.from(d.data) };
});
const jsQR = require(join(root, 'admin', 'site', 'vendor', 'jsQR.js'));
const found = jsQR(Uint8ClampedArray.from(img.data), img.w, img.h);
await browser.close();
if (!found || found.data !== url) throw new Error(`QR check failed: got ${found && found.data}`);
console.log(`wrote ${out}\nQR opens: ${found.data}`);
