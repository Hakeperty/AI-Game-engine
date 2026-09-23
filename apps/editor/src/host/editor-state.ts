import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { RecentProject } from '../shared/protocol.ts';

/** ~/.aige/editor-state.json: the last open project and the recent-projects list. */
export class EditorState {
  readonly file: string;
  lastProject: string | null = null;
  recent: RecentProject[] = [];

  constructor(file = process.env.AIGE_EDITOR_STATE ?? join(homedir(), '.aige', 'editor-state.json')) {
    this.file = resolve(file);
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8')) as { lastProject?: unknown; recent?: unknown };
      if (typeof data.lastProject === 'string') this.lastProject = data.lastProject;
      if (Array.isArray(data.recent)) {
        this.recent = data.recent.filter(
          (r): r is RecentProject => !!r && typeof r.path === 'string' && typeof r.name === 'string',
        );
      }
    } catch {
      // first run or unreadable state: start fresh
    }
  }

  /** Recent projects whose folder still contains a project.json. */
  existingRecent(): RecentProject[] {
    return this.recent.filter((r) => existsSync(join(r.path, 'project.json')));
  }

  opened(path: string, name: string): void {
    this.lastProject = path;
    const norm = (p: string) => resolve(p).toLowerCase();
    this.recent = [
      { path, name, openedAt: new Date().toISOString() },
      ...this.recent.filter((r) => norm(r.path) !== norm(path)),
    ].slice(0, 12);
    this.save();
  }

  forget(path: string): void {
    const norm = resolve(path).toLowerCase();
    this.recent = this.recent.filter((r) => resolve(r.path).toLowerCase() !== norm);
    if (this.lastProject && resolve(this.lastProject).toLowerCase() === norm) this.lastProject = null;
    this.save();
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(
        this.file,
        `${JSON.stringify({ lastProject: this.lastProject, recent: this.recent }, null, 2)}\n`,
      );
    } catch (err) {
      console.error(`could not save editor state: ${(err as Error).message}`);
    }
  }
}
