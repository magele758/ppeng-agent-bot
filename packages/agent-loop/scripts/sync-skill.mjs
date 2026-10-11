/** Copy the repo skill into this package so the npm tarball matches skills/agent-loop/SKILL.md. */
import { copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(pkgRoot, '..', '..', 'skills', 'agent-loop', 'SKILL.md');
copyFileSync(source, join(pkgRoot, 'SKILL.md'));
