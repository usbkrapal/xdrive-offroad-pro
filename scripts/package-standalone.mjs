#!/usr/bin/env node
// Упаковывает готовую Vite-сборку (dist/) в один самодостаточный preview.html,
// который открывается двойным кликом (file://) без dev-сервера и интернета.
// Только встроенные API Node. Всё, что нельзя честно встроить (split-чанки,
// динамические импорты, воркеры, внешние ресурсы), — ошибка, а не «тихий» битый файл.
//
//   node scripts/package-standalone.mjs [--dist dist] [--out preview.html]
import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};
const CODE = new Set(['.js', '.mjs', '.css']);

export class PackageError extends Error {}

const fail = (msg) => {
  throw new PackageError(msg);
};
const toPosix = (p) => p.split(sep).join('/');

/** Файлы сборки (posix-пути относительно dist), без source map и служебного .vite/. */
function listDist(distDir) {
  return readdirSync(distDir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => toPosix(relative(distDir, join(e.parentPath ?? e.path, e.name))))
    .filter((rel) => !rel.startsWith('.vite/') && !rel.endsWith('.map'));
}

const isExternal = (ref) => /^(?:[a-z][a-z\d+.-]*:)?\/\//i.test(ref);
const isData = (ref) => /^data:/i.test(ref);

/**
 * Разрешает локальную ссылку в файл внутри dist. «/x» — от корня dist (base по умолчанию),
 * «x» и «./x» — от каталога ссылающегося файла. Выход за пределы dist — ошибка.
 */
