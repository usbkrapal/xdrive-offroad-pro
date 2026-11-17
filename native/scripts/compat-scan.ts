// Статическая проверка собранного main.js под Node 8.7 (рантайм OAP на MGU).
// esbuild понижает синтаксис, но не встроенные API и не синтаксис регулярных выражений.
// Проверка намеренно грубая (по тексту), с явным списком исключений.

export interface CompatIssue {
  readonly rule: string;
  readonly line: number;
  readonly excerpt: string;
}

/** Встроенные API/синтаксис новее Node 8.7 → правило. */
const RULES: readonly (readonly [string, RegExp])[] = [
  ['Array.prototype.flat/flatMap (Node 11)', /\.flat(Map)?\(/],
  ['Object.fromEntries без полифила compat.ts (Node 12)', /Object\.fromEntries\(/],
  ['Object.hasOwn (Node 16.9)', /Object\.hasOwn\(/],
  ['globalThis (Node 12)', /\bglobalThis\b/],
  ['String.prototype.matchAll/replaceAll (Node 12/15)', /\.(matchAll|replaceAll)\(/],
  ['String.prototype.trimStart/trimEnd (Node 10)', /\.(trimStart|trimEnd)\(/],
  ['Promise.prototype.finally (Node 10)', /\.finally\(/],
  ['Promise.allSettled/any (Node 12.9/15)', /Promise\.(allSettled|any)\(/],
  ['Array.prototype.at / findLast (Node 16.6/18)', /\.(at|findLast|findLastIndex)\(-?\d/],
  ['structuredClone (Node 17)', /\bstructuredClone\(/],
  ['queueMicrotask (Node 11)', /\bqueueMicrotask\(/],
  ['BigInt (Node 10.4)', /\bBigInt\(/],
  ['performance.now как глобал (Node 16)', /(^|[^.\w])performance\.now\(/],
  ['RegExp lookbehind / named groups (Node 10)', /\(\?<[=!a-zA-Z]/],
  ['TextEncoder/TextDecoder как глобал (Node 11)', /(^|[^.\w])Text(En|De)coder\b/],
  ['URL как глобал (Node 10)', /new URL\(/],
  ['DOM/браузер', /\b(window|document|navigator|requestAnimationFrame|localStorage)\b\s*[.(]/],
];

/** Строки, где правило допустимо. */
function allowed(rule: string, line: string, polyfilled: boolean): boolean {
  // Общий доменный каталог вызывает Object.fromEntries; допустимо, только если полифил в бандле.
  if (rule.startsWith('Object.fromEntries') && polyfilled) return true;
  // Значение по умолчанию MockTelemetryProvider: не вызывается — нативное приложение передаёт часы явно.
  if (rule.startsWith('performance.now') && /now\s*=\s*\(\)\s*=>\s*performance\.now\(\)/.test(line)) return true;
  return false;
}

/** Требования модулей в бандле: только встроенные Node и внешний рантайм kit/assets. */
const BUILTINS = new Set(['fs', 'path', 'zlib', 'events', 'util', 'os', 'crypto', 'stream', 'buffer', 'child_process', 'net', 'module']);

/** Позиция первого вызова верхнего уровня `name();` (строка целиком), -1 — нет. Определение функции не считается. */
function topLevelCall(code: string, name: string): number {
  const m = new RegExp(`^${name}\\(([a-zA-Z_.]*)\\);$`, 'm').exec(code);
  return m ? m.index : -1;
}

export function scanBundle(code: string): CompatIssue[] {
  const issues: CompatIssue[] = [];
  const lines = code.split('\n');
  // Полифил считается установленным только после его вызова верхнего уровня (compat.ts), а не после
  // определения функции; поведение при загрузке без Object.fromEntries проверяет тест compat (vm).
  const polyfillAt = topLevelCall(code, 'installObjectFromEntries');
  // Выбор рендерера (bootstrap.ts) — до первого require('./kit/…'): renderd.js читает окружение при загрузке.
  const kitAt = code.search(/require\(["']\.\/kit\//);
  const targetAt = topLevelCall(code, 'selectRenderTarget');
  if (kitAt >= 0 && (targetAt < 0 || targetAt > kitAt)) {
    const line = code.slice(0, kitAt).split('\n').length;
    issues.push({ rule: 'selectRenderTarget(process.env) не раньше require ./kit/* (bootstrap.ts)', line, excerpt: lines[line - 1].trim().slice(0, 160) });
  }
  let offset = 0;
  lines.forEach((raw, i) => {
    const at = offset;
    offset += raw.length + 1;
    const line = raw.trim();
    if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) return;
    const polyfilled = polyfillAt >= 0 && polyfillAt < at;
    for (const [rule, re] of RULES) {
      if (re.test(raw) && !allowed(rule, raw, polyfilled)) issues.push({ rule, line: i + 1, excerpt: line.slice(0, 160) });
    }
    const reqs = raw.match(/require\((["'`])([^"'`]+)\1\)/g) || [];
    for (const r of reqs) {
      const id = /require\((["'`])([^"'`]+)\1\)/.exec(r)![2];
      if (!(BUILTINS.has(id) || /^\.\/kit\/[a-z_]+$/.test(id) || id === './assets')) {
        issues.push({ rule: `require не из списка: ${id}`, line: i + 1, excerpt: line.slice(0, 160) });
      }
    }
  });
  return issues;
}
