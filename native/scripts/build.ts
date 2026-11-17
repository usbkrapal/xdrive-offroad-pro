// npm run native:build → native/dist/xdrive_offroad_pro/{app.json, main.js, assets.js}
// Это каталог apps/<id> для upstream kit/tools/build.py. Установочный пакет здесь НЕ собирается.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP_ID, buildManifest } from '../src/manifest';
import { assetsFingerprint, buildAssetsModule } from './assets';
import { bundleMain, NATIVE, ROOT } from './bundle';
import { scanBundle } from './compat-scan';

export const OUT_DIR = join(NATIVE, 'dist', APP_ID);
/** NOTICE: build.py пакета копирует только файлы с точным именем LICENSE или NOTICE. */
export const LICENSE_FILE = 'NOTICE';
export const LICENSE_SRC = join(ROOT, 'licenses', 'IDRIVE7_APPS_MIT.txt');
/** Ровно эти файлы составляют приложение (build.py упаковывает и каталоги — их быть не должно). */
export const APP_FILES = ['app.json', 'main.js', 'assets.js', LICENSE_FILE] as const;

function writeAtomic(file: string, data: string): void {
  writeFileSync(`${file}.tmp`, data);
  renameSync(`${file}.tmp`, file);
}

/** Преамбула NOTICE: MIT относится только к заимствованным/производным частям idrive7-apps, не ко всему приложению. */
export const NOTICE_PREAMBLE =
  'This app includes portions referenced from or derived from idrive7-apps (the kit interface and signal field decoders).\n' +
  'The MIT License below applies to those portions only. No license has been selected for the rest of this app.\n' +
  '\n' +
  '----------------------------------------------------------------------\n' +
  '\n';

/** NOTICE = преамбула + licenses/IDRIVE7_APPS_MIT.txt дословно; без исходника сборка не идёт. */
export function copyLicense(outDir: string = OUT_DIR, src: string = LICENSE_SRC): string {
  if (!existsSync(src)) throw new Error(`${src} is missing: the generated app must carry the idrive7-apps MIT notice`);
  const dst = join(outDir, LICENSE_FILE);
  writeAtomic(dst, NOTICE_PREAMBLE + readFileSync(src, 'utf8'));
  return dst;
}

function cachedAssets(file: string): string | null {
  if (!existsSync(file)) return null;
  const head = readFileSync(file, 'utf8').slice(0, 400);
  const m = /fingerprint ([0-9a-f]{16})/.exec(head);
  return m && m[1] === assetsFingerprint() ? m[1] : null;
}

export async function buildNative(opts: { force?: boolean; log?: (s: string) => void } = {}): Promise<void> {
  const log = opts.log ?? ((s: string) => console.log(s));
  mkdirSync(OUT_DIR, { recursive: true });

  const manifest = buildManifest();
  writeAtomic(join(OUT_DIR, 'app.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  log(`app.json: ${APP_ID}, ${Object.keys(manifest.signals as object).length} optional read-only interfaces`);

  const code = await bundleMain();
  const issues = scanBundle(code);
  if (issues.length) {
    throw new Error(`main.js is not Node 8.7-safe:\n${issues.map((i) => `  line ${i.line}: ${i.rule}: ${i.excerpt}`).join('\n')}`);
  }
  writeAtomic(join(OUT_DIR, 'main.js'), code);
  log(`main.js: ${(code.length / 1024).toFixed(0)} KB, Node 8.7 scan clean`);

  const assetsFile = join(OUT_DIR, 'assets.js');
  const cached = opts.force ? null : cachedAssets(assetsFile);
  if (cached) {
    log(`assets.js: up to date (${cached})`);
  } else {
    log('assets.js: decoding and downscaling src/assets/*.png …');
    const { code: assets, fingerprint } = buildAssetsModule(log);
    writeAtomic(assetsFile, assets);
    log(`assets.js: ${(assets.length / 1024 / 1024).toFixed(2)} MB (${fingerprint})`);
  }

  copyLicense();
  log(`${LICENSE_FILE}: idrive7-apps MIT notice (derived portions)`);

  // В каталоге приложения — только свои файлы.
  for (const f of readdirSync(OUT_DIR)) {
    if (!(APP_FILES as readonly string[]).includes(f)) rmSync(join(OUT_DIR, f), { recursive: true, force: true });
  }
  log(`native app ready: ${OUT_DIR}`);
  log('next: npm run native:stage -- --upstream <idrive7-apps checkout> [--preview]  (preview build only; no SDK, not installable)');
}

const isMain = process.argv[1] && /native[\\/]scripts[\\/]build\.ts$/.test(process.argv[1]);
if (isMain) {
  buildNative({ force: process.argv.includes('--force') }).catch((e) => {
    console.error(String(e && (e as Error).stack ? (e as Error).stack : e));
    process.exit(1);
  });
}
