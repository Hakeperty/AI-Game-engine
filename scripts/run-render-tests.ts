// Runs the headless render tests (needs: npx playwright-core install chromium-headless-shell).
import { spawnSync } from 'node:child_process';
const r = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'render.render.test'], {
  stdio: 'inherit',
  env: { ...process.env, AIGE_RENDER_TESTS: '1' },
});
process.exit(r.status ?? 1);
