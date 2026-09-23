import { useEffect, useState } from 'react';
import {
  CREATE_LABELS,
  type CreateKind,
  createEntity,
  deleteSelected,
  duplicateSelected,
  focusSelection,
  redo,
  stopPlay,
  togglePause,
  togglePlay,
  undo,
} from '../actions.ts';
import { resetLayout, showPanel } from '../layout/workspace.ts';
import { activeScene, useEditor } from '../store/editor.ts';
import { Icon } from '../ui/Icon.tsx';
import { type MenuItem, openMenuAt } from '../ui/overlays.tsx';
import {
  openAbout,
  openExportDialog,
  openNewProjectDialog,
  openPlayTestDialog,
  openProjectFolder,
  openProjectPath,
  openShortcuts,
  revealProject,
  takeScreenshot,
} from './dialogs.tsx';

export function createMenuItems(parent?: string | null): MenuItem[] {
  const item = (kind: CreateKind, icon: string): MenuItem => ({
    label: CREATE_LABELS[kind],
    icon,
    onClick: () => void createEntity(kind, parent),
  });
  return [
    item('empty', 'empty'),
    {
      label: '3D Object',
      icon: 'cube',
      submenu: [
        item('box', 'cube'),
        item('sphere', 'sphere'),
        item('cylinder', 'model'),
        item('capsule', 'model'),
        item('cone', 'model'),
        item('plane', 'grid'),
        item('torus', 'target'),
      ],
    },
    {
      label: 'Light',
      icon: 'light',
      submenu: [
        item('directional-light', 'sun'),
        item('point-light', 'light'),
        item('spot-light', 'light'),
        item('hemisphere-light', 'globe'),
      ],
    },
    item('camera', 'camera'),
  ];
}

export function TitleBar() {
  const info = useEditor((s) => s.info);
  const root = useEditor((s) => s.root);
  const projectName = useEditor((s) => s.state?.project.name ?? null);
  const sceneName = useEditor((s) => activeScene(s)?.name ?? null);
  const history = useEditor((s) => s.history);
  const hasSelection = useEditor((s) => !!s.selection);

  const recent: MenuItem[] = (info?.recent ?? []).slice(0, 10).map((r) => ({
    label: r.name,
    icon: 'folder',
    onClick: () => void openProjectPath(r.path),
  }));

  const menus: Record<string, MenuItem[]> = {
    File: [
      { label: 'New Project...', icon: 'plus', onClick: openNewProjectDialog },
      {
        label: 'Open Project...',
        icon: 'folderOpen',
        shortcut: 'Ctrl+O',
        onClick: () => void openProjectFolder(),
      },
      {
        label: 'Open Recent',
        icon: 'refresh',
        submenu: recent.length ? recent : [{ label: 'No recent projects', disabled: true }],
      },
      { separator: true },
      { label: 'Screenshot', icon: 'camera', disabled: !root, onClick: takeScreenshot },
      { label: 'Headless Play-test...', icon: 'flask', disabled: !root, onClick: openPlayTestDialog },
      { label: 'Export Web Build...', icon: 'upload', disabled: !root, onClick: openExportDialog },
      { separator: true },
      {
        label: 'Reveal Project Folder',
        icon: 'folder',
        disabled: !root,
        onClick: () => void revealProject(),
      },
    ],
    Edit: [
      {
        label: history.undoLabel ? `Undo ${history.undoLabel}` : 'Undo',
        icon: 'undo',
        shortcut: 'Ctrl+Z',
        disabled: !history.canUndo,
        onClick: undo,
      },
      {
        label: history.redoLabel ? `Redo ${history.redoLabel}` : 'Redo',
        icon: 'redo',
        shortcut: 'Ctrl+Y',
        disabled: !history.canRedo,
        onClick: redo,
      },
      { separator: true },
      {
        label: 'Duplicate',
        icon: 'copy',
        shortcut: 'Ctrl+D',
        disabled: !hasSelection,
        onClick: () => void duplicateSelected(),
      },
      {
        label: 'Delete',
        icon: 'trash',
        shortcut: 'Del',
        disabled: !hasSelection,
        onClick: () => void deleteSelected(),
      },
      {
        label: 'Frame Selection',
        icon: 'focus',
        shortcut: 'F',
        disabled: !hasSelection,
        onClick: focusSelection,
      },
    ],
    GameObject: root ? createMenuItems(null) : [{ label: 'Open a project first', disabled: true }],
    View: [
      { label: 'Scene', icon: 'scene', onClick: () => showPanel('viewport') },
      { label: 'Hierarchy', icon: 'layout', onClick: () => showPanel('hierarchy') },
      { label: 'Inspector', icon: 'settings', onClick: () => showPanel('inspector') },
      { label: 'Project', icon: 'folder', onClick: () => showPanel('assets') },
      { label: 'Console', icon: 'terminal', onClick: () => showPanel('console') },
      { label: 'AI Assistant', icon: 'sparkle', onClick: () => showPanel('chat') },
      { separator: true },
      { label: 'Reset Layout', icon: 'layout', onClick: resetLayout },
      {
        label: 'Toggle Developer Tools',
        icon: 'code',
        shortcut: 'F12',
        onClick: () => window.aige.toggleDevTools(),
      },
    ],
    Help: [
      { label: 'Keyboard Shortcuts', icon: 'help', onClick: openShortcuts },
      { label: 'About AIGE', icon: 'info', onClick: openAbout },
    ],
  };

  return (
    <div className="titlebar">
      <div className="brand">
        <div className="brand-mark">AI</div>
        AIGE
      </div>
      {Object.entries(menus).map(([name, items]) => (
        <button
          key={name}
          type="button"
          className="menubar-item"
          data-menu={name}
          onMouseDown={(e) => {
            e.preventDefault();
            openMenuAt(e.currentTarget, items);
          }}
        >
          {name}
        </button>
      ))}
      <div className="title-center">
        {projectName ? (
          <>
            <span className="project-name">{projectName}</span>
            {sceneName ? <span>/ {sceneName}</span> : null}
          </>
        ) : (
          <span>AIGE Editor</span>
        )}
      </div>
      <McpIndicator />
    </div>
  );
}

