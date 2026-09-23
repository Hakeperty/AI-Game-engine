import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { Icon } from './Icon.tsx';

// ------------------------------------------------------------------ menus (context + dropdown)

export type MenuItem =
  | {
      label: string;
      icon?: string;
      shortcut?: string;
      disabled?: boolean;
      danger?: boolean;
      checked?: boolean;
      onClick?: () => void;
      submenu?: MenuItem[];
    }
  | { separator: true }
  | { header: string };

interface MenuState {
  menu: { x: number; y: number; items: MenuItem[]; minWidth?: number } | null;
}

const useMenu = create<MenuState>(() => ({ menu: null }));

export function openMenu(x: number, y: number, items: MenuItem[], minWidth?: number): void {
  useMenu.setState({ menu: { x, y, items, ...(minWidth ? { minWidth } : {}) } });
}

export function openMenuAt(el: HTMLElement, items: MenuItem[]): void {
  const r = el.getBoundingClientRect();
  openMenu(r.left, r.bottom + 2, items, Math.max(180, r.width));
}

export function closeMenu(): void {
  useMenu.setState({ menu: null });
}

function MenuList({
  items,
  x,
  y,
  minWidth,
  depth,
}: {
  items: MenuItem[];
  x: number;
  y: number;
  minWidth?: number;
  depth: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [sub, setSub] = useState<{ index: number; x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let nx = x;
    let ny = y;
    if (nx + r.width > window.innerWidth - 4)
      nx = Math.max(4, depth > 0 ? x - r.width - 190 : window.innerWidth - r.width - 4);
    if (ny + r.height > window.innerHeight - 4) ny = Math.max(4, window.innerHeight - r.height - 4);
    setPos({ x: nx, y: ny });
  }, [x, y, depth]);
  return (
    <div
      ref={ref}
      className="menu"
      style={{ left: pos.x, top: pos.y, minWidth: minWidth ?? 190 }}
      role="menu"
    >
      {items.map((item, i) => {
        // Separators have no identity of their own; their position is their key.
        // biome-ignore lint/suspicious/noArrayIndexKey: static menu structure
        if ('separator' in item) return <hr key={`s${i}`} className="menu-sep" />;
        if ('header' in item)
          return (
            <div key={`h-${item.header}`} className="menu-header" role="presentation">
              {item.header}
            </div>
          );
        return (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            className={`menu-item${item.danger ? ' danger' : ''}${sub?.index === i ? ' open' : ''}`}
            disabled={item.disabled}
            onMouseEnter={(e) => {
              if (item.submenu) {
                const r = e.currentTarget.getBoundingClientRect();
                setSub({ index: i, x: r.right - 2, y: r.top - 4 });
              } else setSub(null);
            }}
            onClick={() => {
              if (item.submenu) return;
              closeMenu();
              item.onClick?.();
            }}
          >
            <span className="menu-icon">
              {item.checked ? (
                <Icon name="check" size={14} />
              ) : item.icon ? (
                <Icon name={item.icon} size={14} />
              ) : null}
            </span>
            <span className="menu-label">{item.label}</span>
            {item.shortcut ? <span className="menu-shortcut">{item.shortcut}</span> : null}
            {item.submenu ? <Icon name="chevronRight" size={12} className="menu-arrow" /> : null}
          </button>
        );
      })}
      {sub && (items[sub.index] as { submenu?: MenuItem[] }).submenu ? (
        <MenuList
          items={(items[sub.index] as { submenu: MenuItem[] }).submenu}
          x={sub.x}
          y={sub.y}
          depth={depth + 1}
        />
      ) : null}
    </div>
  );
}

export function MenuLayer() {
  const menu = useMenu((s) => s.menu);
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeMenu();
    const onBlur = () => closeMenu();
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onBlur);
    };
  }, [menu]);
  if (!menu) return null;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: clicking the backdrop dismisses the menu (Escape also works)
    <div
      className="menu-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeMenu();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        closeMenu();
      }}
    >
      <MenuList
        items={menu.items}
        x={menu.x}
        y={menu.y}
        depth={0}
        {...(menu.minWidth ? { minWidth: menu.minWidth } : {})}
      />
    </div>
  );
}

// ------------------------------------------------------------------ modals

interface ModalState {
  stack: { id: number; render: (close: () => void) => ReactNode; wide?: boolean }[];
}
const useModal = create<ModalState>(() => ({ stack: [] }));
let modalId = 1;

export function openModal(
  render: (close: () => void) => ReactNode,
  opts: { wide?: boolean } = {},
): () => void {
  const id = modalId++;
  const close = () => useModal.setState((s) => ({ stack: s.stack.filter((m) => m.id !== id) }));
  useModal.setState((s) => ({ stack: [...s.stack, { id, render, ...(opts.wide ? { wide: true } : {}) }] }));
  return close;
}

