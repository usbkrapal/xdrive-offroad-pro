// Проверка упаковщика на синтетических dist-фикстурах во временном каталоге
// (настоящий dist/ не трогается).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { PackageError, buildStandalone } from './package-standalone.mjs';

const SCRIPT = fileURLToPath(new URL('./package-standalone.mjs', import.meta.url));
const tmpRoot = mkdtempSync(join(tmpdir(), 'tm-standalone-'));
after(() => rmSync(tmpRoot, { recursive: true, force: true }));

// Картинка заметно больше любых порогов инлайнинга Vite.
const IMAGE = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), randomBytes(300 * 1024)]);
const FONT = randomBytes(2048);

let n = 0;
function fixture(files) {
  const dir = join(tmpRoot, `dist-${n++}`);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

const page = (head) => `<!doctype html><html><head><meta charset="UTF-8" />${head}</head><body><div id="root"></div></body></html>`;
const b64 = (buf) => buf.toString('base64');

function viteLikeDist(overrides = {}) {
  return fixture({
    'index.html': page(
      '<link rel="icon" href="/favicon.svg">' +
        '<script type="module" crossorigin src="/assets/index-AbC1.js"></script>' +
        '<link rel="stylesheet" crossorigin href="/assets/index-XyZ2.css">',
    ),
    'favicon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    'assets/index-AbC1.js':
      'const img="/assets/xray-drivetrain-Hh77.png";const s="</script>";' +
      'document.body.dataset.x=img+s;\n//# sourceMappingURL=index-AbC1.js.map\n',
    'assets/index-AbC1.js.map': '{"version":3}',
    'assets/index-XyZ2.css':
      '@font-face{src:url(./mono-Q1.woff2) format("woff2")}.car{background:url("/assets/xray-drivetrain-Hh77.png")}' +
      '.m{mask:url(#clip)}\n/*# sourceMappingURL=index-XyZ2.css.map */',
    'assets/xray-drivetrain-Hh77.png': IMAGE,
    'assets/mono-Q1.woff2': FONT,
    ...overrides,
  });
}

describe('package:standalone', () => {
  it('встраивает JS, CSS, картинку из JS и CSS, шрифт и иконку; ссылок на dist не остаётся', () => {
    const { html, inlined, unused } = buildStandalone(viteLikeDist());
    assert.deepEqual(inlined, [
      'assets/index-AbC1.js',
      'assets/index-XyZ2.css',
      'assets/mono-Q1.woff2',
      'assets/xray-drivetrain-Hh77.png',
      'favicon.svg',
    ]);
    assert.deepEqual(unused, []);
    assert.ok(html.includes(`"data:image/png;base64,${b64(IMAGE)}"`), 'картинка в JS');
    assert.ok(html.includes(`url("data:image/png;base64,${b64(IMAGE)}")`), 'картинка в CSS');
    assert.ok(html.includes(`url("data:font/woff2;base64,${b64(FONT)}")`), 'шрифт в CSS');
    assert.ok(html.includes('href="data:image/svg+xml;base64,'), 'иконка');
    assert.ok(html.includes('url(#clip)'), 'фрагмент url(#…) не трогается');
    assert.match(html, /<script type="module">const img=/);
    assert.ok(html.includes('"<\\/script>"'), '</script> внутри JS экранирован');
    assert.equal(html.match(/<\/script>/g).length, 1);
    assert.doesNotMatch(html, /sourceMappingURL|\.map\b|crossorigin|\/assets\//);
  });

  it('относительный base: ./assets и new URL(…, import.meta.url)', () => {
    const dist = fixture({
      'index.html': page('<script type="module" src="./assets/index-R1.js"></script>'),
      'assets/index-R1.js': 'const u=new URL("xray-drivetrain-Hh77.png",import.meta.url).href;console.log(u);',
      'assets/xray-drivetrain-Hh77.png': IMAGE,
    });
    const { html, inlined } = buildStandalone(dist);
    assert.deepEqual(inlined, ['assets/index-R1.js', 'assets/xray-drivetrain-Hh77.png']);
    assert.ok(html.includes(`new URL("data:image/png;base64,${b64(IMAGE)}")`));
  });

  const rejects = [
    ['динамический импорт split-чанка', { 'assets/index-AbC1.js': 'import("./lazy-L1.js");', 'assets/lazy-L1.js': '' }, /split-чанк/],
    ['лишний JS-чанк, на который нет явной ссылки', { 'assets/vendor-V1.js': 'export{}' }, /не встроены JS\/CSS.*vendor-V1\.js/],
    ['modulepreload другого чанка', { 'index.html': page('<script type="module" src="/assets/index-AbC1.js"></script><link rel="modulepreload" href="/assets/vendor-V1.js">'), 'assets/vendor-V1.js': '' }, /modulepreload/],
    ['внешняя таблица стилей', { 'index.html': page('<script type="module" src="/assets/index-AbC1.js"></script><link rel="stylesheet" href="https://fonts.example/css">') }, /внешний ресурс/],
    ['внешний url() в CSS', { 'assets/index-XyZ2.css': '.a{background:url(https://cdn.example/x.png)}' }, /внешний ресурс/],
    ['выход за пределы dist', { 'assets/index-XyZ2.css': '.a{background:url(../../secret.png)}' }, /за пределы dist/],
    ['отсутствующий файл', { 'assets/index-XyZ2.css': '.a{background:url(./missing.png)}' }, /не найден/],
    ['Web Worker', { 'assets/index-AbC1.js': 'new Worker(new URL("w.js",import.meta.url));' }, /Worker/],
  ];
  for (const [name, overrides, message] of rejects) {
    it(`отказ: ${name}`, () => {
      assert.throws(() => buildStandalone(viteLikeDist(overrides)), (err) => err instanceof PackageError && message.test(err.message));
    });
  }

  it('CLI пишет preview, а при ошибке завершается с кодом 1 и ничего не пишет', () => {
    const ok = join(tmpRoot, 'ok.html');
    const okRun = spawnSync(process.execPath, [SCRIPT, '--dist', viteLikeDist(), '--out', ok], { encoding: 'utf8' });
    assert.equal(okRun.status, 0, okRun.stderr);
    assert.ok(readFileSync(ok, 'utf8').startsWith('<!doctype html>'));

    const bad = join(tmpRoot, 'bad.html');
    const badDist = viteLikeDist({ 'assets/index-AbC1.js': 'import("./lazy-L1.js");', 'assets/lazy-L1.js': '' });
    const badRun = spawnSync(process.execPath, [SCRIPT, '--dist', badDist, '--out', bad], { encoding: 'utf8' });
    assert.equal(badRun.status, 1);
    assert.match(badRun.stderr, /package:standalone: .*split-чанк/);
    assert.equal(existsSync(bad), false);
    assert.equal(existsSync(`${bad}.tmp`), false);
  });

  it('без dist/index.html — понятная ошибка', () => {
    assert.throws(() => buildStandalone(join(tmpRoot, 'nope')), /npm run build/);
  });
});
