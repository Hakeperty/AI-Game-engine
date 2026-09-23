import { useEffect } from 'react';
import { deleteSelected, duplicateSelected, focusSelection, redo, togglePlay, undo } from './actions.ts';
import { openProjectFolder } from './components/dialogs.tsx';
import { editor, select } from './store/editor.ts';
import { toast } from './ui/overlays.tsx';

/** True when keyboard input belongs to a text field or the code editor. */
export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  return !!el.closest('input, textarea, select, [contenteditable="true"], .monaco-editor');
}

/** Editor-wide keyboard shortcuts (Unity-like). */
export function useGlobalShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('.modal-backdrop, .menu-backdrop')) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      const s = editor.get();
      if (ctrl && key === 'o') {
        e.preventDefault();
        void openProjectFolder();
        return;
      }
      if (!s.root) return;
      if (ctrl && key === 'p') {
        e.preventDefault();
        void togglePlay();
        return;
      }
      if (isTyping(e.target)) return;
      if (ctrl && key === 's') {
        e.preventDefault();
        toast('Scenes are saved automatically after every change.', 'info');
        return;
      }
      if (s.play !== 'edit') return;
      if (ctrl && !e.shiftKey && key === 'z') {
        e.preventDefault();
        undo();
      } else if (ctrl && (key === 'y' || (e.shiftKey && key === 'z'))) {
        e.preventDefault();
        redo();
      } else if (ctrl && key === 'd') {
        e.preventDefault();
        void duplicateSelected();
      } else if (!ctrl && !e.altKey) {
        if (key === 'w') editor.set({ tool: 'translate' });
        else if (key === 'e') editor.set({ tool: 'rotate' });
        else if (key === 'r') editor.set({ tool: 'scale' });
        else if (key === 'f') focusSelection();
        else if (key === 'delete') void deleteSelected();
        else if (key === 'escape') select(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
