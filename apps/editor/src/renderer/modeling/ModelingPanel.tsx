import type { ImageRef } from '@aige/core';
import { useEffect, useRef, useState } from 'react';
import type { ModelInfoLite } from '../../shared/protocol.ts';
import { createModelEntity } from '../actions.ts';
import { CodeEditor, type CodeEditorHandle } from '../code/CodeEditor.tsx';
import { type Diagnostic, parseDiagnostics } from '../code/monaco.ts';
import { useProjectFile } from '../code/ScriptPanel.tsx';
import { HostError } from '../host/client.ts';
import { call } from '../host/session.ts';
import { ParamEditor } from '../inspector/Inspector.tsx';
import { labelOf } from '../inspector/schema.ts';
import type { PanelProps } from '../layout/Dock.tsx';
import { openModel } from '../layout/workspace.ts';
import { fetchModel, invalidateModels } from '../three/assets.ts';
import { Icon } from '../ui/Icon.tsx';
import { ModalHeader, openModal, toast } from '../ui/overlays.tsx';
import { ModelPreview, type ViewFlags } from './ModelPreview.ts';

interface CreateResult {
  model: string;
  size: number[];
  triangles: number;
  issues: string[];
  images?: ImageRef[];
  previewWarning?: string;
  logs?: string[];
}

