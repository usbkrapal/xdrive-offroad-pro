import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AppStore } from './app/store';
import { StoreContext } from './app/useAppState';
import { I18nContext, getDictionary } from './i18n';
import { MockTelemetryProvider } from './providers/mock/MockTelemetryProvider';
import './styles.css';
// После styles.css: экран «Камеры» и поправки шапки на пять вкладок переопределяют базовые правила.
import './cameras.css';

const provider = new MockTelemetryProvider('mountainTrail');
const store = new AppStore(provider);
provider.start();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nContext.Provider value={getDictionary('ru')}>
      <StoreContext.Provider value={store}>
        <App />
      </StoreContext.Provider>
    </I18nContext.Provider>
  </StrictMode>,
);