export function ModalLayer() {
  const stack = useModal((s) => s.stack);
  useEffect(() => {
    if (!stack.length) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const top = stack.at(-1);
      if (top) useModal.setState((s) => ({ stack: s.stack.filter((m) => m.id !== top.id) }));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stack]);
  return (
    <>
      {stack.map((m) => {
        const close = () => useModal.setState((s) => ({ stack: s.stack.filter((x) => x.id !== m.id) }));
        return (
          // biome-ignore lint/a11y/noStaticElementInteractions: clicking the backdrop dismisses the dialog (Escape also works)
          <div
            key={m.id}
            className="modal-backdrop"
            role="presentation"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) close();
            }}
          >
            <div className={`modal${m.wide ? ' wide' : ''}`} role="dialog">
              {m.render(close)}
            </div>
          </div>
        );
      })}
    </>
  );
}

export function ModalHeader({ title, onClose, icon }: { title: string; onClose: () => void; icon?: string }) {
  return (
    <div className="modal-header">
      {icon ? <Icon name={icon} /> : null}
      <span>{title}</span>
      <button type="button" className="icon-btn" onClick={onClose} title="Close">
        <Icon name="x" />
      </button>
    </div>
  );
}

/** Asks for a single line of text. Resolves null on cancel. */
export function promptText(opts: {
  title: string;
  label?: string;
  initial?: string;
  placeholder?: string;
  okLabel?: string;
  validate?: (v: string) => string | null;
}): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: string | null, close: () => void) => {
      if (done) return;
      done = true;
      close();
      resolve(v);
    };
    openModal((close) => <PromptBody opts={opts} onDone={(v) => finish(v, close)} />);
  });
}

function PromptBody({
  opts,
  onDone,
}: {
  opts: Parameters<typeof promptText>[0];
  onDone: (v: string | null) => void;
}) {
  const [value, setValue] = useState(opts.initial ?? '');
  const error = value && opts.validate ? opts.validate(value) : null;
  // Closing via Escape / backdrop unmounts the body: resolve as cancelled.
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  useEffect(() => () => doneRef.current(null), []);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!value.trim() || error) return;
        onDone(value.trim());
      }}
    >
      <ModalHeader title={opts.title} onClose={() => onDone(null)} />
      <div className="modal-body">
        {opts.label ? <div className="field-label">{opts.label}</div> : null}
        <input
          className="input"
          // biome-ignore lint/a11y/noAutofocus: modal prompt
          autoFocus
          value={value}
          placeholder={opts.placeholder}
          onChange={(e) => setValue(e.target.value)}
        />
        {error ? <div className="form-error">{error}</div> : null}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn" onClick={() => onDone(null)}>
          Cancel
        </button>
        <button type="submit" className="btn primary" disabled={!value.trim() || !!error}>
          {opts.okLabel ?? 'OK'}
        </button>
      </div>
    </form>
  );
}

interface ConfirmOptions {
  title: string;
  message: string;
  okLabel?: string;
  danger?: boolean;
}

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    openModal((close) => (
      <ConfirmBody
        opts={opts}
        onDone={(v) => {
          if (done) return;
          done = true;
          close();
          resolve(v);
        }}
      />
    ));
  });
}

function ConfirmBody({ opts, onDone }: { opts: ConfirmOptions; onDone: (v: boolean) => void }) {
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  useEffect(() => () => doneRef.current(false), []);
  return (
    <div>
      <ModalHeader title={opts.title} onClose={() => onDone(false)} />
      <div className="modal-body">{opts.message}</div>
      <div className="modal-footer">
        <button type="button" className="btn" onClick={() => onDone(false)}>
          Cancel
        </button>
        <button
          type="button"
          className={`btn ${opts.danger ? 'danger' : 'primary'}`}
          // biome-ignore lint/a11y/noAutofocus: default action of a confirm dialog
          autoFocus
          onClick={() => onDone(true)}
        >
          {opts.okLabel ?? 'OK'}
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ toasts

interface Toast {
  id: number;
  text: string;
  level: 'info' | 'ok' | 'error';
}
const useToasts = create<{ toasts: Toast[] }>(() => ({ toasts: [] }));
let toastId = 1;

export function toast(text: string, level: Toast['level'] = 'info', ms = 3200): void {
  const id = toastId++;
  useToasts.setState((s) => ({ toasts: [...s.toasts.slice(-4), { id, text, level }] }));
  setTimeout(() => useToasts.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms);
}

export function ToastLayer() {
  const toasts = useToasts((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.level}`}>
          <Icon name={t.level === 'error' ? 'error' : t.level === 'ok' ? 'check' : 'info'} size={14} />
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}
