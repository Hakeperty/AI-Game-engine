import type { ImageRef } from '@aige/core';
import { useEffect, useState } from 'react';
import { host } from '../host/client.ts';
import { call, refreshInfo } from '../host/session.ts';
import { editor, log } from '../store/editor.ts';
import { Icon } from '../ui/Icon.tsx';
import { ModalHeader, openModal, toast } from '../ui/overlays.tsx';

const imgSrc = (img: { data: string; mimeType?: string }) =>
  `data:${img.mimeType ?? 'image/png'};base64,${img.data}`;

// ------------------------------------------------------------------ projects

export function openNewProjectDialog(): void {
  openModal((close) => <NewProjectForm close={close} />);
}

function NewProjectForm({ close }: { close: () => void }) {
  const [name, setName] = useState('my-game');
  const [template, setTemplate] = useState<'basic' | 'empty'>('basic');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = /^[\w-]+$/.test(name);
  const dir = editor.get().info?.workspaceDir ?? '~/AigeProjects';
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (!valid || busy) return;
        setBusy(true);
        setError(null);
        const r = await call('project_create', { name, template });
        setBusy(false);
        if (r.ok) close();
        else setError(`${r.error.message}${r.error.hint ? ` ${r.error.hint}` : ''}`);
      }}
    >
      <ModalHeader title="New project" icon="plus" onClose={close} />
      <div className="modal-body">
        <div className="field-label">Name</div>
        <input
          className="input"
          // biome-ignore lint/a11y/noAutofocus: dialog
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          data-testid="new-project-name"
        />
        {!valid ? <div className="form-error">Use letters, digits, - and _ only.</div> : null}
        <div className="field-label" style={{ marginTop: 6 }}>
          Template
        </div>
        <div className="template-choice">
          {(['basic', 'empty'] as const).map((t) => (
            <button
              key={t}
              type="button"
              className={`template-card${template === t ? ' active' : ''}`}
              onClick={() => setTemplate(t)}
            >
              <Icon name={t === 'basic' ? 'scene' : 'empty'} size={20} />
              <strong>{t === 'basic' ? '3D Basic' : 'Empty'}</strong>
              <span>
                {t === 'basic' ? 'Camera, sun light and a ground plane' : 'Nothing but an empty scene'}
              </span>
            </button>
          ))}
        </div>
        <div className="muted" style={{ fontSize: 11 }}>
          Location: {dir.replaceAll('\\', '/')}/{name}
        </div>
        {error ? <div className="form-error">{error}</div> : null}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn" onClick={close}>
          Cancel
        </button>
        <button type="submit" className="btn primary" disabled={!valid || busy} data-testid="create-project">
          {busy ? <span className="spinner" /> : null}
          Create
        </button>
      </div>
    </form>
  );
}

export async function openProjectFolder(): Promise<void> {
  const path = await window.aige.openFolderDialog('Open AIGE project folder');
  if (!path) return;
  await openProjectPath(path);
}

export async function openProjectPath(path: string): Promise<boolean> {
  const r = await call('project_open', { path });
  if (!r.ok) {
    toast(r.error.message, 'error', 5000);
    log('error', r.error.message, 'ui', r.error.hint ? { hint: r.error.hint } : {});
    void refreshInfo();
    return false;
  }
  return true;
}

// ------------------------------------------------------------------ screenshot

export function takeScreenshot(): void {
  openModal((close) => <ScreenshotView close={close} />, { wide: true });
}

