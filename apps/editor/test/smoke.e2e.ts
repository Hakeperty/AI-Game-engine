/**
 * Electron smoke test for the AIGE editor (not part of vitest).
 *
 *   npm run build -w @aige/editor
 *   node apps/editor/test/smoke.e2e.ts
 *
 * Launches the built app against a temporary project (isolated user data, workspace, lock file and
 * editor state), then checks: the hierarchy shows 'Main Camera'; a cube created through the UI
 * appears; Ctrl+Z removes it; an MCP-style client attached through the lock file creates an entity
 * that shows up live; Play mode starts and stops. Screenshots go to apps/editor/test-results/.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ProjectHost, RemoteHostClient, readLiveLock } from '@aige/host';
import electronPath from 'electron';
import { _electron, type ElectronApplication, type Page } from 'playwright-core';

const appDir = resolve(import.meta.dirname, '..');
const outDir = join(appDir, 'test-results');
mkdirSync(outDir, { recursive: true });

const tmp = mkdtempSync(join(tmpdir(), 'aige-editor-e2e-'));
const workspace = join(tmp, 'workspace');
const projectDir = join(workspace, 'smoke-game');
const lockFile = join(tmp, 'editor.json');

const step = (msg: string) => console.log(`- ${msg}`);
let failures = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}: ${(err as Error).message.split('\n')[0]}`);
  }
}

const row = (page: Page, name: string) =>
  page.locator(`[data-testid="hierarchy"] .tree-row[data-name="${name}"]`);

async function main(): Promise<void> {
  step(`creating a temporary project in ${projectDir}`);
  const created = await ProjectHost.create(
    projectDir,
    { name: 'smoke-game', template: 'basic' },
    { render: null },
  );
  await created.close();

  step('launching the editor');
  const app: ElectronApplication = await _electron.launch({
    executablePath: String(electronPath),
    args: [appDir],
    cwd: appDir,
    env: {
      ...process.env,
      AIGE_USER_DATA: join(tmp, 'user-data'),
      AIGE_WORKSPACE: workspace,
      AIGE_EDITOR_LOCK: lockFile,
      AIGE_EDITOR_STATE: join(tmp, 'editor-state.json'),
      AIGE_OPEN_PROJECT: projectDir,
      AIGE_ALLOW_MULTIPLE: '1',
      AIGE_NO_OCCLUSION: '1',
      AIGE_WINDOW_SIZE: '1600x960',
    },
    timeout: 60_000,
  });
  const logs: string[] = [];
  app.process().stdout?.on('data', (d) => logs.push(String(d)));
  app.process().stderr?.on('data', (d) => logs.push(String(d)));
  let client: RemoteHostClient | null = null;
  try {
    const page = await app.firstWindow();
    page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') logs.push(`console.error: ${m.text()}`);
    });
    await page.waitForLoadState('domcontentloaded');

    await check("hierarchy shows 'Main Camera'", async () => {
      await row(page, 'Main Camera').waitFor({ timeout: 45_000 });
    });
    // Let the viewport build the scene and fetch thumbnails before the first screenshot.
    await page.waitForTimeout(2500);
    await page.screenshot({ path: join(outDir, 'smoke-1-opened.png') });

    await check('create a cube from the hierarchy Create menu', async () => {
      await page.click('[data-testid="hierarchy-create"]');
      await page.locator('.menu .menu-item', { hasText: '3D Object' }).hover();
      await page.locator('.menu .menu-item', { hasText: /^Cube$/ }).click();
      await row(page, 'Cube').waitFor({ timeout: 10_000 });
      await page.locator('[data-testid="inspector"]').waitFor({ timeout: 5_000 });
    });
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(outDir, 'smoke-2-cube.png') });

    await check('Ctrl+Z removes the cube', async () => {
      await page.locator('[data-testid="viewport"] canvas').click({ position: { x: 20, y: 60 } });
      await page.keyboard.press('Control+Z');
      await row(page, 'Cube').waitFor({ state: 'detached', timeout: 10_000 });
    });

    await check('an MCP client attached via the lock file edits the scene live', async () => {
      const lock = readLiveLock(lockFile);
      if (!lock) throw new Error(`no live lock at ${lockFile}`);
      client = await RemoteHostClient.connect(lock);
      const res = await client.request<{ id?: string; __error?: { message: string } }>({
        type: 'call',
        name: 'entity_create',
        input: {
          name: 'Remote Crate',
          position: [2.5, 0.75, 0.5],
          scale: 1.5,
          components: [{ type: 'MeshRenderer', primitive: 'box', color: '#ff8a3d' }],
        },
        source: 'mcp',
      });
      if (res.__error) throw new Error(res.__error.message);
      await row(page, 'Remote Crate').waitFor({ timeout: 10_000 });
      await page
        .locator('[data-testid="mcp-indicator"]', { hasText: 'attached' })
        .waitFor({ timeout: 5_000 });
    });
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(outDir, 'smoke-3-remote.png') });

    await check('select an entity by clicking its hierarchy row', async () => {
      await row(page, 'Remote Crate').click();
      await page.locator('.insp-name').waitFor({ timeout: 5_000 });
      const name = await page.locator('.insp-name').inputValue();
      if (name !== 'Remote Crate') throw new Error(`inspector shows '${name}'`);
    });

    await check('play mode starts and stops', async () => {
      await page.click('[data-testid="play"]');
      await page.locator('.vp-badge.playing').waitFor({ timeout: 20_000 });
      await page.waitForTimeout(1500);
      await page.screenshot({ path: join(outDir, 'smoke-4-playing.png') });
      await page.click('[data-testid="play"]');
      await page.locator('.vp-badge.playing').waitFor({ state: 'detached', timeout: 10_000 });
    });

    await page.waitForTimeout(500);
    await page.screenshot({ path: join(outDir, 'smoke-5-final.png') });
  } finally {
    (client as RemoteHostClient | null)?.close();
    await app.close().catch(() => undefined);
    const interesting = logs.filter((l) => /error|fail|exception|pageerror/i.test(l));
    if (interesting.length) console.log(`\napp log (errors):\n${interesting.join('').slice(0, 6000)}`);
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  console.log(`\nscreenshots: ${outDir}`);
  if (failures) {
    console.log(`${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('all checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
