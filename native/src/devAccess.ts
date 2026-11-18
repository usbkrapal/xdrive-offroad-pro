// Доступ разработчика — только явной переменной окружения процесса при запуске (XOP_DEV), никогда из настроек или
// касанием. Обычный запуск: данные автомобиля, без демо, без листа диагностики, без вкладки «Настройки».
//
//   XOP_DEV=diag              кнопка «Диагностика» на странице «Системы» (лист снимка чтения, «Обновить»)
//   XOP_DEV=demo              демо-данные вместо автомобиля (бейдж ДЕМО в шапке; источник один — не смешиваются)
//   XOP_DEV=demo=hdcDescent   то же со сценарием
//   XOP_DEV=demo,diag         оба; «1» — то же, что diag
//
// Демо выбирается только при запуске и нигде не сохраняется: следующий обычный запуск — снова автомобиль.

import { SCENARIO_IDS, type ScenarioId } from '../../src/domain/types';

export const DEV_ENV = 'XOP_DEV';

export interface DevAccess {
  /** Демо вместо автомобиля на весь запуск. */
  readonly demo: boolean;
  /** Сценарий демо из XOP_DEV (иначе — сохранённый/по умолчанию). */
  readonly scenario: ScenarioId | null;
  /** Лист диагностики чтения доступен кнопкой на странице. */
  readonly diagnostics: boolean;
}

export const PRODUCTION: DevAccess = { demo: false, scenario: null, diagnostics: false };

export function devAccess(env: Readonly<Record<string, string | undefined>>): DevAccess {
  const tokens = String(env[DEV_ENV] || '')
    .toLowerCase()
    .split(/[,\s]+/)
    .filter(Boolean);
  if (!tokens.length) return PRODUCTION;
  let demo = false;
  let scenario: ScenarioId | null = null;
  let diagnostics = false;
  for (const t of tokens) {
    if (t === 'diag' || t === '1') diagnostics = true;
    else if (t === 'demo') demo = true;
    else if (t.indexOf('demo=') === 0) {
      demo = true;
      // сценарии в camelCase: сравнение без учёта регистра
      const want = t.slice(5);
      scenario = SCENARIO_IDS.find((s) => s.toLowerCase() === want) ?? null;
    }
  }
  return { demo, scenario, diagnostics };
}