export function ModelingPanel({ params, api }: PanelProps<{ path: string }>) {
  const path = params.path;
  const file = useProjectFile(path);
  const previewHost = useRef<HTMLDivElement>(null);
  const preview = useRef<ModelPreview | null>(null);
  const editorHandle = useRef<CodeEditorHandle | null>(null);
  const [info, setInfo] = useState<ModelInfoLite | null>(null);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [flags, setFlags] = useState<ViewFlags>({ wireframe: false, normals: false, flat: false });
  const [saveResult, setSaveResult] = useState<CreateResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [diags, setDiags] = useState<Diagnostic[]>([]);
  const [split, setSplit] = useState(0.5);
  const reqId = useRef(0);
  const name = (path.split('/').pop() ?? path).replace(/\.model\.ts$/, '');

  useEffect(() => {
    api.setTitle(`${name}${file.dirty ? ' ●' : ''}`);
  }, [api, name, file.dirty]);

  useEffect(() => {
    const el = previewHost.current;
    if (!el) return;
    const p = new ModelPreview(el);
    preview.current = p;
    const sub = api.onDidVisibilityChange((e) => p.setVisible(e.isVisible));
    return () => {
      sub.dispose();
      p.dispose();
      preview.current = null;
    };
  }, [api]);

  useEffect(() => preview.current?.setFlags(flags), [flags]);

  const rebuild = async (params: Record<string, unknown>) => {
    const id = ++reqId.current;
    setBuilding(true);
    try {
      const r = await fetchModel(path, params);
      if (id !== reqId.current) return;
      setInfo(r.info);
      setBuildError(null);
      await preview.current?.show(r.key);
    } catch (err) {
      if (id !== reqId.current) return;
      setBuildError(
        err instanceof HostError
          ? `${err.info.message}${err.info.hint ? `\n${err.info.hint}` : ''}`
          : String(err),
      );
    } finally {
      if (id === reqId.current) setBuilding(false);
    }
  };

  // Rebuild when the saved recipe changes (our save, or an external edit by the AI).
  // biome-ignore lint/correctness/useExhaustiveDependencies: rebuild on saved-source changes only
  useEffect(() => {
    if (file.saved !== null) void rebuild(values);
  }, [file.saved]);

  const liveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setParam = (key: string, v: unknown, final: boolean) => {
    const next = { ...values, [key]: v };
    setValues(next);
    if (liveTimer.current) clearTimeout(liveTimer.current);
    liveTimer.current = setTimeout(() => void rebuild(next), final ? 0 : 120);
  };

  const save = async () => {
    const source = editorHandle.current?.getValue() ?? file.text;
    setSaving(true);
    const direct = /^models\/[^/]+\.model\.ts$/.test(path);
    const r = direct
      ? await call<CreateResult>('model_create', {
          name,
          source,
          params: values,
          preview: true,
          views: ['iso', 'front', 'right', 'top'],
        })
      : await call('file_write', { path, content: source });
    setSaving(false);
    if (r.ok) {
      file.markSaved(source);
      setDiags([]);
      invalidateModels();
      if (direct) setSaveResult(r.result as CreateResult);
      toast(`Saved ${path}`, 'ok');
      void rebuild(values);
    } else {
      const lines =
        (r.error.details as { errors?: string[] } | undefined)?.errors ?? r.error.message.split('\n');
      setDiags(parseDiagnostics(lines));
      setBuildError(`${r.error.message}${r.error.hint ? `\n${r.error.hint}` : ''}`);
      toast('The recipe has errors; nothing was saved.', 'error');
    }
  };

  const paramDefs = info?.paramDefs ?? {};
  const size = info?.bounds.size;
  const img = saveResult?.images?.[0];
  // model_from_template writes a one-line re-export (or a withDefaults variant) of models/templates/<t>.model.ts.
  const templateRef = file.text.match(/from '\.\/templates\/([\w-]+)\.model\.ts'/)?.[1];

  if (file.missing) return <div className="panel-empty">{path} does not exist.</div>;
  return (
    <div className="panel modeling">
      <div className="panel-toolbar">
        <Icon name="model" size={14} />
        <span className="doc-path">{path}</span>
        {file.dirty ? (
          <span className="dirty-dot" title="Unsaved changes: save to rebuild the preview" />
        ) : null}
        <div className="toolbar-spacer" />
        <div className="toolbar-group">
          <button
            type="button"
            className={`tool-btn${flags.wireframe ? ' active' : ''}`}
            title="Wireframe"
            onClick={() => setFlags({ ...flags, wireframe: !flags.wireframe })}
          >
            <Icon name="wireframe" size={14} />
          </button>
          <button
            type="button"
            className={`tool-btn${flags.normals ? ' active' : ''}`}
            title="Normals (MeshNormalMaterial)"
            onClick={() => setFlags({ ...flags, normals: !flags.normals })}
          >
            <Icon name="normals" size={14} />
          </button>
          <button
            type="button"
            className={`tool-btn${flags.flat ? ' active' : ''}`}
            title="Flat shading"
            onClick={() => setFlags({ ...flags, flat: !flags.flat })}
          >
            <Icon name="flat" size={14} />
          </button>
          <button
            type="button"
            className="tool-btn"
            title="Reset camera"
            onClick={() => preview.current?.resetCamera()}
          >
            <Icon name="focus" size={14} />
          </button>
        </div>
        <button
          type="button"
          className="btn small"
          onClick={() => void createModelEntity(path)}
          title="Place this model in the scene"
        >
          <Icon name="plus" size={13} /> Add to Scene
        </button>
        <button type="button" className="btn small primary" onClick={() => void save()} disabled={saving}>
          {saving ? <span className="spinner" /> : <Icon name="save" size={13} />} Save
          <span className="kbd">Ctrl+S</span>
        </button>
      </div>
      {templateRef ? (
        <div className="doc-banner">
          <Icon name="info" size={13} />
          <span>
            This model is based on the <strong>{templateRef}</strong> template. Edit the template recipe to
            change its geometry, or tweak the parameters on the right.
          </span>
          <button
            type="button"
            className="btn small ghost"
            onClick={() => openModel(`models/templates/${templateRef}.model.ts`)}
          >
            Open template
          </button>
        </div>
      ) : null}
      <div className="modeling-body" style={{ gridTemplateColumns: `${split * 100}% 5px 1fr` }}>
        <div className="code-wrap">
          {file.saved !== null ? (
            <CodeEditor
              path={path}
              value={file.text}
              onChange={file.setText}
              onSave={() => void save()}
              diagnostics={diags}
              handle={(h) => {
                editorHandle.current = h;
              }}
            />
          ) : null}
        </div>
        <div
          className="splitter"
          onPointerDown={(e) => {
            const el = e.currentTarget;
            const parent = el.parentElement!;
            el.setPointerCapture(e.pointerId);
            const move = (ev: PointerEvent) => {
              const r = parent.getBoundingClientRect();
              setSplit(Math.min(0.75, Math.max(0.25, (ev.clientX - r.left) / r.width)));
            };
            const up = () => {
              el.removeEventListener('pointermove', move);
              el.removeEventListener('pointerup', up);
            };
            el.addEventListener('pointermove', move);
            el.addEventListener('pointerup', up);
          }}
        />
        <div className="modeling-side">
          <div className="preview-box">
            <div ref={previewHost} className="preview-host" />
            {building ? (
              <div className="preview-badge">
                <span className="spinner" /> Building...
              </div>
            ) : null}
            {buildError ? <pre className="preview-error">{buildError}</pre> : null}
          </div>
          <div className="modeling-info">
            <div className="stat-row">
              <div className="stat">
                <span>Triangles</span>
                <strong>{info ? info.triangles.toLocaleString() : '-'}</strong>
              </div>
              <div className="stat">
                <span>Size (m)</span>
                <strong>{size ? size.map((n) => n.toFixed(2)).join(' × ') : '-'}</strong>
              </div>
              <div className="stat">
                <span>Parts</span>
                <strong>{info ? info.parts.length : '-'}</strong>
              </div>
              <div className="stat">
                <span>Build</span>
                <strong>{info ? `${info.buildMs} ms` : '-'}</strong>
              </div>
            </div>
            {info?.issues.length ? (
              <div className="issues">
                {info.issues.map((i) => (
                  <div key={i} className="issue">
                    <Icon name="warning" size={12} /> {i}
                  </div>
                ))}
              </div>
            ) : info ? (
              <div className="issues ok">
                <Icon name="check" size={12} /> No mesh issues
              </div>
            ) : null}
            <div className="insp-subhead">Parameters</div>
            {Object.keys(paramDefs).length === 0 ? (
              <div className="insp-desc">This recipe has no parameters.</div>
            ) : null}
            {Object.entries(paramDefs).map(([k, d]) => (
              <div key={k} className="insp-row" title={d.description}>
                <span className="insp-label">{labelOf(k)}</span>
                <div className="insp-value">
                  <ParamEditor
                    def={d}
                    value={values[k] ?? d.default}
                    onChange={(v) => setParam(k, v, true)}
                    live={(v) => setParam(k, v, false)}
                  />
                </div>
              </div>
            ))}
            {Object.keys(values).length ? (
              <button
                type="button"
                className="btn small ghost"
                onClick={() => {
                  setValues({});
                  void rebuild({});
                }}
              >
                <Icon name="refresh" size={12} /> Reset parameters
              </button>
            ) : null}
            {img ? (
              <div className="save-preview">
                <div className="insp-subhead">Last save (model_create preview)</div>
                <button
                  type="button"
                  className="save-preview-img"
                  onClick={() =>
                    openModal(
                      (close) => (
                        <div>
                          <ModalHeader title={`${name} preview`} icon="image" onClose={close} />
                          <div className="modal-body">
                            <img
                              className="screenshot-img"
                              src={`data:${img.mimeType};base64,${img.data}`}
                              alt="Model preview"
                            />
                          </div>
                        </div>
                      ),
                      { wide: true },
                    )
                  }
                >
                  <img src={`data:${img.mimeType};base64,${img.data}`} alt="Model preview" />
                </button>
                {saveResult?.issues.length ? (
                  <div className="muted">{saveResult.issues.length} issue(s) reported.</div>
                ) : null}
                {saveResult?.previewWarning ? (
                  <div className="form-error">{saveResult.previewWarning}</div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
