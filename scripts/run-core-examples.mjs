#!/usr/bin/env node
/**
 * 顺序运行 packages/core/examples/*.mjs（heuristic / 内置脚本适配器，不依赖真实 API key）。
 * 用于验证「@ppeng/agent-core 作为可嵌入 SDK」的最小公开面在构建产物（dist/）上仍可用。
 * 前置：pnpm run build（或至少 `pnpm exec tsc -b packages/core`）产出 packages/core/dist/。
 */
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const examplesDir = join(repoRoot, 'packages', 'core', 'examples');

const files = readdirSync(examplesDir)
  .filter((f) => /^\d+-.*\.mjs$/.test(f))
  .sort();

function runOne(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(examplesDir, file)], {
      cwd: repoRoot,
      stdio: 'inherit'
    });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${file} exited with code ${code}`));
    });
    child.on('error', reject);
  });
}

async function main() {
  console.log(`Running ${files.length} core examples...`);
  for (const file of files) {
    console.log(`\n=== ${file} ===`);
    await runOne(file);
  }
  console.log('\nAll core examples passed.');
}

main().catch((err) => {
  console.error(`\ncore examples failed: ${err.message}`);
  process.exit(1);
});
