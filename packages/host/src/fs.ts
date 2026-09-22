import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AigeError, type BusFs } from '@aige/core';

/**
 * Project-rooted file access. Every path is project-relative with forward slashes; anything that
 * would escape the project root is rejected (the AI must never touch files outside its project).
 */
export class ProjectFs implements BusFs {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** Absolute path for a project-relative path; throws if it escapes the project. */
  abs(path: string): string {
    const norm = path.replaceAll('\\', '/').replace(/^\.\//, '');
    if (isAbsolute(norm) || /^[a-zA-Z]:/.test(norm)) {
      throw new AigeError('INVALID_INPUT', `Absolute paths are not allowed: '${path}'.`, {
        hint: "Use a project-relative path like 'scripts/player.ts'.",
      });
    }
    const full = resolve(this.root, norm);
    const rel = relative(this.root, full);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new AigeError('INVALID_INPUT', `Path '${path}' is outside the project.`);
    }
    return full;
  }

  rel(abs: string): string {
    return relative(this.root, abs).split(sep).join('/');
  }

  async read(path: string): Promise<string | null> {
    try {
      return await readFile(this.abs(path), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async readBinary(path: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.abs(path)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async write(path: string, content: string | Uint8Array): Promise<void> {
    const full = this.abs(path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }

  async remove(path: string): Promise<void> {
    await rm(this.abs(path), { force: true, recursive: false });
  }

  async exists(path: string): Promise<boolean> {
    try {
      await stat(this.abs(path));
      return true;
    } catch {
      return false;
    }
  }

  /** Lists files under a directory (recursively), skipping .aige, node_modules and dist. */
  async list(dir = '', opts: { recursive?: boolean; pattern?: RegExp } = {}): Promise<string[]> {
    const out: string[] = [];
    const walk = async (d: string) => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await readdir(this.abs(d || '.'), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = d ? `${d}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (['.aige', 'node_modules', 'dist', '.git'].includes(e.name)) continue;
          if (opts.recursive !== false) await walk(p);
        } else if (!opts.pattern || opts.pattern.test(p)) out.push(p);
      }
    };
    await walk(dir.replace(/\/$/, ''));
    return out.sort();
  }
}

export { join };
