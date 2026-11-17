// Только для тестов: импорты ассетов (картинки, CSS), которые в браузере обрабатывает Vite,
// в Node подменяются заглушками. Картинка → строка-путь (как URL у Vite), CSS → пустой модуль.
import { register } from 'node:module';

register(
  'data:text/javascript,' +
    encodeURIComponent(`
const ASSET = /\\.(png|jpe?g|gif|webp|avif|svg)$/i;
const STYLE = /\\.css$/i;
export async function load(url, context, nextLoad) {
  const path = url.split(/[?#]/)[0];
  if (ASSET.test(path)) {
    return { format: 'module', shortCircuit: true, source: 'export default ' + JSON.stringify(path) + ';' };
  }
  if (STYLE.test(path)) return { format: 'module', shortCircuit: true, source: '' };
  return nextLoad(url, context);
}
`),
);
