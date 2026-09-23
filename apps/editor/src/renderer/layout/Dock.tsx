import {
  createDockview,
  type DockviewApi,
  type DockviewPanelApi,
  type DockviewTheme,
  type IContentRenderer,
  themeDark,
} from 'dockview';
import 'dockview/dist/styles/dockview.css';
import { type ComponentType, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface PanelProps<P = Record<string, any>> {
  params: P;
  api: DockviewPanelApi;
  containerApi: DockviewApi;
}

export type PanelComponent = ComponentType<PanelProps<any>>;

interface PortalEntry {
  id: string;
  name: string;
  element: HTMLElement;
  params: Record<string, any>;
  api: DockviewPanelApi;
  containerApi: DockviewApi;
}

const AIGE_THEME: DockviewTheme = { ...themeDark, name: 'aige', gap: 0 };

/**
 * React host for vanilla dockview (dockview 8 ships no React bindings): each panel's content element
 * gets a React portal, so panels share the app's React tree, stores and context.
 */
export function Dock({
  components,
  onReady,
}: {
  components: Record<string, PanelComponent>;
  onReady: (api: DockviewApi) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [entries, setEntries] = useState<PortalEntry[]>([]);
  const readyRef = useRef(onReady);
  readyRef.current = onReady;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const api = createDockview(el, {
      theme: AIGE_THEME,
      createComponent: ({ id, name }): IContentRenderer => {
        const element = document.createElement('div');
        element.className = 'dock-panel';
        let entry: PortalEntry | null = null;
        return {
          element,
          init: (p) => {
            entry = {
              id,
              name,
              element,
              params: (p.params as Record<string, any>) ?? {},
              api: p.api,
              containerApi: p.containerApi,
            };
            const e = entry;
            setEntries((list) => [...list.filter((x) => x.element !== element), e]);
          },
          update: (event) => {
            if (!entry) return;
            entry = { ...entry, params: { ...entry.params, ...(event.params as Record<string, any>) } };
            const e = entry;
            setEntries((list) => list.map((x) => (x.element === element ? e : x)));
          },
          dispose: () => setEntries((list) => list.filter((x) => x.element !== element)),
        };
      },
    });
    // dockview 8's shell does not pick up the container size on its own here: drive layout explicitly.
    const relayout = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w > 0 && h > 0) api.layout(w, h, true);
    };
    relayout();
    const ro = new ResizeObserver(() => requestAnimationFrame(relayout));
    ro.observe(el);
    readyRef.current(api);
    relayout();
    return () => {
      ro.disconnect();
      api.dispose();
    };
  }, []);

  return (
    <div ref={ref} className="dock-root">
      {entries.map((e) => {
        const C = components[e.name];
        return C
          ? createPortal(<C params={e.params} api={e.api} containerApi={e.containerApi} />, e.element, e.id)
          : null;
      })}
    </div>
  );
}
