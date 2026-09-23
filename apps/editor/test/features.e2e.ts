/**
 * Extended Electron feature test for the AIGE editor (slower than smoke.e2e.ts; not part of vitest).
 *
 *   npm run build -w @aige/editor
 *   node apps/editor/test/features.e2e.ts
 *   AIGE_E2E_OLLAMA_MODEL=qwen3-vl:4b node apps/editor/test/features.e2e.ts   # also runs the in-editor agent
 *
 * Covers: inspector edits, F2 rename, drag-to-reparent, render_screenshot, script diagnostics
 * (script_write), Play mode with a project script + a built-in, headless play-test, web export,
 * model_create from the modeling workspace, dragging a model into the viewport and (optionally)
 * one agent turn with a local Ollama model followed by "Undo AI turn".
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ProjectHost, RemoteHostClient, readLiveLock } from '@aige/host';
import electronPath from 'electron';
import { _electron, type Page } from 'playwright-core';

const appDir = resolve(import.meta.dirname, '..');
const outDir = join(appDir, 'test-results');
mkdirSync(outDir, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), 'aige-editor-features-'));
const projectDir = join(tmp, 'workspace', 'features');
const lockFile = join(tmp, 'editor.json');
const ollamaModel = process.env.AIGE_E2E_OLLAMA_MODEL;

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
function expect(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

async function setupProject(): Promise<void> {
  const h = await ProjectHost.create(projectDir, { name: 'features' }, { render: null });
  const call = async (name: string, input: unknown) => {
    const r = await h.call(name, input, 'test');
    if (!r.ok) throw new Error(`setup ${name}: ${r.error.message}`);
  };
  await call('model_from_template', { template: 'coin', preview: false });
  await call('model_from_template', { template: 'crate', preview: false });
  await call('script_write', {
    name: 'bobber',
    typecheck: false,
    source:
      "import { Behaviour, Debug } from 'aige';\nexport default class Bobber extends Behaviour {\n  static props = { height: 0.5, speed: 3 };\n  private t = 0;\n  start() { Debug.log('bobber started on ' + this.entity.name); }\n  update(dt: number) {\n    this.t += dt;\n    this.entity.position.y = 1.5 + Math.sin(this.t * this.props.speed) * this.props.height;\n  }\n}\n",
  });
  await call('entity_create', {
    name: 'Coin',
    position: [0, 1.5, 0],
    components: [
      { type: 'MeshRenderer', model: 'models/coin.model.ts' },
      { type: 'Script', script: 'scripts/bobber.ts' },
      { type: 'Script', script: 'builtin:Rotator', props: { speed: [0, 180, 0] } },
    ],
  });
  await call('entity_create', {
    name: 'Crate',
    position: [1, 0.5, 0],
    components: [{ type: 'MeshRenderer', model: 'models/crate.model.ts' }],
  });
  await call('entity_create', {
    name: 'Lamp',
    position: [0, 3, 2],
    components: [{ type: 'Light', kind: 'point', intensity: 1 }],
  });
  await h.close();
}

const row = (page: Page, name: string) =>
  page.locator(`[data-testid="hierarchy"] .tree-row[data-name="${name}"]`);
const tab = (page: Page, title: string) => page.locator('.dv-tab', { hasText: title });

async function main(): Promise<void> {
  await setupProject();
  const app = await _electron.launch({
    executablePath: String(electronPath),
    args: [appDir],
    cwd: appDir,
    env: {
      ...process.env,
      AIGE_USER_DATA: join(tmp, 'user-data'),
      AIGE_WORKSPACE: join(tmp, 'workspace'),
      AIGE_EDITOR_LOCK: lockFile,
      AIGE_EDITOR_STATE: join(tmp, 'editor-state.json'),
      AIGE_OPEN_PROJECT: projectDir,
      AIGE_ALLOW_MULTIPLE: '1',
      AIGE_NO_OCCLUSION: '1',
      AIGE_WINDOW_SIZE: '1600x960',
    },
    timeout: 60_000,
  });
  const pageErrors: string[] = [];
  let client: RemoteHostClient | null = null;
  try {
    const page = await app.firstWindow();
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await row(page, 'Coin').waitFor({ timeout: 45_000 });
    const lock = readLiveLock(lockFile);
    if (!lock) throw new Error('no live editor lock');
    const c = await RemoteHostClient.connect(lock);
    client = c;
    const get = (ref: string) => c.request<any>({ type: 'call', name: 'entity_get', input: { entity: ref } });

    await check('inspector transform edit calls entity_update', async () => {
      await row(page, 'Crate').click();
      const x = page.locator('.insp-section', { hasText: 'Transform' }).locator('.num-input').first();
      await x.click();
      await x.fill('3');
      await x.press('Enter');
      await page.waitForTimeout(500);
      const e = await get('Crate');
      expect(e.transform.position[0] === 3, `position is ${JSON.stringify(e.transform.position)}`);
    });

    await check('F2 renames the selected entity', async () => {
      await row(page, 'Crate').click();
      await page.keyboard.press('F2');
      await page.locator('.tree-rename').fill('Big Crate');
      await page.keyboard.press('Enter');
      await row(page, 'Big Crate').waitFor({ timeout: 5_000 });
    });

    await check('drag in the hierarchy reparents (world position kept)', async () => {
      await row(page, 'Lamp').dragTo(row(page, 'Big Crate'));
      await page.waitForTimeout(600);
      const lamp = await get('Lamp');
      const crate = await get('Big Crate');
      expect(lamp.parent === crate.id, `parent is ${lamp.parent}`);
      expect(Math.abs(lamp.worldPosition[1] - 3) < 1e-6, `world y is ${lamp.worldPosition[1]}`);
    });

    await check('Screenshot button shows the render_screenshot image', async () => {
      await page.click('[data-testid="screenshot"]');
      await page.locator('.modal img.screenshot-img').waitFor({ timeout: 90_000 });
      await page.screenshot({ path: join(outDir, 'features-screenshot.png') });
      await page.keyboard.press('Escape');
    });

    await check('script editor shows script_write diagnostics', async () => {
      await tab(page, 'Project').click();
      await page.locator('.asset-tile', { hasText: /^bobber$/ }).dblclick();
      await page.locator('.monaco-editor .view-lines').first().waitFor({ timeout: 20_000 });
      await page.waitForTimeout(500);
      await page.locator('.monaco-editor .view-lines').first().click();
      await page.keyboard.press('Control+End');
      await page.keyboard.type('\nconst broken = ;\n');
      await page.keyboard.press('Control+S');
      await page.locator('.diag').first().waitFor({ timeout: 60_000 });
      await page.screenshot({ path: join(outDir, 'features-script.png') });
      await tab(page, 'Scene').click();
    });

    await check('Play mode runs project + built-in scripts on a copy of the scene', async () => {
      await page.click('[data-testid="play"]');
      await page.locator('.vp-badge.playing').waitFor({ timeout: 20_000 });
      await page.waitForTimeout(2000);
      await page.screenshot({ path: join(outDir, 'features-play.png') });
      await page.click('[data-testid="play"]');
      await page.locator('.vp-badge.playing').waitFor({ state: 'detached', timeout: 10_000 });
      await tab(page, 'Console').click();
      const text = await page.locator('[data-testid="console"]').innerText();
      expect(text.includes('bobber started on Coin'), 'Debug.log from the project script is missing');
      expect((await page.locator('.console-row.error').count()) === 0, 'runtime errors in the console');
      const coin = await get('Coin');
      expect(
        coin.transform.position[1] === 1.5 && coin.transform.rotation[1] === 0,
        'play mode modified the scene',
      );
    });

    await check('headless play-test dialog (game_run_headless)', async () => {
      await page.locator('.toolbar .tool-btn', { hasText: 'Play-test' }).click();
      await page.locator('.modal .btn.primary', { hasText: 'Run' }).click();
      await page.locator('.modal .playtest-summary').waitFor({ timeout: 120_000 });
      await page.keyboard.press('Escape');
    });

    await check('export dialog builds and smoke-tests a web build (export_web)', async () => {
      await page.locator('.toolbar .tool-btn', { hasText: 'Export' }).click();
      await page.locator('.modal .btn.primary', { hasText: 'Export' }).click();
      await page
        .locator('.modal .playtest-summary, .modal .form-error')
        .first()
        .waitFor({ timeout: 180_000 });
      const badge = await page
        .locator('.modal .playtest-summary .badge')
        .first()
        .innerText()
        .catch(() => '');
      expect(/passed/.test(badge), badge || (await page.locator('.modal .form-error').first().innerText()));
      await page.keyboard.press('Escape');
    });

    await check('modeling workspace saves through model_create and shows its preview', async () => {
      await tab(page, 'Project').click();
      await page.locator('.asset-tile', { hasText: /^crate$/ }).dblclick();
      await page.locator('.modeling .stat strong').first().waitFor({ timeout: 30_000 });
      await page.waitForTimeout(1500);
      await page.locator('.modeling .btn.primary', { hasText: 'Save' }).click();
      await page.locator('.save-preview-img img').waitFor({ timeout: 120_000 });
      await page.screenshot({ path: join(outDir, 'features-modeling.png') });
    });

    await check('dragging a model into the scene view creates an entity', async () => {
      await tab(page, 'Scene').click();
      await page.waitForTimeout(400);
      await page
        .locator('.asset-tile', { hasText: /^coin$/ })
        .dragTo(page.locator('[data-testid="viewport"]'), { targetPosition: { x: 420, y: 330 } });
      await page
        .locator('[data-testid="hierarchy"] .tree-row[data-name="Coin (2)"]')
        .waitFor({ timeout: 10_000 });
    });

    if (ollamaModel) {
      await check(`in-editor agent (${ollamaModel}) creates an entity; Undo AI turn removes it`, async () => {
        await tab(page, 'AI Assistant').click();
        await page.locator('.seg button', { hasText: 'Local' }).click();
        await page.waitForTimeout(1500);
        await page.locator('.chat-model').selectOption(ollamaModel);
        await page
          .locator('.chat-input')
          .fill(
            'Create an entity named "Ball" at position [0, 1, 3] with a MeshRenderer sphere primitive. Use entity_create once, then stop.',
          );
        await page.keyboard.press('Enter');
        await page
          .locator('.chat-working')
          .waitFor({ state: 'visible', timeout: 10_000 })
          .catch(() => undefined);
        await page.locator('.chat-working').waitFor({ state: 'detached', timeout: 300_000 });
        await page.screenshot({ path: join(outDir, 'features-agent.png') });
        const found = await c.request<any>({ type: 'call', name: 'entity_find', input: { name: 'Ball' } });
        expect((found?.total ?? 0) > 0, 'the agent did not create Ball');
        await page.locator('button', { hasText: 'Undo AI turn' }).click();
        await page.waitForTimeout(800);
        const after = await c.request<any>({ type: 'call', name: 'entity_find', input: { name: 'Ball' } });
        expect((after?.total ?? 0) === 0, 'Undo AI turn did not remove Ball');
      });
    } else console.log('  skip in-editor agent (set AIGE_E2E_OLLAMA_MODEL to a local tool-capable model)');

    await check('no uncaught page errors', async () =>
      expect(pageErrors.length === 0, pageErrors.join(' | ')),
    );
  } finally {
    client?.close();
    await app.close().catch(() => undefined);
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
