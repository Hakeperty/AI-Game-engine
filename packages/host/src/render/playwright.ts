import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AigeError } from '@aige/core';
import type { SnapshotRequest, SnapshotResult } from '@aige/render';
import * as esbuild from 'esbuild';
import type { Browser, Page } from 'playwright-core';

export interface RenderBackend {
  readonly name: string;
  snapshot(req: SnapshotRequest): Promise<SnapshotResult>;
  info(): Promise<{ renderer: string; vendor: string; webgl2: boolean } | null>;
  close(): Promise<void>;
}

const RENDER_ENTRY = resolve(import.meta.dirname, '..', '..', '..', 'render', 'src', 'host-page.ts');

let bundlePromise: Promise<string> | null = null;

/** Bundles the render host page (three.js + @aige/render) into one script. Cached per process. */
export function renderPageBundle(): Promise<string> {
  bundlePromise ??= esbuild
    .build({
      entryPoints: [RENDER_ENTRY],
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      target: 'es2022',
      minify: true,
      logLevel: 'silent',
    })
    .then((r) => r.outputFiles[0]!.text);
  return bundlePromise;
}

/**
 * Launches headless Chromium with WebGL: the GPU first (ANGLE/D3D11 on Windows), then SwiftShader,
 * then the system Chrome/Edge. `probe` runs on a fresh page to confirm the setup works.
 */
export async function launchChromium(
  probe?: (page: Page) => Promise<void>,
): Promise<{ browser: Browser; page: Page; label: string }> {
  const { chromium } = await import('playwright-core');
  const attempts: { label: string; args: string[]; channel?: string }[] = [
    { label: 'gpu', args: gpuArgs() },
    {
      label: 'swiftshader',
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    },
    { label: 'chrome', args: gpuArgs(), channel: 'chrome' },
    { label: 'msedge', args: gpuArgs(), channel: 'msedge' },
  ];
  const errors: string[] = [];
  for (const a of attempts) {
    let browser: Browser | null = null;
    try {
      browser = await chromium.launch({
        headless: true,
        args: [...a.args, '--allow-file-access-from-files'],
        ...(a.channel ? { channel: a.channel } : {}),
      });
      const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
      if (probe) await probe(page);
      return { browser, page, label: a.label };
    } catch (err) {
      errors.push(`${a.label}: ${(err as Error).message.split('\n')[0]}`);
      await browser?.close().catch(() => undefined);
    }
  }
  throw new AigeError('RENDER_FAILED', `Could not start a headless browser. ${errors.join(' | ')}`, {
    hint: 'Install it with: npx playwright-core install chromium-headless-shell',
  });
}

/**
 * Headless Chromium renderer. Tries the GPU (ANGLE/D3D11 on Windows) first and falls back to
 * SwiftShader software rendering, so screenshots work on any machine (and in CI).
 */
export class PlaywrightBackend implements RenderBackend {
  readonly name = 'playwright';
  private browser: Browser | null = null;
  private starting: Promise<Page> | null = null;
  private gpu: { renderer: string; vendor: string; webgl2: boolean } | null = null;

  private async start(): Promise<Page> {
    this.starting ??= this.launch();
    return this.starting;
  }

  private async launch(): Promise<Page> {
    try {
      const { browser, page } = await launchChromium(async (page) => {
        await page.setContent(
          '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#000"></body></html>',
        );
        await page.addScriptTag({ content: await renderPageBundle() });
        await page.waitForFunction(() => (window as any).aige?.ready === true, undefined, {
          timeout: 15_000,
        });
        const info = (await page.evaluate(() => (window as any).aige.info())) as {
          renderer: string;
          vendor: string;
          webgl2: boolean;
        };
        if (!info.webgl2) throw new Error(`no WebGL2 (${info.renderer})`);
        this.gpu = info;
      });
      this.browser = browser;
      return page;
    } catch (err) {
      this.starting = null;
      throw err;
    }
  }

  async info() {
    await this.start();
    return this.gpu;
  }

  async snapshot(req: SnapshotRequest): Promise<SnapshotResult> {
    const page = await this.start();
    try {
      return (await page.evaluate((r) => (window as any).aige.snapshot(r), req)) as SnapshotResult;
    } catch (err) {
      throw new AigeError('RENDER_FAILED', `Render failed: ${(err as Error).message.split('\n')[0]}`);
    }
  }

  async close(): Promise<void> {
    const b = this.browser;
    this.browser = null;
    this.starting = null;
    await b?.close().catch(() => undefined);
  }
}

function gpuArgs(): string[] {
  const args = ['--ignore-gpu-blocklist', '--enable-gpu', '--enable-webgl'];
  if (process.platform === 'win32') args.push('--use-angle=d3d11');
  else if (process.platform === 'darwin') args.push('--use-angle=metal');
  else args.push('--use-angle=swiftshader', '--enable-unsafe-swiftshader');
  return args;
}

export function playwrightBrowsersInstalled(): boolean {
  const base =
    process.env.PLAYWRIGHT_BROWSERS_PATH ??
    join(process.env.LOCALAPPDATA ?? join(process.env.HOME ?? '', '.cache'), 'ms-playwright');
  return existsSync(base);
}
