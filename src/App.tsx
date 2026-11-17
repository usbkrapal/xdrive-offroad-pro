import { useState } from 'react';
import { useAppState, useStore } from './app/useAppState';
import { sessionElapsedMs } from './domain/session';
import { DemoToolbar } from './components/DemoToolbar';
import { Header, TAB_IDS, panelDomId, tabDomId, type TabId } from './components/Header';
import { formatDuration } from './i18n/format';
import { CamerasScreen } from './screens/CamerasScreen';
import { SuspensionScreen } from './screens/SuspensionScreen';
import { SystemsScreen } from './screens/SystemsScreen';
import { TerrainScreen } from './screens/TerrainScreen';
import { TractionScreen } from './screens/TractionScreen';

const SCREENS = {
  terrain: TerrainScreen,
  traction: TractionScreen,
  suspension: SuspensionScreen,
  systems: SystemsScreen,
  cameras: CamerasScreen,
} as const;

export function App() {
  const store = useStore();
  const state = useAppState();
  const [tab, setTab] = useState<TabId>('terrain');
  const Screen = SCREENS[tab];

  return (
    <div className="app">
      <Header active={tab} onSelect={setTab} sessionClock={formatDuration(sessionElapsedMs(state.session, state.snapshot.simTimeMs))} />
      <main className="main">
        {TAB_IDS.map((id) => (
          <div
            key={id}
            id={panelDomId(id)}
            role="tabpanel"
            aria-labelledby={tabDomId(id)}
            hidden={id !== tab}
            tabIndex={id === tab ? 0 : -1}
            className="screen"
          >
            {id === tab ? <Screen state={state} /> : null}
          </div>
        ))}
      </main>
      <DemoToolbar
        scenarioId={state.scenarioId}
        paused={state.paused}
        simTimeMs={state.snapshot.simTimeMs}
        onScenario={(id) => store.setScenario(id)}
        onTogglePause={() => store.setPaused(!state.paused)}
        onNewSession={() => store.newSession()}
      />
    </div>
  );
}
