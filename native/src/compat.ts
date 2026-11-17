// Совместимость с Node 8.7 на MGU. esbuild понижает синтаксис, но не встроенные API.
// Общий доменный код (src/domain/signalCatalog.ts) при загрузке вызывает Object.fromEntries
// (Node 12+). Здесь — только этот метод и только если его нет; других глобальных полифилов нет.
// Модуль импортируется в точке входа (main.ts) раньше любого общего кода (сразу после bootstrap.ts).

export function fromEntries<V>(entries: Iterable<readonly [PropertyKey, V]>): Record<string, V> {
  const out: Record<string, V> = {};
  for (const [k, v] of entries) out[k as string] = v;
  return out;
}

/** true — метод отсутствовал и был добавлен. */
export function installObjectFromEntries(target: { fromEntries?: unknown } = Object as never): boolean {
  if (typeof target.fromEntries === 'function') return false;
  Object.defineProperty(target, 'fromEntries', { value: fromEntries, writable: true, configurable: true, enumerable: false });
  return true;
}

installObjectFromEntries();
