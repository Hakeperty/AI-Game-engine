import { type ReactNode, useEffect, useRef, useState } from 'react';

export function fmtNum(v: number, precision = 3): string {
  if (!Number.isFinite(v)) return '0';
  const r = Number(v.toFixed(precision));
  return Object.is(r, -0) ? '0' : String(r);
}

/**
 * Number input with a draggable label (scrub like Unity). `onChange(v, false)` fires while scrubbing
 * (preview), `onChange(v, true)` when the edit is committed (Enter, blur, scrub end).
 */
export function NumberField({
  value,
  onChange,
  step = 0.1,
  min,
  max,
  int = false,
  precision = 3,
  label,
  labelClass,
  disabled,
  title,
}: {
  value: number;
  onChange: (v: number, final: boolean) => void;
  step?: number;
  min?: number;
  max?: number;
  int?: boolean;
  precision?: number;
  label?: ReactNode;
  labelClass?: string;
  disabled?: boolean;
  title?: string;
}) {
  const [text, setText] = useState<string | null>(null);
  const [scrub, setScrub] = useState<number | null>(null);
  const clamp = (v: number) => {
    let x = v;
    if (min !== undefined) x = Math.max(min, x);
    if (max !== undefined) x = Math.min(max, x);
    return int ? Math.round(x) : x;
  };
  const shown = scrub ?? value;
  const commitText = () => {
    if (text === null) return;
    const v = Number.parseFloat(text.replace(',', '.'));
    setText(null);
    if (Number.isFinite(v) && clamp(v) !== value) onChange(clamp(v), true);
  };
  const onLabelDown = (e: React.PointerEvent<HTMLSpanElement>) => {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const start = value;
    let cur = value;
    let moved = false;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (!moved && Math.abs(dx) < 2) return;
      moved = true;
      const mult = ev.shiftKey ? 0.1 : ev.ctrlKey ? 10 : 1;
      cur = clamp(start + dx * step * mult);
      setScrub(cur);
      onChange(cur, false);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      setScrub(null);
      if (moved && cur !== start) onChange(cur, true);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  return (
    <div className={`num-field${disabled ? ' disabled' : ''}`} title={title}>
      {label !== undefined ? (
        <span className={`num-label ${labelClass ?? ''}`} onPointerDown={onLabelDown}>
          {label}
        </span>
      ) : null}
      <input
        className="num-input"
        value={text ?? fmtNum(shown, int ? 0 : precision)}
        disabled={disabled}
        spellCheck={false}
        onFocus={(e) => {
          setText(fmtNum(value, int ? 0 : 6));
          requestAnimationFrame(() => e.target.select());
        }}
        onChange={(e) => setText(e.target.value)}
        onBlur={commitText}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          else if (e.key === 'Escape') {
            setText(null);
            requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const base = Number.parseFloat(text ?? String(value)) || 0;
            const v = clamp(base + (e.key === 'ArrowUp' ? 1 : -1) * (int ? 1 : step * 10));
            setText(fmtNum(v, int ? 0 : 6));
            onChange(v, true);
          }
        }}
      />
    </div>
  );
}

const AXES = ['X', 'Y', 'Z'] as const;

export function Vec3Field({
  value,
  onChange,
  step = 0.1,
  disabled,
}: {
  value: readonly number[];
  onChange: (v: [number, number, number], final: boolean) => void;
  step?: number;
  disabled?: boolean;
}) {
  return (
    <div className="vec3">
      {AXES.map((a, i) => (
        <NumberField
          key={a}
          label={a}
          labelClass={`axis-${a.toLowerCase()}`}
          value={value[i] ?? 0}
          step={step}
          {...(disabled ? { disabled } : {})}
          onChange={(v, final) => {
            const next = [value[0] ?? 0, value[1] ?? 0, value[2] ?? 0] as [number, number, number];
            next[i] = v;
            onChange(next, final);
          }}
        />
      ))}
    </div>
  );
}

export function Vec2Field({
  value,
  onChange,
  step = 1,
}: {
  value: readonly number[];
  onChange: (v: [number, number], final: boolean) => void;
  step?: number;
}) {
  return (
    <div className="vec3 vec2">
      {(['X', 'Y'] as const).map((a, i) => (
        <NumberField
          key={a}
          label={a}
          labelClass={`axis-${a.toLowerCase()}`}
          value={value[i] ?? 0}
          step={step}
          onChange={(v, final) => {
            const next = [value[0] ?? 0, value[1] ?? 0] as [number, number];
            next[i] = v;
            onChange(next, final);
          }}
        />
      ))}
    </div>
  );
}

