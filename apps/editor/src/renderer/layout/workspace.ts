import type { AddPanelOptions, DockviewApi } from 'dockview';

const LAYOUT_KEY = 'aige.layout.v1';
let api: DockviewApi | null = null;

export const CORE_PANELS = {
  viewport: { title: 'Scene', component: 'viewport' },
  hierarchy: { title: 'Hierarchy', component: 'hierarchy' },
  inspector: { title: 'Inspector', component: 'inspector' },
  assets: { title: 'Project', component: 'assets' },
  console: { title: 'Console', component: 'console' },
  chat: { title: 'AI Assistant', component: 'chat' },
} as const;

export type CorePanelId = keyof typeof CORE_PANELS;

function add(opts: AddPanelOptions): void {
  api?.addPanel(opts);
}

/**
 * Unity-like default layout: Hierarchy | (Scene over Project/Console) | (Inspector, AI Assistant).
 * Written as a serialized layout with explicit pixel sizes (addPanel's initialWidth/Height and
 * group setSize do not take effect in dockview 8's shell layout).
 */
export function buildDefaultLayout(a: DockviewApi): void {
  const host = document.querySelector('.dock-root') as HTMLElement | null;
  const W = Math.max(900, host?.clientWidth ?? window.innerWidth);
  const H = Math.max(500, host?.clientHeight ?? window.innerHeight - 76);
  const left = Math.round(Math.min(280, Math.max(210, W * 0.155)));
  const right = Math.round(Math.min(380, Math.max(290, W * 0.215)));
  const bottom = Math.round(Math.min(300, Math.max(190, H * 0.3)));
  const leaf = (id: string, views: string[], size: number) => ({
    type: 'leaf',
    data: { views, activeView: views[0], id },
    size,
  });
  const panel = (id: CorePanelId) => ({
    id,
    contentComponent: CORE_PANELS[id].component,
    title: CORE_PANELS[id].title,
  });
  const layout = {
    grid: {
      root: {
        type: 'branch',
        data: [
          leaf('g-left', ['hierarchy'], left),
          {
            type: 'branch',
            data: [
              leaf('g-center', ['viewport'], H - bottom),
              leaf('g-bottom', ['assets', 'console'], bottom),
            ],
            size: W - left - right,
          },
          leaf('g-right', ['inspector', 'chat'], right),
        ],
        size: H,
      },
      width: W,
      height: H,
      orientation: 'HORIZONTAL',
    },
    panels: Object.fromEntries((Object.keys(CORE_PANELS) as CorePanelId[]).map((id) => [id, panel(id)])),
    activeGroup: 'g-center',
  };
  a.clear();
  a.fromJSON(layout as unknown as Parameters<DockviewApi['fromJSON']>[0]);
}

export function initLayout(a: DockviewApi): void {
  api = a;
  (window as unknown as { __aigeDock?: DockviewApi }).__aigeDock = a;
  let restored = false;
  try {
    const saved = localStorage.getItem(LAYOUT_KEY);
    if (saved) {
      a.fromJSON(JSON.parse(saved));
      restored = !!a.getPanel('viewport');
    }
  } catch {
    restored = false;
  }
  if (!restored) buildDefaultLayout(a);
  let timer: ReturnType<typeof setTimeout> | null = null;
  a.onDidLayoutChange(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        localStorage.setItem(LAYOUT_KEY, JSON.stringify(a.toJSON()));
      } catch {
        // storage unavailable
      }
    }, 400);
  });
}

export function resetLayout(): void {
  if (!api) return;
  try {
    localStorage.removeItem(LAYOUT_KEY);
  } catch {
    // ignore
  }
  buildDefaultLayout(api);
}

/** Shows a core panel, re-adding it (next to a sensible neighbour) if it was closed. */
export function showPanel(id: CorePanelId): void {
  if (!api) return;
  const existing = api.getPanel(id);
  if (existing) {
    existing.api.setActive();
    return;
  }
  const def = CORE_PANELS[id];
  const neighbour: Record<
    CorePanelId,
    { ref: CorePanelId; direction: 'left' | 'right' | 'below' | 'within' }
  > = {
    viewport: { ref: 'hierarchy', direction: 'right' },
    hierarchy: { ref: 'viewport', direction: 'left' },
    inspector: { ref: 'viewport', direction: 'right' },
    chat: { ref: 'inspector', direction: 'within' },
    assets: { ref: 'viewport', direction: 'below' },
    console: { ref: 'assets', direction: 'within' },
  };
  const n = neighbour[id];
  const ref = api.getPanel(n.ref);
  add({ id, ...def, ...(ref ? { position: { referencePanel: ref, direction: n.direction } } : {}) });
}

function basename(path: string): string {
  return path.split('/').pop() ?? path;
}

/** Opens a document panel (script or model) as a tab next to the scene view. */
function openDocument(kind: 'script' | 'modeling', path: string): void {
  if (!api) return;
  const id = `${kind}:${path}`;
  const existing = api.getPanel(id);
  if (existing) {
    existing.api.setActive();
    return;
  }
  const ref = api.getPanel('viewport') ?? api.activePanel;
  add({
    id,
    component: kind,
    title: kind === 'modeling' ? basename(path).replace(/\.model\.ts$/, '') : basename(path),
    params: { path },
    ...(ref ? { position: { referencePanel: ref, direction: 'within' } } : {}),
  });
}

export function openScript(path: string): void {
  openDocument('script', path);
}

export function openModel(path: string): void {
  openDocument('modeling', path);
}

export function dockApi(): DockviewApi | null {
  return api;
}
