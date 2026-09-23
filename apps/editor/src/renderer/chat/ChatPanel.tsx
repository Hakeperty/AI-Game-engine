import type { ToolImage } from '@aige/agent';
import { useEffect, useRef, useState } from 'react';
import type {
  AgentApprovalRequest,
  AgentMode,
  AgentProviderConfig,
  ApiKeyStatus,
} from '../../shared/protocol.ts';
import { undoAiTurn } from '../actions.ts';
import { HostError, host } from '../host/client.ts';
import type { PanelProps } from '../layout/Dock.tsx';
import { type ChatItem, pushLocalNotice, useChat } from '../store/chat.ts';
import { editor, useEditor } from '../store/editor.ts';
import { SelectField, Toggle } from '../ui/fields.tsx';
import { Icon } from '../ui/Icon.tsx';
import { ModalHeader, openModal, toast } from '../ui/overlays.tsx';
import { Markdown } from './Markdown.tsx';

const CLAUDE_MODELS = [
  { value: 'claude-opus-5', label: 'Claude Opus 5' },
  { value: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { value: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
  { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
];

interface ChatSettings {
  provider: 'anthropic' | 'openai-compat';
  anthropicModel: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  baseURL: string;
  localModel: string;
  mode: AgentMode;
}

const SETTINGS_KEY = 'aige.chat.settings.v1';
const DEFAULTS: ChatSettings = {
  provider: 'anthropic',
  anthropicModel: 'claude-opus-5',
  effort: 'high',
  baseURL: 'http://localhost:11434/v1',
  localModel: 'qwen3.8:27b',
  mode: 'ask-destructive',
};

function loadSettings(): ChatSettings {
  try {
    return {
      ...DEFAULTS,
      ...(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Partial<ChatSettings>),
    };
  } catch {
    return DEFAULTS;
  }
}

function providerConfig(s: ChatSettings): AgentProviderConfig {
  return s.provider === 'anthropic'
    ? { kind: 'anthropic', model: s.anthropicModel, effort: s.effort }
    : { kind: 'openai-compat', baseURL: s.baseURL, model: s.localModel };
}

export function ChatPanel(_props: PanelProps) {
  const [settings, setSettingsState] = useState<ChatSettings>(loadSettings);
  const [localModels, setLocalModels] = useState<string[] | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [keyStatus, setKeyStatus] = useState<ApiKeyStatus | null>(null);
  const [input, setInput] = useState('');
  const items = useChat((s) => s.items);
  const running = useChat((s) => s.running);
  const plan = useChat((s) => s.plan);
  const usage = useChat((s) => s.usage);
  const approvals = useChat((s) => s.approvals);
  const undoLabel = useEditor((s) => s.history.undoLabel ?? '');
  const hasProject = useEditor((s) => !!s.root);
  const bodyRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const setSettings = (patch: Partial<ChatSettings>) => {
    const next = { ...settings, ...patch };
    setSettingsState(next);
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    void window.aige.apiKeyStatus().then(setKeyStatus);
  }, []);

  useEffect(() => {
    if (settings.provider !== 'openai-compat') return;
    let alive = true;
    setLocalError(null);
    host
      .request<{ models: string[] }>({ type: 'editor.ollamaModels', baseURL: settings.baseURL })
      .then((r) => alive && setLocalModels(r.models))
      .catch((err) => {
        if (!alive) return;
        setLocalModels([]);
        setLocalError(err instanceof HostError ? err.info.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [settings.provider, settings.baseURL]);

  useEffect(() => {
    const el = bodyRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  const send = async () => {
    const text = input.trim();
    if (!text || running) return;
    if (settings.provider === 'anthropic' && keyStatus && !keyStatus.anthropic && !keyStatus.anthropicEnv) {
      openSettings();
      toast('Add your Anthropic API key first.', 'error');
      return;
    }
    setInput('');
    stick.current = true;
    try {
      await host.request({
        type: 'agent.run',
        request: {
          text,
          provider: providerConfig(settings),
          mode: settings.mode,
          selection: editor.get().selection,
        },
      });
    } catch (err) {
      const info = err instanceof HostError ? err.info : { message: String(err) };
      pushLocalNotice(`${info.message}${'hint' in info && info.hint ? ` ${info.hint}` : ''}`);
      useChat.setState({ running: false });
    }
  };

  const openSettings = () =>
    openModal((close) => (
      <ChatSettingsDialog
        close={close}
        settings={settings}
        onChange={setSettings}
        onKeyStatus={setKeyStatus}
        keyStatus={keyStatus}
      />
    ));

  const modelOptions =
    settings.provider === 'anthropic'
      ? CLAUDE_MODELS
      : [...new Set([settings.localModel, ...(localModels ?? [])])].map((m) => ({ value: m, label: m }));

  return (
    <div className="panel chat">
      <div className="panel-toolbar chat-toolbar">
        <div className="seg">
          <button
            type="button"
            className={settings.provider === 'anthropic' ? 'on' : ''}
            onClick={() => setSettings({ provider: 'anthropic' })}
          >
            Claude
          </button>
          <button
            type="button"
            className={settings.provider === 'openai-compat' ? 'on' : ''}
            onClick={() => setSettings({ provider: 'openai-compat' })}
          >
            Local
          </button>
        </div>
        <SelectField
          className="chat-model"
          value={settings.provider === 'anthropic' ? settings.anthropicModel : settings.localModel}
          options={modelOptions}
          onChange={(v) =>
            setSettings(settings.provider === 'anthropic' ? { anthropicModel: v } : { localModel: v })
          }
        />
        <button
          type="button"
          className="icon-btn"
          title="AI settings (API key, server, approvals)"
          onClick={openSettings}
        >
          <Icon name="settings" size={15} />
        </button>
        <button
          type="button"
          className="icon-btn"
          title="New chat"
          disabled={running}
          onClick={() =>
            void host.request({ type: 'agent.reset' }).catch((e) => toast(String(e.message ?? e), 'error'))
          }
        >
          <Icon name="plus" size={15} />
        </button>
      </div>
      {settings.provider === 'openai-compat' && localError ? (
        <div className="chat-warning">{localError}</div>
      ) : null}
      {plan.length ? <PlanView plan={plan} /> : null}
      <div
        ref={bodyRef}
        className="panel-body chat-body"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {items.length === 0 ? <ChatEmpty onPick={setInput} /> : null}
        {items.map((it) => (
          <ChatItemView key={it.id} item={it} />
        ))}
        {approvals.map((a) => (
          <ApprovalCard key={a.id} req={a} />
        ))}
        {running && !approvals.length ? (
          <div className="chat-working">
            <span className="spinner" /> Working...
          </div>
        ) : null}
      </div>
      <div className="chat-footer">
        <textarea
          className="chat-input"
          placeholder={
            hasProject
              ? 'Ask the AI to build something... (Enter to send, Shift+Enter for a new line)'
              : 'Open or create a project first'
          }
          value={input}
          rows={3}
          disabled={!hasProject}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="chat-actions">
          <span
            className="chat-meter"
            title={`Last turn: ${usage.lastInput.toLocaleString()} in / ${usage.lastOutput.toLocaleString()} out`}
          >
            {usage.sessionTokens ? `${(usage.sessionTokens / 1000).toFixed(1)}k tokens` : '0 tokens'} ·{' '}
            {usage.sessionCostUsd > 0
              ? `$${usage.sessionCostUsd.toFixed(usage.sessionCostUsd < 1 ? 3 : 2)}`
              : settings.provider === 'anthropic'
                ? '$0.00'
                : 'free'}
          </span>
          <button
            type="button"
            className="btn small ghost"
            disabled={running || !undoLabel.startsWith('AI:')}
            title={undoLabel.startsWith('AI:') ? `Undo "${undoLabel}"` : 'The last change was not an AI turn'}
            onClick={() => void undoAiTurn()}
          >
            <Icon name="undo" size={12} /> Undo AI turn
          </button>
          {running ? (
            <button
              type="button"
              className="btn small danger"
              onClick={() => void host.request({ type: 'agent.stop' })}
            >
              <Icon name="stop" size={11} /> Stop
            </button>
          ) : (
            <button
              type="button"
              className="btn small primary"
              disabled={!input.trim() || !hasProject}
              onClick={() => void send()}
            >
              <Icon name="send" size={12} /> Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ChatEmpty({ onPick }: { onPick: (s: string) => void }) {
  const ideas = [
    'Build a small 3D platformer where a blob collects 5 coins and reaches a flag.',
    'Add a row of 6 crates on the left side of the ground and make them fall with physics.',
    'Make the sun warmer and add soft fog.',
    'Create a stylized tree model and plant a small forest around the scene.',
  ];
  return (
    <div className="chat-empty">
      <div className="chat-empty-icon">
        <Icon name="sparkle" size={22} />
      </div>
      <div className="chat-empty-title">AI Assistant</div>
      <div className="chat-empty-sub">
        It edits the project with the same tools you use. Every request is one undo step.
      </div>
      <div className="chat-ideas">
        {ideas.map((i) => (
          <button type="button" key={i} className="chat-idea" onClick={() => onPick(i)}>
            {i}
          </button>
        ))}
      </div>
    </div>
  );
}

function PlanView({ plan }: { plan: { text: string; status: string }[] }) {
  const [open, setOpen] = useState(true);
  const done = plan.filter((p) => p.status === 'done').length;
  return (
    <div className="chat-plan">
      <button type="button" className="chat-plan-head" onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
        <span>Plan</span>
        <span className="muted">
          {done}/{plan.length}
        </span>
        <div className="plan-progress">
          <div style={{ width: `${(done / Math.max(1, plan.length)) * 100}%` }} />
        </div>
      </button>
      {open ? (
        <div className="chat-plan-items">
          {plan.map((p, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: plan steps may repeat text; order is their identity
            <div key={`${i}-${p.text}`} className={`plan-item ${p.status}`}>
              <span className="plan-check">
                {p.status === 'done' ? (
                  <Icon name="check" size={11} />
                ) : p.status === 'in_progress' ? (
                  <span className="spinner" />
                ) : null}
              </span>
              <span>{p.text}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function imageSrc(img: ToolImage): string {
  return `data:${img.mimeType};base64,${img.data}`;
}

function showImage(img: ToolImage): void {
  openModal(
    (close) => (
      <div>
        <ModalHeader title={img.label ?? 'Image'} icon="image" onClose={close} />
        <div className="modal-body">
          <img className="screenshot-img" src={imageSrc(img)} alt={img.label ?? ''} />
        </div>
      </div>
    ),
    { wide: true },
  );
}

function ChatItemView({ item }: { item: ChatItem }) {
  const [open, setOpen] = useState(false);
  switch (item.kind) {
    case 'user':
      return (
        <div className="msg user">
          <div className="msg-bubble">{item.text}</div>
        </div>
      );
    case 'assistant':
      return (
        <div className="msg assistant">
          {item.thinking ? (
            <details className="thinking">
              <summary>
                <Icon name="sparkle" size={11} /> Thinking
              </summary>
              <div>{item.thinking}</div>
            </details>
          ) : null}
          {item.text ? <Markdown text={item.text} /> : null}
          {item.streaming ? <span className="caret" /> : null}
        </div>
      );
    case 'tool': {
      const statusIcon =
        item.status === 'running'
          ? null
          : item.status === 'ok'
            ? 'check'
            : item.status === 'denied'
              ? 'lock'
              : 'error';
      return (
        <div className={`tool-card ${item.status}`}>
          <button type="button" className="tool-head" onClick={() => setOpen(!open)}>
            {item.status === 'running' ? (
              <span className="spinner" />
            ) : (
              <Icon name={statusIcon!} size={12} className="tool-status" />
            )}
            <span className="tool-name">{item.name}</span>
            <span className="tool-summary">
              {item.status === 'running' ? 'running...' : (item.error?.message ?? item.summary ?? '')}
            </span>
            {item.durationMs !== undefined ? (
              <span className="tool-ms">
                {item.durationMs < 1000
                  ? `${item.durationMs} ms`
                  : `${(item.durationMs / 1000).toFixed(1)} s`}
              </span>
            ) : null}
            <Icon name={open ? 'chevronDown' : 'chevronRight'} size={11} />
          </button>
          {item.images.length ? (
            <div className="tool-images">
              {item.images.map((img, i) =>
                img.data ? (
                  <button
                    type="button"
                    // biome-ignore lint/suspicious/noArrayIndexKey: images of one tool call never reorder
                    key={i}
                    className="tool-image"
                    onClick={() => showImage(img)}
                    title={img.label}
                  >
                    <img src={imageSrc(img)} alt={img.label ?? ''} />
                  </button>
                ) : null,
              )}
            </div>
          ) : null}
          {open ? (
            <div className="tool-body">
              <div className="tool-label">Arguments</div>
              <pre>{JSON.stringify(item.input, null, 2)}</pre>
              {item.summary && item.status !== 'error' ? (
                <>
                  <div className="tool-label">Result</div>
                  <pre>{item.summary}</pre>
                </>
              ) : null}
              {item.error ? (
                <>
                  <div className="tool-label">Error</div>
                  <pre className="err">
                    {item.error.code}: {item.error.message}
                    {item.error.hint ? `\nHint: ${item.error.hint}` : ''}
                  </pre>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      );
    }
    case 'notice':
      return (
        <div className={`chat-notice ${item.level}`}>
          <Icon name={item.level === 'error' ? 'error' : 'info'} size={12} /> {item.text}
        </div>
      );
    case 'done':
      return (
        <div className="chat-notice info">
          <Icon name="info" size={12} /> {item.message ?? `Stopped (${item.reason}).`}
        </div>
      );
  }
}

function ApprovalCard({ req }: { req: AgentApprovalRequest }) {
  const answer = (approved: boolean) =>
    void host.request({ type: 'agent.approve', requestId: req.id, approved });
  return (
    <div className="approval">
      <div className="approval-head">
        <Icon name="lock" size={13} />
        <span>
          Allow <strong>{req.name}</strong>?
        </span>
      </div>
      <div className="approval-reason">{req.reason}</div>
      <pre>{JSON.stringify(req.input, null, 2)}</pre>
      <div className="approval-actions">
        <button type="button" className="btn small" onClick={() => answer(false)}>
          Deny
        </button>
        <button type="button" className="btn small primary" onClick={() => answer(true)}>
          Allow
        </button>
      </div>
    </div>
  );
}

function ChatSettingsDialog({
  close,
  settings,
  onChange,
  keyStatus,
  onKeyStatus,
}: {
  close: () => void;
  settings: ChatSettings;
  onChange: (p: Partial<ChatSettings>) => void;
  keyStatus: ApiKeyStatus | null;
  onKeyStatus: (s: ApiKeyStatus) => void;
}) {
  const [key, setKey] = useState('');
  const [s, setS] = useState(settings);
  const [status, setStatus] = useState(keyStatus);
  const [busy, setBusy] = useState(false);
  const update = (p: Partial<ChatSettings>) => {
    setS({ ...s, ...p });
    onChange(p);
  };
  return (
    <div>
      <ModalHeader title="AI settings" icon="settings" onClose={close} />
      <div className="modal-body">
        <div className="field-label">Anthropic API key</div>
        <div className="key-row">
          <input
            className="input mono"
            type="password"
            placeholder={
              status?.anthropic ? 'A key is saved (encrypted). Paste a new one to replace it.' : 'sk-ant-...'
            }
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
          <button
            type="button"
            className="btn primary"
            disabled={!key.trim() || busy}
            onClick={async () => {
              setBusy(true);
              try {
                const st = await window.aige.setApiKey('anthropic', key.trim());
                setStatus(st);
                onKeyStatus(st);
                setKey('');
                toast('API key saved (encrypted with the OS keychain).', 'ok');
              } catch (err) {
                toast((err as Error).message, 'error');
              } finally {
                setBusy(false);
              }
            }}
          >
            Save
          </button>
          {status?.anthropic ? (
            <button
              type="button"
              className="btn"
              onClick={async () => {
                const st = await window.aige.clearApiKey('anthropic');
                setStatus(st);
                onKeyStatus(st);
              }}
            >
              Remove
            </button>
          ) : null}
        </div>
        <div className="muted" style={{ fontSize: 11 }}>
          {status?.anthropic
            ? 'Saved key in use. '
            : status?.anthropicEnv
              ? 'Using ANTHROPIC_API_KEY from the environment. '
              : 'No key yet. '}
          Keys are encrypted with Electron safeStorage and only passed to the host process, never to this
          window.
        </div>
        <div className="field-label" style={{ marginTop: 8 }}>
          Claude effort
        </div>
        <SelectField
          value={s.effort}
          options={['low', 'medium', 'high', 'xhigh', 'max'] as const}
          onChange={(v) => update({ effort: v })}
        />
        <div className="field-label" style={{ marginTop: 8 }}>
          Local server (Ollama / OpenAI-compatible)
        </div>
        <input
          className="input mono"
          value={s.baseURL}
          onChange={(e) => update({ baseURL: e.target.value })}
        />
        <div className="field-label" style={{ marginTop: 8 }}>
          Local model
        </div>
        <input
          className="input mono"
          value={s.localModel}
          onChange={(e) => update({ localModel: e.target.value })}
        />
        <div className="field-label" style={{ marginTop: 8 }}>
          Approvals
        </div>
        <div className="approval-mode">
          <Toggle
            checked={s.mode === 'ask-destructive'}
            onChange={(v) => update({ mode: v ? 'ask-destructive' : 'auto' })}
          />
          <span>Ask before the AI deletes, removes or undoes anything</span>
        </div>
        <div className="approval-mode">
          <Toggle
            checked={s.mode === 'read-only'}
            onChange={(v) => update({ mode: v ? 'read-only' : 'ask-destructive' })}
          />
          <span>Read-only (the AI can look but not change anything)</span>
        </div>
      </div>
      <div className="modal-footer">
        <button type="button" className="btn primary" onClick={close}>
          Done
        </button>
      </div>
    </div>
  );
}
