import { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { createModelEntity, viewportApi } from '../actions.ts';
import { host } from '../host/client.ts';
import { call, run } from '../host/session.ts';
import type { PanelProps } from '../layout/Dock.tsx';
import { openModel, openScript } from '../layout/workspace.ts';
import { editor, useEditor } from '../store/editor.ts';
import { Icon } from '../ui/Icon.tsx';
import {
  confirmDialog,
  type MenuItem,
  ModalHeader,
  openMenu,
  openModal,
  promptText,
  toast,
} from '../ui/overlays.tsx';
import { ASSET_MIME } from '../viewport/ViewportPanel.tsx';

// ------------------------------------------------------------------ thumbnails (model_preview-style iso render, cached)

type Thumb = { state: 'loading' } | { state: 'ok'; url: string } | { state: 'error'; message: string };
const useThumbs = create<{ thumbs: Record<string, Thumb> }>(() => ({ thumbs: {} }));
let thumbQueue: Promise<void> = Promise.resolve();

function requestThumb(path: string, version: number): void {
  const id = `${path}|${version}`;
  if (useThumbs.getState().thumbs[id]) return;
  useThumbs.setState((s) => ({ thumbs: { ...s.thumbs, [id]: { state: 'loading' } } }));
  thumbQueue = thumbQueue.then(async () => {
    try {
      const r = await host.request<{ png: string }>({ type: 'editor.thumbnail', path });
      useThumbs.setState((s) => ({
        thumbs: { ...s.thumbs, [id]: { state: 'ok', url: `data:image/png;base64,${r.png}` } },
      }));
    } catch (err) {
      useThumbs.setState((s) => ({
        thumbs: { ...s.thumbs, [id]: { state: 'error', message: (err as Error).message } },
      }));
    }
  });
}

function ModelThumb({ path }: { path: string }) {
  // Recipes can import helpers anywhere under models/, so any models/ change re-renders thumbnails.
  const version = useEditor((s) =>
    Object.entries(s.fileVersions).reduce(
      (n, [p, v]) => (p.startsWith('models/') || p === path ? n + v : n),
      0,
    ),
  );
  const thumb = useThumbs((s) => s.thumbs[`${path}|${version}`]);
  useEffect(() => requestThumb(path, version), [path, version]);
  if (thumb?.state === 'ok')
    return <img className="asset-thumb-img" src={thumb.url} alt="" draggable={false} />;
  if (thumb?.state === 'error')
    return (
      <div className="asset-thumb-icon error" title={thumb.message}>
        <Icon name="warning" size={22} />
      </div>
    );
  return (
    <div className="asset-thumb-icon">
      <span className="spinner" />
    </div>
  );
}

// ------------------------------------------------------------------ panel

interface AssetItem {
  kind: 'model' | 'script' | 'material' | 'prefab' | 'scene' | 'texture' | 'audio';
  path: string;
  name: string;
}

const GROUPS: { kind: AssetItem['kind']; title: string; icon: string }[] = [
  { kind: 'model', title: 'Models', icon: 'model' },
  { kind: 'script', title: 'Scripts', icon: 'script' },
  { kind: 'material', title: 'Materials', icon: 'material' },
  { kind: 'prefab', title: 'Prefabs', icon: 'prefab' },
  { kind: 'scene', title: 'Scenes', icon: 'scene' },
  { kind: 'texture', title: 'Textures', icon: 'texture' },
  { kind: 'audio', title: 'Audio', icon: 'audio' },
];

const baseName = (p: string) =>
  (p.split('/').pop() ?? p).replace(
    /\.(model\.ts|ts|material\.json|prefab\.json|scene\.json|glb|png|jpe?g|webp|mp3|ogg|wav)$/i,
    '',
  );

export function AssetsPanel(_props: PanelProps) {
  const files = useEditor((s) => s.files);
  const st = useEditor((s) => s.state);
  const [query, setQuery] = useState('');
  const [showTemplates, setShowTemplates] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<string | null>(null);

  const items = useMemo(() => {
    const out: AssetItem[] = [];
    for (const f of files) {
      if (/\.model\.ts$|\.glb$/.test(f) && f.startsWith('models/')) {
        if (!showTemplates && f.startsWith('models/templates/')) continue;
        out.push({ kind: 'model', path: f, name: baseName(f) });
      } else if (f.startsWith('scripts/') && f.endsWith('.ts') && !f.endsWith('.d.ts'))
        out.push({ kind: 'script', path: f, name: baseName(f) });
      else if (/\.(png|jpe?g|webp)$/i.test(f) && !f.startsWith('dist/'))
        out.push({ kind: 'texture', path: f, name: baseName(f) });
      else if (/\.(mp3|ogg|wav)$/i.test(f)) out.push({ kind: 'audio', path: f, name: baseName(f) });
    }
    for (const p of Object.keys(st?.materials ?? {}))
      out.push({ kind: 'material', path: p, name: baseName(p) });
    for (const p of Object.keys(st?.prefabs ?? {})) out.push({ kind: 'prefab', path: p, name: baseName(p) });
    for (const p of Object.keys(st?.scenes ?? {}))
      out.push({ kind: 'scene', path: p, name: st?.scenes[p]?.name ?? baseName(p) });
    const q = query.trim().toLowerCase();
    return q ? out.filter((i) => i.path.toLowerCase().includes(q)) : out;
  }, [files, st, query, showTemplates]);

  const open = (item: AssetItem) => {
    if (item.kind === 'model') {
      if (item.path.endsWith('.model.ts')) openModel(item.path);
      else toast('GLB files are imported models; they cannot be edited here.');
    } else if (item.kind === 'script') openScript(item.path);
    else if (item.kind === 'scene') void run('scene_open', { scene: item.path });
    else if (item.kind === 'prefab')
      void run('prefab_instantiate', {
        prefab: item.path,
        position: viewportApi()?.spawnPoint() ?? [0, 0, 0],
      });
  };

  const menuFor = (item: AssetItem): MenuItem[] => {
    const m: MenuItem[] = [];
    if (item.kind === 'model') {
      m.push({
        label: 'Open in Modeling',
        icon: 'model',
        onClick: () => open(item),
        disabled: !item.path.endsWith('.model.ts'),
      });
      m.push({ label: 'Add to Scene', icon: 'plus', onClick: () => void createModelEntity(item.path) });
    } else if (item.kind === 'script')
      m.push({ label: 'Edit Script', icon: 'code', onClick: () => open(item) });
    else if (item.kind === 'scene') m.push({ label: 'Open Scene', icon: 'scene', onClick: () => open(item) });
    else if (item.kind === 'prefab')
      m.push({ label: 'Instantiate', icon: 'plus', onClick: () => open(item) });
    m.push({
      label: 'Reveal in Explorer',
      icon: 'folderOpen',
      onClick: () => window.aige.revealInFolder(item.path),
    });
    m.push({
      label: 'Copy Path',
      icon: 'copy',
      onClick: () => void navigator.clipboard?.writeText(item.path),
    });
    if (item.kind === 'model' || item.kind === 'script' || item.kind === 'texture' || item.kind === 'audio') {
      m.push({ separator: true });
      m.push({
        label: 'Delete',
        icon: 'trash',
        danger: true,
        onClick: async () => {
          if (
            await confirmDialog({
              title: 'Delete file',
              message: `Delete ${item.path}? You can undo this.`,
              okLabel: 'Delete',
              danger: true,
            })
          )
            void run('file_delete', { path: item.path });
        },
      });
    }
    return m;
  };

  return (
    <div className="panel assets">
      <div className="panel-toolbar">
        <button
          type="button"
          className="btn small"
          onClick={openTemplatePicker}
          title="New model from a built-in template (model_templates)"
        >
          <Icon name="model" size={13} /> New Model
        </button>
        <button type="button" className="btn small" onClick={() => void newScript()}>
          <Icon name="script" size={13} /> New Script
        </button>
        <button type="button" className="btn small" onClick={() => void newMaterial()}>
          <Icon name="material" size={13} /> New Material
        </button>
        <div className="search" style={{ maxWidth: 240, marginLeft: 'auto' }}>
          <Icon name="search" size={13} />
          <input placeholder="Search assets" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <button
          type="button"
          className={`icon-btn${showTemplates ? ' active' : ''}`}
          title="Show template base recipes"
          onClick={() => setShowTemplates(!showTemplates)}
        >
          <Icon name="layout" size={14} />
        </button>
      </div>
      <div className="panel-body assets-body" data-testid="assets">
        {GROUPS.map((g) => {
          const list = items.filter((i) => i.kind === g.kind);
          if (!list.length && g.kind !== 'model' && g.kind !== 'script') return null;
          const isCollapsed = collapsed.has(g.kind);
          return (
            <div key={g.kind} className="asset-group">
              <button
                type="button"
                className="asset-group-head"
                onClick={() =>
                  setCollapsed((c) => {
                    const n = new Set(c);
                    if (n.has(g.kind)) n.delete(g.kind);
                    else n.add(g.kind);
                    return n;
                  })
                }
              >
                <Icon name={isCollapsed ? 'chevronRight' : 'chevronDown'} size={12} />
                <Icon name={g.icon} size={13} />
                <span>{g.title}</span>
                <span className="tree-count">{list.length}</span>
              </button>
              {!isCollapsed ? (
                list.length ? (
                  <div className="asset-grid">
                    {list.map((item) => (
                      <button
                        type="button"
                        key={item.path}
                        className={`asset-tile${selected === item.path ? ' selected' : ''}`}
                        title={item.path}
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setData(
                            ASSET_MIME,
                            JSON.stringify({ kind: item.kind, path: item.path }),
                          );
                          e.dataTransfer.effectAllowed = 'copy';
                        }}
                        onClick={() => setSelected(item.path)}
                        onDoubleClick={() => open(item)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setSelected(item.path);
                          openMenu(e.clientX, e.clientY, menuFor(item));
                        }}
                      >
                        <div className="asset-thumb">
                          {item.kind === 'model' && item.path.endsWith('.model.ts') ? (
                            <ModelThumb path={item.path} />
                          ) : item.kind === 'material' ? (
                            <MaterialSwatch path={item.path} />
                          ) : (
                            <div className={`asset-thumb-icon kind-${item.kind}`}>
                              <Icon
                                name={GROUPS.find((x) => x.kind === item.kind)?.icon ?? 'file'}
                                size={26}
                              />
                            </div>
                          )}
                        </div>
                        <span className="asset-name">{item.name}</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="asset-empty">
                    {g.kind === 'model' ? 'No models yet. Create one from a template.' : 'No scripts yet.'}
                  </div>
                )
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MaterialSwatch({ path }: { path: string }) {
  const m = useEditor((s) => s.state?.materials[path]);
  if (!m) return null;
  const metal = m.metalness > 0.5;
  return (
    <div className="asset-thumb-icon">
      <div
        className="material-ball"
        style={{
          background: `radial-gradient(circle at 35% 30%, ${metal ? '#ffffff' : 'rgba(255,255,255,0.55)'} 0%, ${m.color} ${metal ? 25 : 35}%, #000 ${metal ? 110 : 130}%)`,
        }}
      />
    </div>
  );
}

// ------------------------------------------------------------------ creation

const toPascal = (name: string) =>
  name
    .replace(/[^a-zA-Z0-9]+(.)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : ''))
    .replace(/^./, (c) => c.toUpperCase())
    .replace(/^(\d)/, '_$1');

async function newScript(): Promise<void> {
  const name = await promptText({
    title: 'New script',
    label: 'Script name (saved as scripts/<name>.ts)',
    initial: 'my-behaviour',
    okLabel: 'Create',
    validate: (v) => (/^[a-zA-Z0-9][\w-]*$/.test(v) ? null : 'Use letters, digits, - and _'),
  });
  if (!name) return;
  const cls = toPascal(name);
  const source = `import { Behaviour } from 'aige';

/** ${cls}: describe what this behaviour does. Attach it with a Script component. */
export default class ${cls} extends Behaviour {
  static props = { speed: 90 };

  start() {
    // runs once when the game starts
  }

  update(dt: number) {
    this.entity.rotate([0, this.props.speed * dt, 0]);
  }
}
`;
  const res = await run<{ script: string }>('script_write', { name, source, typecheck: false });
  if (res) openScript(res.script);
}

async function newMaterial(): Promise<void> {
  const name = await promptText({
    title: 'New material',
    label: 'Material name (saved as materials/<name>.material.json)',
    initial: 'material',
    okLabel: 'Create',
    validate: (v) => (/^[a-zA-Z0-9][\w-]*$/.test(v) ? null : 'Use letters, digits, - and _'),
  });
  if (!name) return;
  const res = await run<{ path: string }>('material_create', { name, color: '#c8c8c8' });
  if (res) toast(`Created ${res.path}`, 'ok');
}

interface TemplateInfo {
  name: string;
  description: string;
  params: string;
}

function openTemplatePicker(): void {
  openModal((close) => <TemplatePicker close={close} />, { wide: true });
}

function TemplatePicker({ close }: { close: () => void }) {
  const [templates, setTemplates] = useState<TemplateInfo[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void call<{ templates: TemplateInfo[] }>('model_templates', {}).then((r) => {
      if (r.ok) setTemplates(r.result.templates);
      else setError(r.error.message);
    });
  }, []);
  const files = editor.get().files;
  const create = async () => {
    if (!chosen) return;
    const target = name.trim() || chosen;
    if (!/^[a-z0-9][a-z0-9-_]*$/i.test(target)) {
      setError('Use letters, digits, - and _ in the name.');
      return;
    }
    setBusy(true);
    setError(null);
    const r = await call<{ model: string }>('model_from_template', {
      template: chosen,
      name: target,
      preview: false,
    });
    setBusy(false);
    if (!r.ok) {
      setError(`${r.error.message}${r.error.hint ? ` ${r.error.hint}` : ''}`);
      return;
    }
    close();
    openModel(r.result.model);
  };
  return (
    <div>
      <ModalHeader title="New model from template" icon="model" onClose={close} />
      <div className="modal-body">
        {!templates && !error ? <span className="spinner" /> : null}
        <div className="template-grid">
          {templates?.map((t) => (
            <button
              type="button"
              key={t.name}
              className={`template-card${chosen === t.name ? ' active' : ''}`}
              onClick={() => {
                setChosen(t.name);
                if (!name || templates.some((x) => x.name === name)) {
                  let n = t.name;
                  for (let i = 2; files.includes(`models/${n}.model.ts`); i++) n = `${t.name}-${i}`;
                  setName(n);
                }
              }}
              onDoubleClick={() => void create()}
            >
              <Icon name="model" size={18} />
              <strong>{t.name}</strong>
              <span>{t.description}</span>
            </button>
          ))}
        </div>
        {chosen ? (
          <>
            <div className="field-label">Model name (saved as models/&lt;name&gt;.model.ts)</div>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </>
        ) : null}
        {error ? <div className="form-error">{error}</div> : null}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn" onClick={close}>
          Cancel
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={!chosen || busy}
          onClick={() => void create()}
        >
          {busy ? <span className="spinner" /> : null} Create
        </button>
      </div>
    </div>
  );
}
