import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TARGETS = [
  { filename: 'apple-touch-icon-180.png', size: 180 },
  { filename: 'pwa-192x192.png', size: 192 },
  { filename: 'pwa-512x512.png', size: 512 },
];

const SOURCE_SVG_PATH = path.resolve(__dirname, '../../../beercall-frontend/public/apple-touch-icon.svg');
const PRODUCTION_OUTPUT_DIR = path.resolve(__dirname, '../../../beercall-frontend/public');

const isCheck = process.argv.includes('--check');
const isDryRun = process.argv.includes('--dry-run');

function verifyPng(buf, expectedSize) {
  const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 33) {
    throw new Error('Fichier trop court pour un PNG valide');
  }
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Signature PNG invalide');
  }

  const ihdrLength = buf.readUInt32BE(8);
  const ihdrType = buf.subarray(12, 16).toString('ascii');
  if (ihdrLength !== 13 || ihdrType !== 'IHDR') {
    throw new Error('En-tête IHDR manquant ou corrompu');
  }

  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bitDepth = buf[24];
  const colorType = buf[25];

  if (width !== expectedSize || height !== expectedSize) {
    throw new Error(`Dimensions incorrectes : attendu ${expectedSize}x${expectedSize}, obtenu ${width}x${height}`);
  }

  if (colorType !== 2 && colorType !== 6) {
    throw new Error(`Type de couleur PNG inattendu : ${colorType}`);
  }

  if (colorType === 6) {
    const idatBuffers = [];
    let offset = 8;
    while (offset < buf.length) {
      const length = buf.readUInt32BE(offset);
      const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
      if (type === 'IDAT') {
        idatBuffers.push(buf.subarray(offset + 8, offset + 8 + length));
      }
      offset += 12 + length;
    }
    const compressed = Buffer.concat(idatBuffers);
    const uncompressed = zlib.inflateSync(compressed);
    const bytesPerPixel = 4;
    const stride = 1 + width * bytesPerPixel;
    for (let y = 0; y < height; y++) {
      const lineStart = y * stride + 1;
      for (let x = 0; x < width; x++) {
        const alpha = uncompressed[lineStart + x * bytesPerPixel + 3];
        if (alpha < 255) {
          throw new Error(`Pixel transparent détecté (alpha=${alpha}) aux coordonnées (${x}, ${y})`);
        }
      }
    }
  }

  return { width, height, bitDepth, colorType, opaque: true };
}

async function runCheck() {
  console.log('[check] Vérification des icônes PWA...');
  let hasError = false;

  for (const target of TARGETS) {
    const filePath = path.join(PRODUCTION_OUTPUT_DIR, target.filename);
    if (!fs.existsSync(filePath)) {
      console.error(`[check] ERREUR : Fichier manquant ${filePath}`);
      hasError = true;
      continue;
    }
    const buf = fs.readFileSync(filePath);
    try {
      const info = verifyPng(buf, target.size);
      console.log(`[check] OK : ${target.filename} (${info.width}x${info.height}, type=${info.colorType}, fond opaque, ${buf.length} octets)`);
    } catch (err) {
      console.error(`[check] ERREUR : ${target.filename} invalide - ${err.message}`);
      hasError = true;
    }
  }

  if (hasError) {
    process.exit(1);
  }
  console.log('[check] Toutes les icônes sont conformes.');
}

async function runRender() {
  if (!fs.existsSync(SOURCE_SVG_PATH)) {
    console.error(`[render] ERREUR : Fichier source SVG introuvable : ${SOURCE_SVG_PATH}`);
    process.exit(1);
  }

  const svgContent = fs.readFileSync(SOURCE_SVG_PATH, 'utf8');

  let playwright;
  try {
    playwright = await import('playwright');
  } catch {
    console.error('[render] ERREUR : Playwright n\'est pas installé. Veuillez installer les outils existants.');
    process.exit(1);
  }

  let browser;
  try {
    browser = await playwright.chromium.launch();
  } catch (err) {
    console.error('[render] ERREUR : Impossible de lancer Chromium. Exécutez "npx playwright install chromium".', err.message);
    process.exit(1);
  }

  const outputDir = isDryRun
    ? (process.env.BEERCALL_USAGE_RESULTS || path.join(os.tmpdir(), 'antigravity', 'usage-results'))
    : PRODUCTION_OUTPUT_DIR;

  fs.mkdirSync(outputDir, { recursive: true });

  console.log(`[render] Mode ${isDryRun ? '--dry-run' : 'production'}, destination : ${outputDir}`);

  try {
    for (const target of TARGETS) {
      const page = await browser.newPage({
        viewport: { width: target.size, height: target.size },
        deviceScaleFactor: 1,
      });

      // Réseau bloqué
      await page.route('**', (route) => route.abort());

      const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    width: ${target.size}px;
    height: ${target.size}px;
    overflow: hidden;
    background-color: #0F081C;
  }
  svg {
    display: block;
    width: ${target.size}px;
    height: ${target.size}px;
  }
</style>
</head>
<body>
${svgContent}
</body>
</html>`;

      await page.setContent(html, { waitUntil: 'load' });

      const buf = await page.screenshot({
        type: 'png',
        omitBackground: false,
        clip: { x: 0, y: 0, width: target.size, height: target.size },
      });

      await page.close();

      const info = verifyPng(buf, target.size);
      const destPath = path.join(outputDir, target.filename);
      fs.writeFileSync(destPath, buf);

      console.log(`[render] Généré : ${target.filename} (${info.width}x${info.height}, ${buf.length} octets) -> ${destPath}`);
    }
  } finally {
    await browser.close();
  }

  console.log(`[render] Succès : ${TARGETS.length} icônes générées sans alpha transparent.`);
}

if (isCheck) {
  await runCheck();
} else {
  await runRender();
}
