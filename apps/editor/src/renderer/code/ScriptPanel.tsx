import { useCallback, useEffect, useRef, useState } from 'react';
import { host } from '../host/client.ts';
import { call } from '../host/session.ts';
import type { PanelProps } from '../layout/Dock.tsx';
import { log, useEditor } from '../store/editor.ts';
import { Icon } from '../ui/Icon.tsx';
import { toast } from '../ui/overlays.tsx';
import { CodeEditor, type CodeEditorHandle } from './CodeEditor.tsx';
import { type Diagnostic, parseDiagnostics } from './monaco.ts';

/**
 * Hook shared by the script editor and the modeling workspace: loads a project text file, tracks dirty
 * state, reloads on external changes (e.g. Claude rewrote the file) when there are no local edits.
 */
export function useProjectFile(path: string) {
  const [saved, setSaved] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [missing, setMissing] = useState(false);
  const version = useEditor((s) => s.fileVersions[path] ?? 0);
  const dirtyRef = useRef(false);
  const textRef = useRef('');
  textRef.current = text;

  const load = useCallback(async () => {
    try {
      const r = await host.request<{ content: string | null }>({ type: 'editor.readText', path });
      if (r.content === null) {
        setMissing(true);
        return;
      }
      setMissing(false);
      setSaved(r.content);
      if (!dirtyRef.current || r.content === textRef.current) {
        setText(r.content);
        dirtyRef.current = false;
      }
    } catch (err) {
      log('error', `Could not open ${path}: ${(err as Error).message}`);
    }
  }, [path]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload when the file version changes
  useEffect(() => {
    void load();
  }, [load, version]);

  const dirty = saved !== null && text !== saved;
  dirtyRef.current = dirty;
  return {
    text,
    setText,
    saved,
    dirty,
    missing,
    markSaved: (t: string) => {
      setSaved(t);
      dirtyRef.current = false;
    },
    reload: load,
  };
}

export function ScriptPanel({ params, api }: PanelProps<{ path: string }>) {
  const path = params.path;
  const file = useProjectFile(path);
  const [diags, setDiags] = useState<Diagnostic[]>([]);
  const [status, setStatus] = useState<{ text: string; kind: 'ok' | 'err' | 'busy' } | null>(null);
  const editorHandle = useRef<CodeEditorHandle | null>(null);
  const name = path.split('/').pop() ?? path;

  useEffect(() => {
    api.setTitle(`${name}${file.dirty ? ' ●' : ''}`);
  }, [api, name, file.dirty]);

  const save = async () => {
    const source = editorHandle.current?.getValue() ?? file.text;
    setStatus({ text: 'Saving and type-checking...', kind: 'busy' });
    const isScript = path.startsWith('scripts/') && path.endsWith('.ts');
    if (isScript) {
      const r = await call<{ typeErrors: number; diagnostics: string[] }>('script_write', {
        name: path,
        source,
        typecheck: true,
      });
      if (r.ok) {
        file.markSaved(source);
        const d = parseDiagnostics(r.result.diagnostics);
        setDiags(d);
        setStatus(
          r.result.typeErrors
            ? { text: `Saved with ${r.result.typeErrors} type error(s)`, kind: 'err' }
            : { text: 'Saved. No type errors.', kind: 'ok' },
        );
      } else {
        const lines =
          (r.error.details as { errors?: string[] } | undefined)?.errors ?? r.error.message.split('\n');
        setDiags(parseDiagnostics(lines));
        setStatus({ text: `Not saved: ${r.error.message.split('\n')[0]}`, kind: 'err' });
      }
    } else {
      const r = await call('file_write', { path, content: source });
      if (r.ok) {
        file.markSaved(source);
        setStatus({ text: 'Saved.', kind: 'ok' });
        setDiags([]);
      } else {
        setStatus({ text: r.error.message, kind: 'err' });
        toast(r.error.message, 'error');
      }
    }
  };

  if (file.missing)
    return <div className="panel-empty">{path} does not exist (it may have been deleted).</div>;
  return (
    <div className="panel script-panel">
      <div className="panel-toolbar">
        <Icon name="script" size={14} />
        <span className="doc-path">{path}</span>
        {file.dirty ? <span className="dirty-dot" title="Unsaved changes" /> : null}
        <div className="toolbar-spacer" />
        <button
          type="button"
          className="btn small primary"
          onClick={() => void save()}
          disabled={status?.kind === 'busy'}
        >
          <Icon name="save" size={13} /> Save
          <span className="kbd">Ctrl+S</span>
        </button>
      </div>
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
        ) : (
          <div className="panel-empty">
            <span className="spinner" />
          </div>
        )}
      </div>
      <div className={`doc-status ${status?.kind ?? ''}`}>
        {status?.kind === 'busy' ? <span className="spinner" /> : null}
        <span>
          {status?.text ?? 'Scripts are type-checked against the engine API when saved (script_write).'}
        </span>
      </div>
      {diags.length ? (
        <div className="diag-list">
          {diags.map((d, i) => (
            <button
              type="button"
              // biome-ignore lint/suspicious/noArrayIndexKey: diagnostics can share a location
              key={`${d.line}:${d.column}:${i}`}
              className="diag"
              onClick={() => editorHandle.current?.revealLine(d.line, d.column)}
            >
              <Icon name="error" size={12} />
              <span className="mono">
                {d.file}:{d.line}:{d.column}
              </span>
              <span>{d.message}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