function resolveLocal(ref, fromDir, ctx, where) {
  if (isExternal(ref)) fail(`${where}: внешний ресурс ${ref} — офлайн-файл не может его загрузить`);
  if (/^[a-z][a-z\d+.-]*:/i.test(ref)) fail(`${where}: неподдерживаемая схема в ссылке ${ref}`);
  let clean = ref.split(/[?#]/)[0];
  try {
    clean = decodeURIComponent(clean);
  } catch {
    fail(`${where}: некорректный URL ${ref}`);
  }
  const abs = clean.startsWith('/') ? join(ctx.distDir, clean) : resolve(fromDir, clean);
  const rel = relative(ctx.distDir, abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) fail(`${where}: ссылка ${ref} выходит за пределы dist`);
  if (!existsSync(abs) || !statSync(abs).isFile()) fail(`${where}: файл ${ref} не найден в dist`);
  return { abs, rel: toPosix(rel) };
}

function dataUri(file, ctx, where) {
  const mime = MIME[extname(file.abs).toLowerCase()];
  if (!mime) fail(`${where}: не знаю, как встроить ${file.rel} (тип ${extname(file.abs) || 'без расширения'})`);
  ctx.consumed.add(file.rel);
  return `data:${mime};base64,${readFileSync(file.abs).toString('base64')}`;
}

function inlineAsset(ref, fromDir, ctx, where) {
  const file = resolveLocal(ref, fromDir, ctx, where);
  const ext = extname(file.rel).toLowerCase();
  if (ext === '.js' || ext === '.mjs') fail(`${where}: ссылка на отдельный JS-чанк ${file.rel} — split-чанки не поддерживаются`);
  if (ext === '.css') fail(`${where}: ссылка на отдельный CSS ${file.rel} — CSS code-split не поддерживается`);
  return dataUri(file, ctx, where);
}

function processCss(css, cssDir, ctx, where) {
  css = css.replace(/\/\*#\s*sourceMappingURL=[^*]*\*\//g, '');
  const imp = /@import\s+(?:url\(\s*)?["']?([^"')\s;]+)/i.exec(css);
  if (imp) fail(`${where}: @import ${imp[1]} не поддерживается`);
  css = css.replace(/url\(\s*(["']?)([^"')]*?)\1\s*\)/gi, (m, _q, ref) => {
    if (!ref || isData(ref) || ref.startsWith('#')) return m;
    return `url("${inlineAsset(ref, cssDir, ctx, where)}")`;
  });
  return css.replace(/<\/style/gi, '<\\/style');
}

/** Путь-подобный строковый литерал: "/assets/x-Hash.png", "./a/b.svg", "x.woff2". */
const PATH_LITERAL = /(["'`])((?:\.{0,2}\/)?[\w@~%.-]+(?:\/[\w@~%.-]+)*\.[a-z\d]+)(?:[?#][^"'`\s]*)?\1/gi;

function processJs(js, jsDir, ctx, where) {
  js = js.replace(/^[ \t]*\/\/[#@]\s*sourceMappingURL=.*$/gm, '');

  const moduleRef =
    /(?:\bimport\s*\(\s*|\b(?:import|export)\b[^"'`;()]*?\bfrom\s*|\bimport\s*)(["'`])((?:\.{0,2}\/|[a-z][a-z\d+.-]*:\/\/)[^"'`]*|[^"'`]*\.m?js)\1/i.exec(
      js,
    );
  if (moduleRef) fail(`${where}: импорт модуля ${moduleRef[2]} — нужен один JS-бандл без split-чанков и внешних модулей`);
  if (/\bnew\s+(?:Shared)?Worker\s*\(|serviceWorker\s*\.\s*register\s*\(/.test(js)) {
    fail(`${where}: Web Worker / Service Worker не поддерживается в офлайн-файле`);
  }

  // Ассеты при относительном base: new URL("x.png", import.meta.url) — от каталога чанка.
  js = js.replace(/new\s+URL\(\s*(["'`])([^"'`]+)\1\s*,\s*import\.meta\.url\s*\)/g, (m, _q, ref) =>
    isData(ref) ? m : `new URL(${JSON.stringify(inlineAsset(ref, jsDir, ctx, where))})`,
  );
  // Ассеты при base "/": обычный строковый литерал с путём от корня dist.
  js = js.replace(PATH_LITERAL, (m, _q, ref) => {
    const clean = ref.replace(/^\.?\//, '');
    if (!ctx.files.has(clean) || clean === 'index.html') return m;
    return JSON.stringify(inlineAsset('/' + clean, ctx.distDir, ctx, where));
  });

  if (/<!--/.test(js) && /<script/i.test(js)) {
    fail(`${where}: в JS есть одновременно «<!--» и «<script» — встроить в <script> без поломки HTML нельзя`);
  }
  return js.replace(/<\/script/gi, '<\\/script');
}

function parseAttrs(src) {
  const attrs = new Map();
  for (const m of src.matchAll(/([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    attrs.set(m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

const escapeAttr = (v) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/** Пакует dist в одну HTML-строку. Ничего не пишет на диск. */
export function buildStandalone(distDir) {
  distDir = resolve(distDir);
  const indexPath = join(distDir, 'index.html');
  if (!existsSync(indexPath)) fail(`Нет ${indexPath}. Сначала выполните npm run build.`);
  const ctx = { distDir, files: new Set(listDist(distDir)), consumed: new Set(['index.html']) };
  const inlinedEntries = new Set();
  const blocks = [];
  const hold = (s) => `\u0000${blocks.push(s) - 1}\u0000`;
  const decode = (v) => v.replace(/&amp;/g, '&');

  let html = readFileSync(indexPath, 'utf8');

  html = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi, (_m, rawAttrs, body) => {
    const attrs = parseAttrs(rawAttrs);
    const isModule = attrs.get('type') === 'module';
    const open = isModule ? '<script type="module">' : '<script>';
    if (!attrs.has('src')) return hold(`${open}${processJs(body, distDir, ctx, 'inline <script>')}</script>`);
    const ref = decode(attrs.get('src'));
    const file = resolveLocal(ref, distDir, ctx, '<script src>');
    if (!/\.m?js$/i.test(file.rel)) fail(`<script src="${ref}">: ожидался .js`);
    ctx.consumed.add(file.rel);
    inlinedEntries.add(file.rel);
    const js = processJs(readFileSync(file.abs, 'utf8'), dirname(file.abs), ctx, file.rel);
    return hold(`${open}${js}</script>`);
  });

  html = html.replace(/<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi, (_m, rawAttrs, body) =>
    hold(`<style${rawAttrs}>${processCss(body, distDir, ctx, 'inline <style>')}</style>`),
  );

  html = html.replace(/<link\b([^>]*?)\/?>/gi, (m, rawAttrs) => {
    const attrs = parseAttrs(rawAttrs);
    const rels = (attrs.get('rel') ?? '').toLowerCase().split(/\s+/);
    const href = decode(attrs.get('href') ?? '');
    if (!href || isData(href)) return m;
    if (rels.includes('stylesheet')) {
      const file = resolveLocal(href, distDir, ctx, '<link rel=stylesheet>');
      ctx.consumed.add(file.rel);
      return hold(`<style>${processCss(readFileSync(file.abs, 'utf8'), dirname(file.abs), ctx, file.rel)}</style>`);
    }
    if (rels.includes('modulepreload')) {
      const file = resolveLocal(href, distDir, ctx, '<link rel=modulepreload>');
      if (inlinedEntries.has(file.rel)) return '';
      fail(`<link rel=modulepreload href="${href}">: отдельный JS-чанк — split-чанки не поддерживаются`);
    }
    if (rels.some((r) => r === 'icon' || r === 'apple-touch-icon' || r === 'mask-icon')) {
      return m.replace(/\bhref\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i, `href="${inlineAsset(href, distDir, ctx, '<link rel=icon>')}"`);
    }
    if (isExternal(href) || ctx.files.has(href.replace(/^\.?\//, ''))) {
      fail(`<link rel="${rels.join(' ')}" href="${href}">: ресурс нельзя встроить в офлайн-файл`);
    }
    return m;
  });

  // Прочие теги: <img src>, <source src>, <video poster> и т. п.
  html = html.replace(/<(?!\/)([a-z][\w-]*)\b([^>]*)>/gi, (m, tag, rawAttrs) => {
    const attrs = parseAttrs(rawAttrs);
    if (attrs.get('srcset')) fail(`<${tag} srcset>: srcset не поддерживается`);
    let out = m;
    for (const name of ['src', 'poster', 'data']) {
      const ref = attrs.get(name);
      if (!ref || isData(ref)) continue;
      const uri = inlineAsset(decode(ref), distDir, ctx, `<${tag} ${name}>`);
      out = out.replace(new RegExp(`\\b${name}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, 'i'), `${name}="${escapeAttr(uri)}"`);
    }
    if (tag.toLowerCase() !== 'a' && attrs.get('href') && !isData(attrs.get('href')) && !attrs.get('href').startsWith('#')) {
      fail(`<${tag} href="${attrs.get('href')}">: ссылка на ресурс не поддерживается`);
    }
    return out;
  });

  html = html.replace(/\u0000(\d+)\u0000/g, (_m, i) => blocks[Number(i)]);
  const report = verifyStandalone(html, ctx);
  return { html, ...report };
}

/** Проверка результата: всё нужное встроено, ни одной ссылки на файлы dist не осталось. */
export function verifyStandalone(html, ctx) {
  const problems = [];
  const unconsumedCode = [...ctx.files].filter((f) => CODE.has(extname(f).toLowerCase()) && !ctx.consumed.has(f));
  if (unconsumedCode.length) problems.push(`не встроены JS/CSS из dist: ${unconsumedCode.join(', ')}`);
  for (const f of ctx.files) {
    if (f !== 'index.html' && html.includes(basename(f))) problems.push(`в документе осталась ссылка на ${f}`);
  }
  if (/<script\b[^>]*\ssrc\s*=/i.test(html)) problems.push('остался <script src>');
  if (/<link\b[^>]*rel\s*=\s*["']?(?:stylesheet|modulepreload)/i.test(html)) problems.push('остался <link> на стили/модули');
  if (/sourceMappingURL=/.test(html)) problems.push('остался sourceMappingURL');
  if (problems.length) fail(`Проверка preview не пройдена:\n  - ${problems.join('\n  - ')}`);
  const unused = [...ctx.files].filter((f) => !ctx.consumed.has(f));
  return { inlined: [...ctx.consumed].filter((f) => f !== 'index.html').sort(), unused };
}

function parseArgs(argv, root) {
  const opts = { dist: join(root, 'dist'), out: join(root, 'preview.html') };
  for (let i = 0; i < argv.length; i++) {
    const [key, inline] = argv[i].split('=', 2);
    const value = inline ?? argv[++i];
    if (key === '--dist' && value) opts.dist = resolve(value);
    else if (key === '--out' && value) opts.out = resolve(value);
    else fail(`Неизвестный аргумент: ${argv[i]}. Использование: package-standalone.mjs [--dist dir] [--out file]`);
  }
  return opts;
}

function main() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const opts = parseArgs(process.argv.slice(2), root);
  const { html, inlined, unused } = buildStandalone(opts.dist);
  const tmp = `${opts.out}.tmp`;
  writeFileSync(tmp, html);
  renameSync(tmp, opts.out);
  const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
  console.log(`preview: ${relative(process.cwd(), opts.out) || opts.out} (${kb(Buffer.byteLength(html))})`);
  for (const f of inlined) console.log(`  встроено: ${f} (${kb(statSync(join(opts.dist, f)).size)})`);
  for (const f of unused) console.warn(`  предупреждение: ${f} есть в dist, но не используется документом`);
  console.log('Откройте файл двойным кликом — сервер и интернет не нужны.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof PackageError ? `package:standalone: ${err.message}` : err);
    process.exit(1);
  }
}
