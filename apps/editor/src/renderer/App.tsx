import { lazy, Suspense, useEffect, useRef } from 'react';
import { ChatPanel } from './chat/ChatPanel.tsx';
import { AssetsPanel } from './components/Assets.tsx';
import { ConsolePanel } from './components/Console.tsx';
import { HierarchyPanel } from './components/Hierarchy.tsx';
import { TitleBar, Toolbar } from './components/TopBar.tsx';
import { Welcome } from './components/Welcome.tsx';
import { InspectorPanel } from './inspector/Inspector.tsx';
import { Dock, type PanelComponent, type PanelProps } from './layout/Dock.tsx';
import { dockApi, initLayout } from './layout/workspace.ts';
import { useGlobalShortcuts } from './shortcuts.ts';
import { useEditor } from './store/editor.ts';
import { MenuLayer, ModalLayer, ToastLayer } from './ui/overlays.tsx';
import { ViewportPanel } from './viewport/ViewportPanel.tsx';

// Monaco is large: the script editor and modeling workspace load on first use.
const LazyScript = lazy(() => import('./code/ScriptPanel.tsx').then((m) => ({ default: m.ScriptPanel })));
const LazyModeling = lazy(() =>
  import('./modeling/ModelingPanel.tsx').then((m) => ({ default: m.ModelingPanel })),
);

const loading = (
  <div className="panel-empty">
    <span className="spinner" />
  </div>
);

function ScriptPanelLazy(props: PanelProps) {
  return (
    <Suspense fallback={loading}>
      <LazyScript {...(props as PanelProps<{ path: string }>)} />
    </Suspense>
  );
}

function ModelingPanelLazy(props: PanelProps) {
  return (
    <Suspense fallback={loading}>
      <LazyModeling {...(props as PanelProps<{ path: string }>)} />
    </Suspense>
  );
}

const PANELS: Record<string, PanelComponent> = {
  viewport: ViewportPanel,
  hierarchy: HierarchyPanel,
  inspector: InspectorPanel,
  assets: AssetsPanel,
  console: ConsolePanel,
  chat: ChatPanel,
  script: ScriptPanelLazy,
  modeling: ModelingPanelLazy,
};

export function App() {
  const root = useEditor((s) => s.root);
  const play = useEditor((s) => s.play);
  const connected = useEditor((s) => s.connected);
  useGlobalShortcuts();

  // Documents from a previous project make no sense in the next one.
  const prevRoot = useRef(root);
  useEffect(() => {
    if (prevRoot.current && root !== prevRoot.current) {
      const api = dockApi();
      for (const p of api?.panels ?? [])
        if (p.id.startsWith('script:') || p.id.startsWith('modeling:')) p.api.close();
    }
    prevRoot.current = root;
  }, [root]);

  return (
    <div className={`app${play !== 'edit' ? ' playing' : ''}`}>
      <TitleBar />
      {root ? (
        <>
          <Toolbar />
          <div className="main">
            <Dock components={PANELS} onReady={initLayout} />
          </div>
        </>
      ) : connected ? (
        <Welcome />
      ) : (
        <div className="boot">
          <span className="spinner large" />
          <span>Starting AIGE...</span>
        </div>
      )}
      <MenuLayer />
      <ModalLayer />
      <ToastLayer />
    </div>
  );
}
