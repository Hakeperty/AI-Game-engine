// Monaco, bundled locally (no CDN). The package entry registers every editor contribution (the bare
// editor.api misses services like the code-action widget) and lazy-loads language grammars.
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker';

const ts = monaco.typescript;

(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === 'typescript' || label === 'javascript') return new TsWorker();
    return new EditorWorker();
  },
};

// Types for 'aige' / 'aige/model' live in the engine; the host type-checks scripts on save
// (script_write) and reports diagnostics, so Monaco only validates syntax here.
ts.typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
ts.typescriptDefaults.setCompilerOptions({
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  allowNonTsExtensions: true,
  strict: true,
});

monaco.editor.defineTheme('aige-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '6b7280', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'c792ea' },
    { token: 'string', foreground: 'a5d6a7' },
    { token: 'number', foreground: 'f5b36b' },
    { token: 'type', foreground: '7fc8ff' },
  ],
  colors: {
    'editor.background': '#18191c',
    'editor.lineHighlightBackground': '#1f2126',
    'editorLineNumber.foreground': '#4a4e57',
    'editorLineNumber.activeForeground': '#9aa0aa',
    'editorGutter.background': '#18191c',
    'editor.selectionBackground': '#2d4a7a',
    'editorWidget.background': '#1f2024',
    'editorIndentGuide.background1': '#26282d',
    'scrollbarSlider.background': '#34373d88',
  },
});

export { monaco };

export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  message: string;
}

/** Parses 'scripts/x.ts:12:5 TS2339: message' and esbuild 'file:line:col: message' lines. */
export function parseDiagnostics(lines: string[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const raw of lines) {
    const m = raw.match(/^(.+?):(\d+):(\d+):?\s+(.*)$/s);
    if (m)
      out.push({
        file: m[1]!.replaceAll('\\', '/'),
        line: Number(m[2]),
        column: Number(m[3]),
        message: m[4]!,
      });
  }
  return out;
}

export function setMarkers(model: monaco.editor.ITextModel, path: string, diags: Diagnostic[]): void {
  const mine = diags.filter((d) => d.file === path || d.file.endsWith(`/${path}`) || path.endsWith(d.file));
  monaco.editor.setModelMarkers(
    model,
    'aige',
    mine.map((d) => ({
      startLineNumber: d.line,
      startColumn: d.column,
      endLineNumber: d.line,
      endColumn: model.getLineMaxColumn(Math.min(d.line, model.getLineCount())),
      message: d.message,
      severity: monaco.MarkerSeverity.Error,
    })),
  );
}
