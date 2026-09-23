import { useEffect, useRef, useState } from 'react';
import { createModelEntity, focusSelection, registerViewport } from '../actions.ts';
import type { PanelProps } from '../layout/Dock.tsx';
import { selectedEntity, useEditor } from '../store/editor.ts';
import { Icon } from '../ui/Icon.tsx';
import { EditorViewport, type ViewportStats } from './EditorViewport.ts';

export const ASSET_MIME = 'application/x-aige-asset';

let current: EditorViewport | null = null;
/** The live scene viewport (for inspector transform previews). */
export function sceneViewport(): EditorViewport | null {
  return current;
}

export function ViewportPanel({ api }: PanelProps) {
  const host = useRef<HTMLDivElement>(null);
  const vpRef = useRef<EditorViewport | null>(null);
  const [stats, setStats] = useState<ViewportStats | null>(null);
  const [dropHint, setDropHint] = useState(false);
  const selected = useEditor((s) => selectedEntity(s)?.name ?? null);
  const play = useEditor((s) => s.play);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const vp = new EditorViewport(el);
    vpRef.current = vp;
    current = vp;
    vp.onStats = setStats;
    registerViewport({
      focus: (id) => vp.focus(id ?? null),
      spawnPoint: () => vp.spawnPoint(),
      startPlay: () => vp.startPlay(),
      pausePlay: (p) => vp.pausePlay(p),
      stopPlay: () => vp.stopPlay(),
    });
    const sub = api.onDidVisibilityChange((e) => vp.setVisible(e.isVisible));
    vp.setVisible(api.isVisible);
    return () => {
      sub.dispose();
      if (current === vp) {
        current = null;
        registerViewport(null);
      }
      vp.dispose();
      vpRef.current = null;
    };
  }, [api]);

  return (
    <div
      className={`viewport${dropHint ? ' drop' : ''}`}
      role="application"
      aria-label="Scene view"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(ASSET_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setDropHint(true);
      }}
      onDragLeave={() => setDropHint(false)}
      onDrop={(e) => {
        setDropHint(false);
        const raw = e.dataTransfer.getData(ASSET_MIME);
        if (!raw) return;
        e.preventDefault();
        const asset = JSON.parse(raw) as { kind: string; path: string };
        if (asset.kind !== 'model') return;
        const p = vpRef.current?.pointAt(e.clientX, e.clientY);
        void createModelEntity(asset.path, p ? { position: p } : {});
      }}
    >
      <div ref={host} className="viewport-host" data-testid="viewport" />
      <div className="viewport-overlay top-left">
        <span className={`vp-badge${play !== 'edit' ? ' playing' : ''}`}>
          {play === 'edit' ? 'Scene' : play === 'paused' ? 'Paused' : 'Playing'}
          {stats?.scene ? <span className="muted"> · {stats.scene}</span> : null}
        </span>
        {selected && play === 'edit' ? <span className="vp-badge sel">{selected}</span> : null}
      </div>
      <div className="viewport-overlay top-right">
        {stats ? (
          <span className="vp-stats">
            {stats.fps} fps · {stats.triangles.toLocaleString()} tris · {stats.calls} draws
          </span>
        ) : null}
        {play === 'edit' ? (
          <button type="button" className="vp-btn" title="Frame selection (F)" onClick={focusSelection}>
            <Icon name="focus" size={14} />
          </button>
        ) : null}
      </div>
      {play !== 'edit' ? (
        <div className="viewport-overlay bottom-center play-hint">Esc releases the mouse · Ctrl+P stops</div>
      ) : null}
    </div>
  );
}
