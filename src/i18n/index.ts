import { createContext, useContext } from 'react';
import { en } from './en';
import { ru, type Dictionary } from './ru';

export type Locale = 'ru' | 'en';
export type { Dictionary };

function merge<T>(base: T, patch: unknown): T {
  if (patch === undefined || typeof base !== 'object' || base === null) return (patch ?? base) as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    out[k] = merge((base as Record<string, unknown>)[k], v);
  }
  return out as T;
}

export function getDictionary(locale: Locale): Dictionary {
  return locale === 'en' ? merge<Dictionary>(ru, en) : ru;
}

export const I18nContext = createContext<Dictionary>(ru);

export function useT(): Dictionary {
  return useContext(I18nContext);
}
