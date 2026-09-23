import { AigeError, toErrorInfo } from '@aige/core';
import { compileUserModule, type ProjectHost } from '@aige/host';
import type { CompiledScript } from '../shared/protocol.ts';

/**
 * Compiles every project script (scripts/**\/*.ts) for Play mode. The virtual module 'aige' is read from
 * the global `__aigeRuntime`, which the renderer sets to the @aige/runtime scripting API.
 */
export async function compileProjectScripts(
  host: ProjectHost,
): Promise<{ scripts: CompiledScript[]; errors: { path: string; message: string }[] }> {
  const files = (await host.fs.list('scripts')).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));
  const scripts: CompiledScript[] = [];
  const errors: { path: string; message: string }[] = [];
  await Promise.all(
    files.map(async (path) => {
      try {
        const compiled = await compileUserModule({
          entry: host.fs.abs(path),
          root: host.fs.root,
          virtuals: { aige: '__aigeRuntime' },
        });
        scripts.push({ path, code: compiled.code });
      } catch (err) {
        errors.push({ path, message: toErrorInfo(err).message });
      }
    }),
  );
  scripts.sort((a, b) => a.path.localeCompare(b.path));
  return { scripts, errors };
}

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  glb: 'model/gltf-binary',
};

/** Reads a binary project file (textures, audio clips) as base64. Paths cannot escape the project. */
export async function readBinaryFile(
  host: ProjectHost,
  path: string,
): Promise<{ path: string; mime: string; base64: string }> {
  const bytes = await host.fs.readBinary(path);
  if (!bytes) throw new AigeError('NOT_FOUND', `File '${path}' not found.`);
  if (bytes.byteLength > 64 * 1024 * 1024)
    throw new AigeError('UNSUPPORTED', `File '${path}' is too large to preview.`);
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return {
    path,
    mime: MIME[ext] ?? 'application/octet-stream',
    base64: Buffer.from(bytes).toString('base64'),
  };
}
