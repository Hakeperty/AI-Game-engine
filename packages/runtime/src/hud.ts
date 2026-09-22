import type { GameOver, HudEntry, UIAnchor } from './types.ts';

const ANCHOR_CSS: Record<UIAnchor, (x: number, y: number) => Partial<CSSStyleDeclaration>> = {
  'top-left': (x, y) => ({ left: `${x}px`, top: `${y}px`, transform: '' }),
  top: (x, y) => ({
    left: `calc(50% + ${x}px)`,
    top: `${y}px`,
    transform: 'translateX(-50%)',
    textAlign: 'center',
  }),
  'top-right': (x, y) => ({ right: `${x}px`, top: `${y}px`, transform: '', textAlign: 'right' }),
  left: (x, y) => ({ left: `${x}px`, top: `calc(50% + ${y}px)`, transform: 'translateY(-50%)' }),
  center: (x, y) => ({
    left: `calc(50% + ${x}px)`,
    top: `calc(50% + ${y}px)`,
    transform: 'translate(-50%, -50%)',
    textAlign: 'center',
  }),
  right: (x, y) => ({
    right: `${x}px`,
    top: `calc(50% + ${y}px)`,
    transform: 'translateY(-50%)',
    textAlign: 'right',
  }),
  'bottom-left': (x, y) => ({ left: `${x}px`, bottom: `${y}px`, transform: '' }),
  bottom: (x, y) => ({
    left: `calc(50% + ${x}px)`,
    bottom: `${y}px`,
    transform: 'translateX(-50%)',
    textAlign: 'center',
  }),
  'bottom-right': (x, y) => ({ right: `${x}px`, bottom: `${y}px`, transform: '', textAlign: 'right' }),
};

/**
 * Renders `world.hud` as an absolutely positioned DOM overlay (browser only). Call `update(world.hud,
 * world.gameOver)` every frame; only changed elements are touched.
 */
export class DomHud {
  readonly root: HTMLDivElement;
  private readonly items = new Map<string, { el: HTMLDivElement; key: string }>();
  private banner: HTMLDivElement | null = null;
  private bannerKey = '';

  constructor(container: HTMLElement) {
    const root = document.createElement('div');
    root.className = 'aige-hud';
    Object.assign(root.style, {
      position: 'absolute',
      inset: '0',
      pointerEvents: 'none',
      overflow: 'hidden',
      fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
      fontWeight: '700',
      userSelect: 'none',
    } satisfies Partial<CSSStyleDeclaration>);
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    container.appendChild(root);
    this.root = root;
  }

  update(hud: Record<string, HudEntry>, over: GameOver | null = null): void {
    for (const [id, h] of Object.entries(hud)) {
      let item = this.items.get(id);
      if (!item) {
        const el = document.createElement('div');
        el.dataset.hudId = id;
        Object.assign(el.style, {
          position: 'absolute',
          whiteSpace: 'pre',
          textShadow: '0 2px 4px rgba(0,0,0,0.6), 0 0 2px rgba(0,0,0,0.8)',
          lineHeight: '1.2',
        } satisfies Partial<CSSStyleDeclaration>);
        this.root.appendChild(el);
        item = { el, key: '' };
        this.items.set(id, item);
      }
      const key = JSON.stringify(h);
      if (key === item.key) continue;
      item.key = key;
      const el = item.el;
      el.textContent = h.text;
      el.style.display = h.visible ? '' : 'none';
      el.style.color = h.color;
      el.style.fontSize = `${h.fontSize}px`;
      el.style.left = el.style.right = el.style.top = el.style.bottom = '';
      el.style.textAlign = 'left';
      Object.assign(el.style, (ANCHOR_CSS[h.anchor] ?? ANCHOR_CSS['top-left'])(h.offset[0], h.offset[1]));
    }
    for (const [id, item] of this.items) {
      if (!(id in hud)) {
        item.el.remove();
        this.items.delete(id);
      }
    }
    const bannerKey = over ? `${over.result}:${over.message}` : '';
    if (bannerKey !== this.bannerKey) {
      this.bannerKey = bannerKey;
      this.banner?.remove();
      this.banner = null;
      if (over) {
        const b = document.createElement('div');
        Object.assign(b.style, {
          position: 'absolute',
          left: '50%',
          top: '40%',
          transform: 'translate(-50%, -50%)',
          fontSize: '56px',
          color: over.result === 'win' ? '#ffe066' : '#ff6b6b',
          textShadow: '0 4px 12px rgba(0,0,0,0.7)',
          textAlign: 'center',
          whiteSpace: 'pre',
        } satisfies Partial<CSSStyleDeclaration>);
        b.textContent = over.message || (over.result === 'win' ? 'You win!' : 'Game over');
        this.root.appendChild(b);
        this.banner = b;
      }
    }
  }

  dispose(): void {
    this.root.remove();
    this.items.clear();
  }
}