function McpIndicator() {
  const clients = useEditor((s) => s.info?.mcpClients ?? 0);
  const port = useEditor((s) => s.info?.apiPort ?? null);
  const activity = useEditor((s) => s.mcpActivityAt);
  const [, force] = useState(0);
  const recent = Date.now() - activity < 2500;
  useEffect(() => {
    if (!recent) return;
    const t = setTimeout(() => force((n) => n + 1), 2600);
    return () => clearTimeout(t);
  }, [recent]);
  const title = port
    ? `Local API on 127.0.0.1:${port}. ${clients ? `${clients} MCP client(s) attached (Claude Code via "aige mcp").` : 'Run "aige mcp" in Claude Code to attach.'}`
    : 'Local API is not running';
  return (
    <div
      className={`status-pill no-drag${clients ? ' live' : ''}${recent ? ' pulse' : ''}`}
      title={title}
      data-testid="mcp-indicator"
    >
      <span className="dot" />
      <Icon name="plug" size={12} />
      {clients ? `MCP: ${clients} attached` : 'MCP: idle'}
    </div>
  );
}

export function Toolbar() {
  const tool = useEditor((s) => s.tool);
  const space = useEditor((s) => s.space);
  const snap = useEditor((s) => s.snap);
  const play = useEditor((s) => s.play);
  const history = useEditor((s) => s.history);
  const set = useEditor.setState;
  const editing = play === 'edit';
  return (
    <div className="toolbar">
      <div className="toolbar-group">
        {(
          [
            ['translate', 'move', 'Move (W)'],
            ['rotate', 'rotate', 'Rotate (E)'],
            ['scale', 'scale', 'Scale (R)'],
          ] as const
        ).map(([t, icon, title]) => (
          <button
            key={t}
            type="button"
            className={`tool-btn${tool === t ? ' active' : ''}`}
            title={title}
            disabled={!editing}
            onClick={() => set({ tool: t })}
          >
            <Icon name={icon} />
          </button>
        ))}
      </div>
      <div className="toolbar-group">
        <button
          type="button"
          className="tool-btn labeled"
          title="Toggle local / world space"
          disabled={!editing}
          onClick={() => set({ space: space === 'local' ? 'world' : 'local' })}
        >
          <Icon name={space === 'local' ? 'local' : 'globe'} size={14} />
          {space === 'local' ? 'Local' : 'World'}
        </button>
        <button
          type="button"
          className={`tool-btn${snap ? ' active' : ''}`}
          title="Snap (0.5 m, 15°, 0.1)"
          disabled={!editing}
          onClick={() => set({ snap: !snap })}
        >
          <Icon name="magnet" />
        </button>
      </div>
      <div className="toolbar-group">
        <button
          type="button"
          className="tool-btn"
          title={history.undoLabel ? `Undo ${history.undoLabel} (Ctrl+Z)` : 'Undo (Ctrl+Z)'}
          disabled={!history.canUndo || !editing}
          onClick={undo}
          data-testid="undo"
        >
          <Icon name="undo" />
        </button>
        <button
          type="button"
          className="tool-btn"
          title={history.redoLabel ? `Redo ${history.redoLabel} (Ctrl+Y)` : 'Redo (Ctrl+Y)'}
          disabled={!history.canRedo || !editing}
          onClick={redo}
        >
          <Icon name="redo" />
        </button>
      </div>
      <div className="toolbar-spacer" />
      <div className="toolbar-group play-group">
        <button
          type="button"
          className={`tool-btn play${play !== 'edit' ? ' active' : ''}`}
          title={play === 'edit' ? 'Play (Ctrl+P)' : 'Stop (Ctrl+P)'}
          onClick={() => void togglePlay()}
          data-testid="play"
        >
          <Icon name={play === 'edit' ? 'play' : 'stop'} size={14} />
        </button>
        <button
          type="button"
          className={`tool-btn${play === 'paused' ? ' active' : ''}`}
          title="Pause"
          disabled={play === 'edit'}
          onClick={togglePause}
        >
          <Icon name="pause" size={14} />
        </button>
        <button type="button" className="tool-btn" title="Stop" disabled={play === 'edit'} onClick={stopPlay}>
          <Icon name="stop" size={12} />
        </button>
      </div>
      <div className="toolbar-spacer" />
      <div className="toolbar-group">
        <button
          type="button"
          className="tool-btn labeled"
          title="Render a screenshot (render_screenshot)"
          onClick={takeScreenshot}
          data-testid="screenshot"
        >
          <Icon name="camera" size={14} />
          Screenshot
        </button>
        <button
          type="button"
          className="tool-btn labeled"
          title="Headless play-test (game_run_headless)"
          onClick={openPlayTestDialog}
        >
          <Icon name="flask" size={14} />
          Play-test
        </button>
        <button
          type="button"
          className="tool-btn labeled"
          title="Export a web build (export_web)"
          onClick={openExportDialog}
        >
          <Icon name="upload" size={14} />
          Export
        </button>
      </div>
    </div>
  );
}