/** Color swatch + hex text. Commits when the picker closes (native 'change') or on Enter. */
export function ColorField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [text, setText] = useState<string | null>(null);
  const [live, setLive] = useState<string | null>(null);
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onCommit = () => {
      setLive(null);
      cb.current(el.value);
    };
    el.addEventListener('change', onCommit);
    return () => el.removeEventListener('change', onCommit);
  }, []);
  const shown = live ?? value;
  return (
    <div className="color-field">
      <input
        ref={ref}
        type="color"
        className="color-swatch"
        value={shown}
        onInput={(e) => setLive((e.target as HTMLInputElement).value)}
      />
      <input
        className="input mono"
        value={text ?? shown}
        spellCheck={false}
        onFocus={() => setText(value)}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const t = (text ?? '').trim();
          setText(null);
          if (/^#?[0-9a-fA-F]{6}$/.test(t) || /^#?[0-9a-fA-F]{3}$/.test(t)) {
            const hex = t.startsWith('#') ? t : `#${t}`;
            if (hex.toLowerCase() !== value.toLowerCase()) onChange(hex.toLowerCase());
          }
        }}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
    </div>
  );
}

/** Text input that commits on blur / Enter and reverts on Escape. */
export function TextField({
  value,
  onCommit,
  placeholder,
  mono,
  list,
  className,
  disabled,
}: {
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  list?: string;
  className?: string;
  disabled?: boolean;
}) {
  const [text, setText] = useState<string | null>(null);
  return (
    <input
      className={`input${mono ? ' mono' : ''}${className ? ` ${className}` : ''}`}
      value={text ?? value}
      placeholder={placeholder}
      list={list}
      disabled={disabled}
      spellCheck={false}
      onFocus={() => setText(value)}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (text !== null && text !== value) onCommit(text);
        setText(null);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        else if (e.key === 'Escape') {
          setText(value);
          requestAnimationFrame(() => {
            setText(null);
            (e.target as HTMLInputElement).blur();
          });
        }
      }}
    />
  );
}

export function Toggle({
  checked,
  onChange,
  title,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      title={title}
      disabled={disabled}
      className={`toggle${checked ? ' on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle-knob" />
    </button>
  );
}

export function Checkbox({
  checked,
  onChange,
  title,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  title?: string;
}) {
  return (
    <input
      type="checkbox"
      className="checkbox"
      checked={checked}
      title={title}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

export function SelectField<T extends string>({
  value,
  options,
  onChange,
  placeholder,
  className,
}: {
  value: T | '' | undefined;
  options: readonly (T | { value: T; label: string; group?: string })[];
  onChange: (v: T) => void;
  placeholder?: string;
  className?: string;
}) {
  const norm = options.map((o) => (typeof o === 'string' ? { value: o, label: o, group: undefined } : o));
  const groups = [...new Set(norm.map((o) => o.group ?? ''))];
  return (
    <select
      className={`select${className ? ` ${className}` : ''}`}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value as T)}
    >
      {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
      {groups.length > 1
        ? groups.map((g) => (
            <optgroup key={g} label={g || 'Other'}>
              {norm
                .filter((o) => (o.group ?? '') === g)
                .map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
            </optgroup>
          ))
        : norm.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
    </select>
  );
}

/** Slider + number box for bounded numeric parameters. */
export function SliderField({
  value,
  min,
  max,
  step,
  onChange,
  int,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  int?: boolean;
  onChange: (v: number, final: boolean) => void;
}) {
  const s = step ?? (int ? 1 : (max - min) / 200);
  return (
    <div className="slider-field">
      <input
        type="range"
        className="slider"
        min={min}
        max={max}
        step={s}
        value={value}
        onChange={(e) => onChange(Number(e.target.value), false)}
        onPointerUp={(e) => onChange(Number((e.target as HTMLInputElement).value), true)}
        onKeyUp={(e) => onChange(Number((e.target as HTMLInputElement).value), true)}
      />
      <NumberField value={value} onChange={onChange} step={s} min={min} max={max} int={!!int} />
    </div>
  );
}
