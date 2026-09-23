import { host } from '../host/client.ts';
import { refreshInfo } from '../host/session.ts';
import { useEditor } from '../store/editor.ts';
import { Icon } from '../ui/Icon.tsx';
import { openNewProjectDialog, openProjectFolder, openProjectPath } from './dialogs.tsx';

function ago(iso: string): string {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(s)) return '';
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export function Welcome() {
  const info = useEditor((s) => s.info);
  const connected = useEditor((s) => s.connected);
  const recent = info?.recent ?? [];
  return (
    <div className="welcome">
      <div className="welcome-inner">
        <div className="welcome-hero">
          <div className="welcome-logo">AI</div>
          <div>
            <h1>AIGE</h1>
            <p>The AI-native game engine. Build games with Claude, a local model, or your own hands.</p>
          </div>
        </div>
        <div className="welcome-grid">
          <div className="welcome-actions">
            <button
              type="button"
              className="welcome-action"
              onClick={openNewProjectDialog}
              disabled={!connected}
              data-testid="welcome-new"
            >
              <Icon name="plus" size={20} />
              <div>
                <strong>New project</strong>
                <span>Start from a 3D basic scene or an empty one</span>
              </div>
            </button>
            <button
              type="button"
              className="welcome-action"
              onClick={() => void openProjectFolder()}
              disabled={!connected}
            >
              <Icon name="folderOpen" size={20} />
              <div>
                <strong>Open folder</strong>
                <span>Open an existing AIGE project</span>
              </div>
            </button>
            <div className="welcome-tip">
              <Icon name="plug" size={16} />
              <div>
                <strong>Build with Claude Code</strong>
                <span>
                  Run <span className="kbd">claude mcp add aige -- node apps/cli/bin/aige.mjs mcp</span>.
                  While the editor is open, Claude attaches to it and you watch the game being built live.
                </span>
              </div>
            </div>
          </div>
          <div className="welcome-recent">
            <div className="welcome-section-title">Recent projects</div>
            {recent.length === 0 ? (
              <div className="welcome-empty">
                {connected ? 'No recent projects yet.' : 'Starting the host...'}
              </div>
            ) : (
              recent.map((r) => (
                <div key={r.path} className="recent-row">
                  <button type="button" className="recent-item" onClick={() => void openProjectPath(r.path)}>
                    <Icon name="folder" size={18} />
                    <div className="recent-text">
                      <strong>{r.name}</strong>
                      <span>{r.path.replaceAll('\\', '/')}</span>
                    </div>
                    <span className="recent-time">{ago(r.openedAt)}</span>
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    title="Remove from list"
                    onClick={async () => {
                      await host.request({ type: 'editor.forgetRecent', path: r.path });
                      void refreshInfo();
                    }}
                  >
                    <Icon name="x" size={14} />
                  </button>
                </div>
              ))
            )}
            <div className="welcome-footer muted">
              Workspace: {info?.workspaceDir?.replaceAll('\\', '/') ?? '...'}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