function ScreenshotView({ close }: { close: () => void }) {
  const [state, setState] = useState<{ images?: ImageRef[]; warnings?: string[]; error?: string } | null>(
    null,
  );
  useEffect(() => {
    let alive = true;
    void call<{ images: ImageRef[]; warnings?: string[] }>('render_screenshot', {}).then((r) => {
      if (!alive) return;
      setState(
        r.ok
          ? { images: r.result.images, ...(r.result.warnings ? { warnings: r.result.warnings } : {}) }
          : { error: r.error.message },
      );
    });
    return () => {
      alive = false;
    };
  }, []);
  const img = state?.images?.[0];
  return (
    <div>
      <ModalHeader title="Screenshot (render_screenshot)" icon="camera" onClose={close} />
      <div className="modal-body">
        {!state ? (
          <div className="busy-block">
            <span className="spinner large" />
            <span>Rendering with the headless renderer...</span>
          </div>
        ) : state.error ? (
          <div className="form-error">{state.error}</div>
        ) : img ? (
          <>
            <img className="screenshot-img" src={imgSrc(img)} alt="Scene screenshot" />
            {img.path ? <div className="muted">Saved to {img.path}</div> : null}
            {state.warnings?.map((w) => (
              <div key={w} className="form-error">
                {w}
              </div>
            ))}
          </>
        ) : null}
      </div>
      <div className="modal-footer">
        {img?.path ? (
          <button type="button" className="btn" onClick={() => window.aige.revealInFolder(img.path!)}>
            <Icon name="folderOpen" size={14} /> Reveal
          </button>
        ) : null}
        <button type="button" className="btn primary" onClick={close}>
          Close
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ headless play-test

export function openPlayTestDialog(): void {
  openModal((close) => <PlayTestView close={close} />, { wide: true });
}

interface PlayTestResult {
  simulatedSeconds: number;
  over: { result: string; message: string } | null;
  gameState: Record<string, unknown>;
  hud: Record<string, string>;
  errors: string[];
  events: { counts: Record<string, number>; first: string[] };
  logs: string[];
  probes: Record<string, string[]>;
  warnings?: string[];
  images?: ImageRef[];
}

const DEFAULT_INPUTS = `[
  { "at": 0, "axis": "move_y", "value": 1 },
  { "at": 1.5, "action": "jump" },
  { "at": 3, "axis": "move_y", "value": 0 }
]`;

function PlayTestView({ close }: { close: () => void }) {
  const [seconds, setSeconds] = useState(6);
  const [inputs, setInputs] = useState(DEFAULT_INPUTS);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PlayTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runTest = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(inputs || '[]');
    } catch (err) {
      setError(`Inputs are not valid JSON: ${(err as Error).message}`);
      return;
    }
    setBusy(true);
    setError(null);
    const r = await call<PlayTestResult>('game_run_headless', {
      seconds,
      inputs: parsed,
      screenshotsAt: [Math.min(seconds, 2)],
    });
    setBusy(false);
    if (r.ok) setResult(r.result);
    else setError(`${r.error.message}${r.error.hint ? ` (${r.error.hint})` : ''}`);
  };
  return (
    <div>
      <ModalHeader title="Headless play-test (game_run_headless)" icon="flask" onClose={close} />
      <div className="modal-body playtest">
        <div className="playtest-form">
          <div>
            <div className="field-label">Seconds</div>
            <input
              className="input"
              type="number"
              min={1}
              max={120}
              value={seconds}
              onChange={(e) => setSeconds(Number(e.target.value) || 1)}
            />
          </div>
          <div style={{ flex: 1 }}>
            <div className="field-label">Scripted inputs (JSON)</div>
            <textarea
              className="textarea mono"
              rows={5}
              value={inputs}
              onChange={(e) => setInputs(e.target.value)}
            />
          </div>
        </div>
        {error ? <div className="form-error">{error}</div> : null}
        {result ? (
          <div className="playtest-result">
            <div className="playtest-summary">
              <span className={`badge ${result.errors.length ? 'err' : 'ok'}`}>
                {result.errors.length ? `${result.errors.length} script error(s)` : 'No script errors'}
              </span>
              {result.over ? (
                <span className={`badge ${result.over.result === 'win' ? 'ok' : 'err'}`}>
                  {result.over.result.toUpperCase()}: {result.over.message}
                </span>
              ) : null}
              <span className="badge">{result.simulatedSeconds}s simulated</span>
            </div>
            {result.images?.[0] ? (
              <img className="screenshot-img" src={imgSrc(result.images[0])} alt="Game camera" />
            ) : null}
            <pre className="result-pre">
              {[
                result.errors.length ? `Errors:\n${result.errors.join('\n')}` : '',
                Object.keys(result.hud).length ? `HUD: ${JSON.stringify(result.hud)}` : '',
                Object.keys(result.gameState).length ? `Game.state: ${JSON.stringify(result.gameState)}` : '',
                Object.keys(result.events.counts).length
                  ? `Events: ${JSON.stringify(result.events.counts)}`
                  : '',
                ...Object.entries(result.probes).map(([k, v]) => `Probe ${k}: ${v.slice(0, 12).join('  ')}`),
                result.logs.length ? `Logs:\n${result.logs.join('\n')}` : '',
                result.warnings?.length ? `Warnings:\n${result.warnings.join('\n')}` : '',
              ]
                .filter(Boolean)
                .join('\n\n') || 'Nothing to report.'}
            </pre>
          </div>
        ) : null}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn" onClick={close}>
          Close
        </button>
        <button type="button" className="btn primary" disabled={busy} onClick={runTest}>
          {busy ? <span className="spinner" /> : <Icon name="play" size={12} />} Run
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ web export

export function openExportDialog(): void {
  openModal((close) => <ExportView close={close} />, { wide: true });
}

interface ExportResultView {
  path: string;
  absolutePath: string;
  files: { name: string; bytes: number }[];
  models: number;
  scripts: number;
  smoke?: { frames: number; errors: string[]; ok: boolean; renderer: string };
  images?: ImageRef[];
}

function ExportView({ close }: { close: () => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExportResultView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [out, setOut] = useState('dist');
  const doExport = async () => {
    setBusy(true);
    setError(null);
    const r = await call<ExportResultView>('export_web', { out, smokeTest: true });
    setBusy(false);
    if (r.ok) {
      setResult(r.result);
      toast(`Exported to ${r.result.path}`, 'ok');
    } else setError(`${r.error.message}${r.error.hint ? ` (${r.error.hint})` : ''}`);
  };
  const kb = (n: number) => `${(n / 1024).toFixed(n > 1024 * 100 ? 0 : 1)} KB`;
  return (
    <div>
      <ModalHeader title="Export web build (export_web)" icon="upload" onClose={close} />
      <div className="modal-body">
        <div className="field-label">Output folder (inside the project)</div>
        <input className="input" value={out} onChange={(e) => setOut(e.target.value)} />
        {busy ? (
          <div className="busy-block">
            <span className="spinner large" />
            <span>Bundling the player, baking models and smoke-testing the build...</span>
          </div>
        ) : null}
        {error ? <div className="form-error">{error}</div> : null}
        {result ? (
          <>
            <div className="playtest-summary">
              <span className={`badge ${result.smoke?.ok === false ? 'err' : 'ok'}`}>
                {result.smoke
                  ? result.smoke.ok
                    ? `Smoke test passed (${result.smoke.frames} frames)`
                    : 'Smoke test failed'
                  : 'Exported'}
              </span>
              <span className="badge">{result.models} models</span>
              <span className="badge">{result.scripts} scripts</span>
            </div>
            {result.images?.[0] ? (
              <img className="screenshot-img" src={imgSrc(result.images[0])} alt="Exported game" />
            ) : null}
            <pre className="result-pre">
              {result.files.map((f) => `${f.name.padEnd(18)} ${kb(f.bytes)}`).join('\n')}
              {result.smoke?.errors.length ? `\n\nErrors:\n${result.smoke.errors.join('\n')}` : ''}
            </pre>
          </>
        ) : null}
      </div>
      <div className="modal-footer">
        {result ? (
          <button
            type="button"
            className="btn"
            onClick={() => window.aige.revealInFolder(`${result.path}/index.html`)}
          >
            <Icon name="folderOpen" size={14} /> Reveal
          </button>
        ) : null}
        <button type="button" className="btn" onClick={close}>
          Close
        </button>
        <button type="button" className="btn primary" disabled={busy} onClick={doExport}>
          <Icon name="upload" size={14} /> Export
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ help

const SHORTCUTS: [string, string][] = [
  ['W / E / R', 'Move / rotate / scale tool'],
  ['F', 'Frame the selection in the scene view'],
  ['Delete', 'Delete the selected entity'],
  ['Ctrl+D', 'Duplicate the selected entity'],
  ['F2', 'Rename the selected entity'],
  ['Ctrl+Z / Ctrl+Y', 'Undo / redo (a whole AI turn is one step)'],
  ['Ctrl+P', 'Play / stop'],
  ['Ctrl+S', 'Save the open script or model'],
  ['Left drag / right drag / wheel', 'Orbit / pan / zoom the scene camera'],
];

export function openShortcuts(): void {
  openModal((close) => (
    <div>
      <ModalHeader title="Keyboard shortcuts" icon="help" onClose={close} />
      <div className="modal-body">
        <table className="shortcut-table">
          <tbody>
            {SHORTCUTS.map(([k, v]) => (
              <tr key={k}>
                <td>
                  <span className="kbd">{k}</span>
                </td>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  ));
}

export function openAbout(): void {
  const info = editor.get().info;
  openModal((close) => (
    <div>
      <ModalHeader title="About AIGE" icon="info" onClose={close} />
      <div className="modal-body">
        <div>
          <strong>AIGE</strong> is an AI-native game engine and 3D modeler. Every edit, from this editor,
          Claude over MCP, or the in-editor agent, goes through one command bus with undo/redo.
        </div>
        <div className="muted">
          Local API: {info?.apiPort ? `127.0.0.1:${info.apiPort}` : 'not running'}. Run{' '}
          <span className="kbd">aige mcp</span> in Claude Code to attach to this editor and watch it build
          live.
        </div>
        <div className="muted">Workspace: {info?.workspaceDir}</div>
      </div>
    </div>
  ));
}

export async function revealProject(): Promise<void> {
  window.aige.revealInFolder('project.json');
}

export { host };
