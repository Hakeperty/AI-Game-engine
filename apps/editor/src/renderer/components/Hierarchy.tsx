import type { Entity } from '@aige/core';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { createModelEntity, focusSelection } from '../actions.ts';
import { run } from '../host/session.ts';
import type { PanelProps } from '../layout/Dock.tsx';
import { isTyping } from '../shortcuts.ts';
import { activeScene, select, useEditor } from '../store/editor.ts';
import { Icon } from '../ui/Icon.tsx';
import { openMenu, openMenuAt } from '../ui/overlays.tsx';
import { ASSET_MIME } from '../viewport/ViewportPanel.tsx';
import { createMenuItems } from './TopBar.tsx';

const ENTITY_MIME = 'application/x-aige-entity';

export function entityIcon(e: Entity): string {
  const types = e.components.map((c) => c.type);
  if (types.includes('Camera')) return 'camera';
  if (types.includes('Light')) {
    const l = e.components.find((c) => c.type === 'Light');
    return l?.kind === 'directional' ? 'sun' : 'light';
  }
  if (types.includes('MeshRenderer')) {
    const mr = e.components.find((c) => c.type === 'MeshRenderer');
    return mr?.model ? 'model' : 'cube';
  }
  if (types.includes('UIText')) return 'file';
  if (types.includes('AudioSource')) return 'audio';
  if (types.includes('Script')) return 'script';
  return 'empty';
}

interface Row {
  e: Entity;
  depth: number;
  hasChildren: boolean;
}

function entityMenu(e: Entity, onRename: () => void) {
  return [
    { label: 'Rename', icon: 'file', shortcut: 'F2', onClick: onRename },
    { label: 'Duplicate', icon: 'copy', shortcut: 'Ctrl+D', onClick: () => void dup(e.id) },
    { label: 'Frame in Scene', icon: 'focus', shortcut: 'F', onClick: focusSelection },
    {
      label: e.active ? 'Deactivate' : 'Activate',
      icon: e.active ? 'eyeOff' : 'eye',
      onClick: () => void run('entity_update', { entity: e.id, active: !e.active }),
    },
    ...(e.parent
      ? [
          {
            label: 'Move to Root',
            icon: 'layout',
            onClick: () => void run('entity_update', { entity: e.id, parent: null }),
          },
        ]
      : []),
    { separator: true as const },
    { header: 'Create child' },
    ...createMenuItems(e.id),
    { separator: true as const },
    {
      label: 'Delete',
      icon: 'trash',
      shortcut: 'Del',
      danger: true,
      onClick: () => void run('entity_delete', { entity: e.id }),
    },
  ];
}

async function dup(id: string): Promise<void> {
  const res = await run<{ created: { id: string }[] }>('entity_duplicate', {
    entity: id,
    count: 1,
    offset: [0, 0, 0],
  });
  const nid = res?.created[0]?.id;
  if (nid) select(nid);
}

