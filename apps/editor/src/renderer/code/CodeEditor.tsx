import { useEffect, useRef } from 'react';
import { type Diagnostic, monaco, setMarkers } from './monaco.ts';

export interface CodeEditorHandle {
  revealLine(line: number, column?: number): void;
  getValue(): string;
}

/** Thin Monaco wrapper: one model per file path; Ctrl+S calls onSave. */
export function CodeEditor({
  path,
  value,
  onChange,
  onSave,
  diagnostics,
  handle,
  language = 'typescript',
}: {
  path: string;
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  diagnostics: Diagnostic[];
  handle?: (h: CodeEditorHandle | null) => void;
  language?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<monaco.editor.ITextModel | null>(null);
  const cbs = useRef({ onChange, onSave });
  cbs.current = { onChange, onSave };
  const applying = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the editor is recreated only when the file changes
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const uri = monaco.Uri.parse(`file:///${path}`);
    const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(value, language, uri);
    modelRef.current = model;
    const editor = monaco.editor.create(el, {
      model,
      theme: 'aige-dark',
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      fontFamily: "'Cascadia Code', 'Cascadia Mono', Consolas, monospace",
      fontLigatures: true,
      scrollBeyondLastLine: false,
      tabSize: 2,
      renderLineHighlight: 'all',
      smoothScrolling: true,
      padding: { top: 8 },
      fixedOverflowWidgets: true,
    });
    editorRef.current = editor;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => cbs.current.onSave());
    const sub = model.onDidChangeContent(() => {
      if (!applying.current) cbs.current.onChange(model.getValue());
    });
    handle?.({
      revealLine: (line, column = 1) => {
        editor.revealLineInCenter(line);
        editor.setPosition({ lineNumber: line, column });
        editor.focus();
      },
      getValue: () => model.getValue(),
    });
    return () => {
      handle?.(null);
      sub.dispose();
      editor.dispose();
      model.dispose();
      editorRef.current = null;
      modelRef.current = null;
    };
  }, [path, language]);

  // External content (reload from disk) replaces the model text without an onChange echo.
  useEffect(() => {
    const model = modelRef.current;
    if (!model || model.getValue() === value) return;
    applying.current = true;
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: value }], () => null);
    applying.current = false;
  }, [value]);

  useEffect(() => {
    if (modelRef.current) setMarkers(modelRef.current, path, diagnostics);
  }, [diagnostics, path]);

  return <div ref={host} className="code-editor" />;
}
