import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const repoRoot = join(pkgRoot, '..', '..');
const BOT_SENTENCE = 'Bot 模式不在这个包里（它在 daemon / RawAgentRuntime 上）。';
const QUICKSTART_RE = /```ts quickstart\r?\n([\s\S]*?)```/g;

function quickstarts(markdown: string): string[] {
  return [...markdown.matchAll(QUICKSTART_RE)].map((match) => match[1] ?? '');
}

function typecheckQuickstart(source: string): void {
  const dir = mkdtempSync(join(tmpdir(), 'agent-loop-qs-'));
  try {
    const nm = join(dir, 'node_modules');
    mkdirSync(join(nm, '@mage-ai-lab'), { recursive: true });
    mkdirSync(join(nm, '@ppeng'), { recursive: true });
    symlinkSync(pkgRoot, join(nm, '@mage-ai-lab', 'agent-loop'));
    symlinkSync(join(repoRoot, 'packages', 'api-types'), join(nm, '@ppeng', 'api-types'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    writeFileSync(join(dir, 'quickstart.ts'), source);
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          target: 'ES2022',
          strict: true,
          noUncheckedIndexedAccess: true,
          skipLibCheck: true,
          noEmit: true,
          types: ['node'],
          typeRoots: [join(repoRoot, 'node_modules', '@types')],
        },
        files: ['quickstart.ts'],
      })
    );
    const tsc = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
    const result = spawnSync(process.execPath, [tsc, '-p', join(dir, 'tsconfig.json')], {
      encoding: 'utf8',
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('consumer docs', () => {
  const readme = readFileSync(join(pkgRoot, 'README.md'), 'utf8');
  const packagedSkill = readFileSync(join(pkgRoot, 'SKILL.md'), 'utf8');
  const repoSkill = readFileSync(join(repoRoot, 'skills', 'agent-loop', 'SKILL.md'), 'utf8');

  it('ships the repo skill unchanged', () => {
    expect(packagedSkill).toBe(repoSkill);
    expect(packagedSkill).not.toContain('file://');
    expect(packagedSkill).not.toMatch(/createAgentLoop\s*\(/);
    expect(packagedSkill).toContain(BOT_SENTENCE);
    expect(readme).toContain(BOT_SENTENCE);
    const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')) as { files?: string[] };
    expect(pkg.files).toContain('SKILL.md');
  });

  it('quickstart typechecks against package exports', () => {
    const fromReadme = quickstarts(readme);
    const fromSkill = quickstarts(repoSkill);
    expect(fromReadme).toHaveLength(1);
    expect(fromSkill).toEqual(fromReadme);
    const snippet = fromReadme[0]!;
    expect(snippet).toContain('createAssembledLoop');
    expect(snippet).toContain('loop.createHandle(session.id)');
    expect(snippet).toContain('await handle.run()');
    expect(snippet).not.toMatch(/createAgentLoop\s*\(/);
    expect(snippet).toContain("from '@mage-ai-lab/agent-loop'");
    typecheckQuickstart(snippet);
  });
});