export function HierarchyPanel(_props: PanelProps) {
  const scene = useEditor(activeScene);
  const selection = useEditor((s) => s.selection);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const rows = useMemo<Row[]>(() => {
    if (!scene) return [];
    const byParent = new Map<string | null, Entity[]>();
    const ids = new Set(scene.entities.map((e) => e.id));
    for (const e of scene.entities) {
      const p = e.parent && ids.has(e.parent) ? e.parent : null;
      const list = byParent.get(p) ?? [];
      list.push(e);
      byParent.set(p, list);
    }
    const q = query.trim().toLowerCase();
    let visibleIds: Set<string> | null = null;
    if (q) {
      visibleIds = new Set();
      const byId = new Map(scene.entities.map((e) => [e.id, e]));
      for (const e of scene.entities) {
        const hit =
          e.name.toLowerCase().includes(q) ||
          e.tags.some((t) => t.toLowerCase().includes(q)) ||
          e.components.some((c) => c.type.toLowerCase().includes(q));
        if (!hit) continue;
        let cur: Entity | undefined = e;
        while (cur && !visibleIds.has(cur.id)) {
          visibleIds.add(cur.id);
          cur = cur.parent ? byId.get(cur.parent) : undefined;
        }
      }
    }
    const out: Row[] = [];
    const visit = (e: Entity, depth: number) => {
      if (visibleIds && !visibleIds.has(e.id)) return;
      const kids = byParent.get(e.id) ?? [];
      out.push({ e, depth, hasChildren: kids.length > 0 });
      if (!collapsed.has(e.id) || visibleIds) for (const k of kids) visit(k, depth + 1);
    };
    for (const e of byParent.get(null) ?? []) visit(e, 0);
    return out;
  }, [scene, collapsed, query]);

  // Reveal the selection (e.g. picked in the viewport): expand ancestors and scroll into view.
  useEffect(() => {
    if (!selection || !scene) return;
    const byId = new Map(scene.entities.map((e) => [e.id, e]));
    let cur = byId.get(selection);
    const toExpand: string[] = [];
    while (cur?.parent) {
      if (collapsed.has(cur.parent)) toExpand.push(cur.parent);
      cur = byId.get(cur.parent);
    }
    if (toExpand.length) {
      setCollapsed((c) => {
        const n = new Set(c);
        for (const id of toExpand) n.delete(id);
        return n;
      });
    }
    requestAnimationFrame(() => {
      listRef.current
        ?.querySelector(`[data-id="${CSS.escape(selection)}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    });
  }, [selection, scene, collapsed]);

  // F2 renames the selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F2' && !isTyping(e.target) && useEditor.getState().selection) {
        e.preventDefault();
        setRenaming(useEditor.getState().selection);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onDropOn = async (target: string | null, e: React.DragEvent) => {
    setDropTarget(null);
    const entityId = e.dataTransfer.getData(ENTITY_MIME);
    if (entityId) {
      e.preventDefault();
      if (entityId === target) return;
      await run('entity_update', { entity: entityId, parent: target });
      return;
    }
    const asset = e.dataTransfer.getData(ASSET_MIME);
    if (asset) {
      e.preventDefault();
      const a = JSON.parse(asset) as { kind: string; path: string };
      if (a.kind === 'model') await createModelEntity(a.path, target ? { parent: target } : {});
    }
  };

  return (
    <div className="panel hierarchy">
      <div className="panel-toolbar">
        <button
          type="button"
          className="icon-btn"
          title="Create"
          disabled={!scene}
          data-testid="hierarchy-create"
          onClick={(e) => openMenuAt(e.currentTarget, createMenuItems(null))}
        >
          <Icon name="plus" />
        </button>
        <div className="search">
          <Icon name="search" size={13} />
          <input placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} />
          {query ? (
            <button type="button" className="icon-btn small" onClick={() => setQuery('')}>
              <Icon name="x" size={12} />
            </button>
          ) : null}
        </div>
      </div>
      <div
        ref={listRef}
        className={`panel-body tree${dropTarget === '' ? ' drop-root' : ''}`}
        data-testid="hierarchy"
        role="tree"
        tabIndex={0}
        aria-label="Scene hierarchy"
        onClick={(e) => {
          if (e.target === e.currentTarget) select(null);
        }}
        onKeyDown={(e) => {
          if (isTyping(e.target) || !rows.length) return;
          const i = rows.findIndex((r) => r.e.id === selection);
          const cur = rows[i];
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const next =
              rows[Math.max(0, Math.min(rows.length - 1, i < 0 ? 0 : i + (e.key === 'ArrowDown' ? 1 : -1)))];
            if (next) select(next.e.id);
          } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && cur) {
            e.preventDefault();
            const expand = e.key === 'ArrowRight';
            if (cur.hasChildren && collapsed.has(cur.e.id) === expand) {
              setCollapsed((c) => {
                const n = new Set(c);
                if (expand) n.delete(cur.e.id);
                else n.add(cur.e.id);
                return n;
              });
            } else if (!expand && cur.e.parent) select(cur.e.parent);
          } else if (e.key === 'Enter' && cur) {
            e.preventDefault();
            setRenaming(cur.e.id);
          }
        }}
        onContextMenu={(e) => {
          if (e.target !== e.currentTarget) return;
          e.preventDefault();
          if (scene) openMenu(e.clientX, e.clientY, [{ header: 'Create' }, ...createMenuItems(null)]);
        }}
        onDragOver={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.dataTransfer.types.includes(ENTITY_MIME) || e.dataTransfer.types.includes(ASSET_MIME)) {
            e.preventDefault();
            setDropTarget('');
          }
        }}
        onDragLeave={(e) => {
          if (e.target === e.currentTarget) setDropTarget(null);
        }}
        onDrop={(e) => {
          if (e.target === e.currentTarget) void onDropOn(null, e);
        }}
      >
        {scene ? (
          <div className="tree-scene">
            <Icon name="scene" size={14} />
            <span>{scene.name}</span>
            <span className="tree-count">{scene.entities.length}</span>
          </div>
        ) : null}
        {rows.map((r) => (
          <TreeRow
            key={r.e.id}
            row={r}
            selected={r.e.id === selection}
            collapsed={collapsed.has(r.e.id)}
            renaming={renaming === r.e.id}
            dropTarget={dropTarget === r.e.id}
            onToggle={() =>
              setCollapsed((c) => {
                const n = new Set(c);
                if (n.has(r.e.id)) n.delete(r.e.id);
                else n.add(r.e.id);
                return n;
              })
            }
            onRename={(name) => {
              setRenaming(null);
              const next = name?.trim();
              if (next && next !== r.e.name) void run('entity_update', { entity: r.e.id, name: next });
            }}
            onStartRename={() => setRenaming(r.e.id)}
            onDragOverRow={(over) => setDropTarget(over ? r.e.id : null)}
            onDropRow={(ev) => void onDropOn(r.e.id, ev)}
          />
        ))}
        {scene && rows.length === 0 ? (
          <div className="panel-empty">{query ? 'No matches.' : 'Empty scene. Right-click to create.'}</div>
        ) : null}
      </div>
    </div>
  );
}

const TreeRow = memo(function TreeRow({
  row,
  selected,
  collapsed,
  renaming,
  dropTarget,
  onToggle,
  onRename,
  onStartRename,
  onDragOverRow,
  onDropRow,
}: {
  row: Row;
  selected: boolean;
  collapsed: boolean;
  renaming: boolean;
  dropTarget: boolean;
  onToggle: () => void;
  onRename: (name: string | null) => void;
  onStartRename: () => void;
  onDragOverRow: (over: boolean) => void;
  onDropRow: (e: React.DragEvent) => void;
}) {
  const { e, depth, hasChildren } = row;
  return (
    <div
      className={`tree-row${selected ? ' selected' : ''}${e.active ? '' : ' inactive'}${dropTarget ? ' drop' : ''}`}
      style={{ paddingLeft: 6 + depth * 14 }}
      role="treeitem"
      tabIndex={-1}
      aria-selected={selected}
      aria-level={depth + 1}
      {...(hasChildren ? { 'aria-expanded': !collapsed } : {})}
      data-id={e.id}
      data-name={e.name}
      draggable={!renaming}
      onDragStart={(ev) => {
        ev.dataTransfer.setData(ENTITY_MIME, e.id);
        ev.dataTransfer.effectAllowed = 'move';
      }}
      onDragOver={(ev) => {
        if (ev.dataTransfer.types.includes(ENTITY_MIME) || ev.dataTransfer.types.includes(ASSET_MIME)) {
          ev.preventDefault();
          ev.stopPropagation();
          onDragOverRow(true);
        }
      }}
      onDragLeave={() => onDragOverRow(false)}
      onDrop={(ev) => {
        ev.stopPropagation();
        onDropRow(ev);
      }}
      onMouseDown={(ev) => {
        if (ev.button === 0 || ev.button === 2) select(e.id);
      }}
      onDoubleClick={() => onStartRename()}
      onContextMenu={(ev) => {
        ev.preventDefault();
        select(e.id);
        openMenu(ev.clientX, ev.clientY, entityMenu(e, onStartRename));
      }}
    >
      <button
        type="button"
        className={`tree-caret${hasChildren ? '' : ' hidden'}`}
        onMouseDown={(ev) => ev.stopPropagation()}
        onClick={onToggle}
        tabIndex={-1}
      >
        <Icon name={collapsed ? 'chevronRight' : 'chevronDown'} size={12} />
      </button>
      <Icon name={entityIcon(e)} size={14} className="tree-icon" />
      {renaming ? (
        <input
          className="tree-rename"
          defaultValue={e.name}
          // biome-ignore lint/a11y/noAutofocus: inline rename
          autoFocus
          onFocus={(ev) => ev.target.select()}
          onBlur={(ev) => onRename(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur();
            if (ev.key === 'Escape') onRename(null);
            ev.stopPropagation();
          }}
          onMouseDown={(ev) => ev.stopPropagation()}
        />
      ) : (
        <span className="tree-name">{e.name}</span>
      )}
      {e.prefab ? <span className="tree-tag">prefab</span> : null}
      <button
        type="button"
        className="tree-eye"
        title={e.active ? 'Deactivate' : 'Activate'}
        onMouseDown={(ev) => ev.stopPropagation()}
        onClick={() => void run('entity_update', { entity: e.id, active: !e.active })}
        tabIndex={-1}
      >
        <Icon name={e.active ? 'eye' : 'eyeOff'} size={13} />
      </button>
    </div>
  );
});
