import { useEffect, useMemo, useRef, useState } from 'react';
import type { PanelProps } from '../layout/Dock.tsx';
import { type ConsoleEntry, clearLogs, type LogLevel, useEditor } from '../store/editor.ts';
import { Icon } from '../ui/Icon.tsx';

const LEVEL_ICON: Record<LogLevel, string> = { debug: 'dots', info: 'info', warn: 'warning', error: 'error' };

function time(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

export function ConsolePanel(_props: PanelProps) {
  const logs = useEditor((s) => s.logs);
  const [levels, setLevels] = useState<Record<LogLevel, boolean>>({
    debug: false,
    info: true,
    warn: true,
    error: true,
  });
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<number | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const counts = useMemo(() => {
    const c: Record<LogLevel, number> = { debug: 0, info: 0, warn: 0, error: 0 };
    for (const l of logs) c[l.level] += l.count;
    return c;
  }, [logs]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return logs.filter(
      (l) => levels[l.level] && (!q || l.message.toLowerCase().includes(q) || l.source.includes(q)),
    );
  }, [logs, levels, query]);

  useEffect(() => {
    const el = bodyRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  return (
    <div className="panel console">
      <div className="panel-toolbar">
        <button type="button" className="btn small ghost" onClick={clearLogs} title="Clear">
          <Icon name="trash" size={13} /> Clear
        </button>
        <div className="toolbar-sep" />
        {(['error', 'warn', 'info', 'debug'] as const).map((l) => (
          <button
            key={l}
            type="button"
            className={`console-filter ${l}${levels[l] ? ' on' : ''}`}
            onClick={() => setLevels({ ...levels, [l]: !levels[l] })}
            title={`Show ${l}`}
          >
            <Icon name={LEVEL_ICON[l]} size={13} />
            {counts[l]}
          </button>
        ))}
        <div className="search" style={{ maxWidth: 260, marginLeft: 'auto' }}>
          <Icon name="search" size={13} />
          <input placeholder="Filter" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      </div>
      <div
        ref={bodyRef}
        className="panel-body console-body"
        data-testid="console"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {shown.length === 0 ? <div className="panel-empty">No messages.</div> : null}
        {shown.map((l) => (
          <ConsoleRow
            key={l.id}
            entry={l}
            expanded={expanded === l.id}
            onToggle={() => setExpanded(expanded === l.id ? null : l.id)}
          />
        ))}
      </div>
    </div>
  );
}

function ConsoleRow({
  entry: l,
  expanded,
  onToggle,
}: {
  entry: ConsoleEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: the row holds block content (hint, stack trace) that a <button> cannot contain
    <div
      className={`console-row ${l.level}`}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggle();
        }
      }}
    >
      <Icon name={LEVEL_ICON[l.level]} size={13} className="console-icon" />
      <span className="console-time">{time(l.time)}</span>
      <span className={`console-source src-${l.source}`}>{l.source}</span>
      <div className="console-msg">
        <div className={expanded ? 'console-text full' : 'console-text'}>{l.message}</div>
        {l.hint ? (
          <div className="console-hint">
            <Icon name="help" size={11} /> {l.hint}
          </div>
        ) : null}
        {expanded && l.detail ? <pre className="console-detail">{l.detail}</pre> : null}
      </div>
      {l.count > 1 ? <span className="console-count">{l.count}</span> : null}
    </div>
  );
}
