import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBuiltinTools } from '../dist/tools/builtin-tools.js';
import { SandboxManager } from '../dist/sandbox/os-sandbox.js';
import { NativeAgentSandbox } from '../dist/sandbox/native-agent-sandbox.js';
import { createAgentSandboxFromEnv } from '../dist/sandbox/create-agent-sandbox.js';
import { RemoteVmAgentSandbox } from '../dist/sandbox/remote-vm-agent-sandbox.js';
import { MicroserviceAgentSandbox } from '../dist/sandbox/microservice-agent-sandbox.js';
import { startBackgroundJob } from '../dist/runtime/spawn-host.js';
import { checkToolApprovals, checkToolApprovalsForLoop } from '../dist/runtime/tool-loop.js';
import {
  CommandHardlineDeniedError,
  HARDLINE_ERROR_CODE,
  HARDLINE_SIBLING_SKIPPED_CODE,
  hardlineCommandOfToolCall,
  matchCommandHardline
} from '../dist/sandbox/command-hardline.js';
import { bestCpuMs } from './helpers/timing.js';

// V8 coverage instrumentation slows hot loops several-fold; the budgets guard against
// super-linear blowups (seconds or worse on these inputs), not single-digit-ms drift.
// Budgets are CPU time (best of 3), so a loaded machine cannot push them over.
const TIME_BUDGET_SCALE = process.env.NODE_V8_COVERAGE ? 5 : 1;
const budgetMs = (ms) => ms * TIME_BUDGET_SCALE;

function stubServices(overrides = {}) {
  return {
    loadSkill: async () => ({ content: '' }),
    updateTodo: async () => [],
    createTask: async () => ({}),
    getTask: async () => undefined,
    listTasks: async () => [],
    updateTask: async () => ({}),
    harnessWriteSpec: async () => '',
    spawnSubagent: async () => '',
    spawnTeammate: async () => '',
    listAgents: async () => [],
    sendMail: async () => ({}),
    readInbox: async () => [],
    startBackgroundJob: async () => {
      throw new Error('background job must not start');
    },
    getBackgroundJob: async () => undefined,
    listBackgroundJobs: async () => [],
    listWorkspaces: async () => [],
    upsertSessionMemory: async () => ({}),
    listSessionMemory: async () => [],
    deleteSessionMemory: async () => true,
    visionAnalyze: async () => '',
    ...overrides
  };
}

function runContext(dir, permissionMode) {
  return {
    repoRoot: dir,
    workspaceRoot: dir,
    stateDir: dir,
    agent: { id: 'general' },
    session: { id: 'sess-hardline', metadata: permissionMode ? { permissionMode } : {} }
  };
}

function assertBlocked(command, ruleId) {
  const match = matchCommandHardline(command);
  assert.ok(match, `expected block: ${command}`);
  assert.equal(match.ruleId, ruleId, command);
}

function assertAllowed(command) {
  assert.equal(matchCommandHardline(command), null, `expected allow: ${command}`);
}

describe('command hardline matcher', () => {
  it('allows quoted explanation, relative rm, and /tmp paths [AC:command-hardline#AC-4]', () => {
    assertAllowed('git commit -m "rm -rf /"');
    assertAllowed("git commit -m 'rm -rf /'");
    assertAllowed('rm -rf ./build');
    assertAllowed('rm -rf /tmp/foo');
    assertAllowed('rm -rf /tmp/foo && echo ok');
    assertAllowed('echo ok # rm -rf /');
    assertAllowed("echo '$(rm -rf /)'");
    assertAllowed('echo mkfs.ext4 /dev/sda');
    assertAllowed('dd if=/dev/sda of=./disk.img');
    assertAllowed('dd if=/dev/zero of=/dev/null');
    assertAllowed('rm -rf ~/projects/app/dist');
    assertAllowed('rm -rf "$HOME/projects/app/dist"');
    assertAllowed("rm -rf '$HOME'");
    assertAllowed('systemctl status nginx');
    assertAllowed('kill -15 1234');
    assertAllowed('init');
  });

  it('does not flag look-alike words, arguments, or benign neighbours [AC:command-hardline#AC-4]', () => {
    assertAllowed('echo "shutdown now"');
    assertAllowed('grep reboot log');
    assertAllowed('cat mkfs.txt');
    assertAllowed('ls /tmp/mkfs.ext4');
    assertAllowed('vim shutdown.sh');
    assertAllowed('dd if=a of=b.img');
    assertAllowed('systemctl status nginx');
    assertAllowed('systemctl restart nginx');
    assertAllowed('rm -rf /tmp/x');
    assertAllowed('rm -rf ./build');
    assertAllowed('rm -f /etc/hosts.bak');
    assertAllowed('rm /');
    assertAllowed('find /tmp -name "*.log" -delete');
    assertAllowed('find / -name "*.tmp" -delete');
    assertAllowed('find /home/agent/proj -type f -delete');
    assertAllowed('echo "rm -rf /" > notes.txt');
    assertAllowed('printf "reboot" | cat');
    assertAllowed('cat <<EOF\nrm -rf /\nreboot\nEOF');
    assertAllowed('echo "docs: rm -rf /" | sh');
    assertAllowed('echo ok | bash script.sh');
  });

  it('kill: only pid -1 is refused, real signals to real pids are fine', () => {
    assertAllowed('kill -1 1234');
    assertAllowed('kill -1 1234 5678');
    assertAllowed('kill -HUP 1234');
    assertAllowed('kill -SIGHUP 1234');
    assertAllowed('kill -s HUP 1234');
    assertAllowed('kill -s 1 1234');
    assertAllowed('kill -9 1234');
    assertAllowed('kill -9 -1234');
    assertAllowed('kill -l');
    assertAllowed('kill -L');
    assertAllowed('kill -TERM $(pgrep nginx)');
    assertBlocked('kill -1', 'kill-minus-one');
    assertBlocked('kill -1 -1', 'kill-minus-one');
    assertBlocked('kill -9 -1', 'kill-minus-one');
    assertBlocked('kill -KILL -1', 'kill-minus-one');
    assertBlocked('kill -HUP -1', 'kill-minus-one');
    assertBlocked('kill -s KILL -1', 'kill-minus-one');
    assertBlocked('kill -s HUP -1', 'kill-minus-one');
    assertBlocked('kill -n 9 -1', 'kill-minus-one');
    assertBlocked('kill --signal KILL -1', 'kill-minus-one');
    assertBlocked('kill -- -1', 'kill-minus-one');
    assertBlocked('kill -9 1234 -1', 'kill-minus-one');
    assertBlocked('sudo kill -9 -1', 'kill-minus-one');
    assertBlocked('killall5', 'kill-minus-one');
  });

  it('sees through time with options, including value options of GNU time', () => {
    assertBlocked('time rm -rf /', 'rm-root');
    assertBlocked('time -p rm -rf /', 'rm-root');
    assertBlocked('! time -p rm -rf /', 'rm-root');
    assertBlocked('/usr/bin/time -f %e rm -rf /', 'rm-root');
    assertBlocked('/usr/bin/time --format %e rm -rf /', 'rm-root');
    assertBlocked('/usr/bin/time -v -o out.txt rm -rf /', 'rm-root');
    assertBlocked('/usr/bin/time --output out.txt rm -rf /', 'rm-root');
    assertAllowed('time -p ls /');
    assertAllowed('/usr/bin/time -o rm.log ls /');
    assertAllowed('time');
  });

  it('sees through wrappers, compound commands, and command substitution [AC:command-hardline#AC-3]', () => {
    const wrapped = [
      'env rm -rf /',
      'env FOO=1 rm -rf /',
      'env -i -u X rm -rf /',
      'FOO=1 rm -rf /',
      'sudo env rm -rf /',
      'sudo -u root rm -rf /',
      'doas rm -rf /',
      'nice -n 5 rm -rf /',
      'nohup rm -rf /',
      'timeout 5 rm -rf /',
      'timeout -s KILL 5 rm -rf /',
      'exec rm -rf /',
      'command rm -rf /',
      'busybox rm -rf /',
      'xargs -I{} rm -rf /',
      'RM -rf /'
    ];
    for (const command of wrapped) assertBlocked(command, 'rm-root');

    const compound = [
      'true || rm -rf /',
      'false && rm -rf /',
      'echo a | rm -rf /',
      'echo a; rm -rf /',
      'echo a & rm -rf /',
      'echo a\nrm -rf /',
      'rm -rf / &',
      '(rm -rf /)',
      '{ rm -rf /; }',
      'if true; then rm -rf /; fi',
      'while true; do rm -rf /; done',
      'until false; do rm -rf /; done',
      'for i in 1 2; do rm -rf /; done',
      '! rm -rf /',
      'case x in x) rm -rf / ;; esac',
      'f() { rm -rf /; }; f',
      'echo $(rm -rf /)',
      'echo `rm -rf /`',
      'echo "$(rm -rf /)"',
      'echo <(rm -rf /)',
      'eval "rm -rf /"',
      'sh -c "rm -rf /"',
      'bash --norc -c "rm -rf /"',
      'bash -o pipefail -c "rm -rf /"',
      'sudo bash -c \'rm -rf /\'',
      'bash -c "sh -c \'rm -rf /\'"',
      'rm -rf \\\n/',
      'rm -rf "/"',
      "rm -rf '/'",
      "r\\m -rf /",
      '"rm" -rf /',
      'rm -rf / --no-preserve-root',
      'rm --no-preserve-root -rf /'
    ];
    for (const command of compound) assertBlocked(command, 'rm-root');
    assertBlocked('for i in 1; do reboot; done', 'power');
    assertBlocked('true && shutdown -h now', 'power');
    assertBlocked('echo "$(mkfs.ext4 /dev/sdb)"', 'mkfs');
  });

  it('follows scripts fed to a shell through pipes, heredocs, and here-strings [AC:command-hardline#AC-3]', () => {
    assertBlocked('echo "rm -rf /" | sh', 'rm-root');
    assertBlocked('echo "rm -rf /" | bash', 'rm-root');
    assertBlocked('echo rm -rf / | sh', 'rm-root');
    assertBlocked('printf "reboot" | sudo sh', 'power');
    assertBlocked('echo "rm -rf /" | cat | bash', 'rm-root');
    assertBlocked('echo hi |\n sh <<< "rm -rf /"', 'rm-root');
    assertBlocked('sh <<< "rm -rf /"', 'rm-root');
    assertBlocked('bash <<EOF\nrm -rf /\nEOF', 'rm-root');
    assertBlocked("bash <<'EOF'\nrm -rf /\nEOF", 'rm-root');
    assertBlocked('cat <<EOF | sh\nrm -rf /\nEOF', 'rm-root');
    assertBlocked('cat <<EOF; rm -rf /\nhello\nEOF', 'rm-root');
    assertBlocked('bash -s <<EOF\nshutdown now\nEOF', 'power');
  });

  it('covers rm variants on system dirs, home, and host home [AC:command-hardline#AC-1]', () => {
    assertBlocked('rm -Rf /', 'rm-root');
    assertBlocked('rm -r -f /', 'rm-root');
    assertBlocked('rm -f -R /', 'rm-root');
    assertBlocked('rm -rf -v /', 'rm-root');
    assertBlocked('rm -rf --one-file-system /', 'rm-root');
    assertBlocked('rm -rf /.', 'rm-root');
    assertBlocked('rm -rf //', 'rm-root');
    assertBlocked('rm -rf /var', 'rm-system-dir');
    assertBlocked('rm -rf /bin', 'rm-system-dir');
    assertBlocked('rm -rf /boot', 'rm-system-dir');
    assertBlocked('rm -rf /usr/bin', 'rm-system-dir');
    assertBlocked('rm -rf /home/*', 'rm-system-dir');
    assertBlocked('rm -rf /etc/*', 'rm-system-dir');
    assertBlocked('rm -rf ~user', 'rm-home');
    assertBlocked('rm -rf ~/.', 'rm-home');
    assertBlocked('rm -rf $HOME/*', 'rm-home');
    assertBlocked('rm -rf "$HOME/"*', 'rm-home');
    assertBlocked('rm -rf $HOME/..', 'rm-home');
    assertBlocked(`rm -rf ${process.env.HOME}`, 'rm-home');
    assertAllowed(`rm -rf ${process.env.HOME}/project/dist`);
    assertAllowed('rm -rf $HOME/.cache/foo');
  });

  it('covers find -delete, dd devices, mkfs variants, and power verbs', () => {
    assertBlocked('find / -delete', 'rm-root');
    assertBlocked('find / -depth -delete', 'rm-root');
    assertBlocked('find / -exec rm -rf {} +', 'rm-root');
    assertBlocked('find ~ -delete', 'rm-home');
    assertBlocked('find /etc -delete', 'rm-system-dir');
    assertBlocked('dd if=x of=/dev/sda1', 'dd-raw-device');
    assertBlocked('dd of=/dev/sda if=/dev/zero', 'dd-raw-device');
    assertBlocked('dd if=x of=/dev/disk0', 'dd-raw-device');
    assertBlocked('dd if=x of=/dev/rdisk2', 'dd-raw-device');
    assertBlocked('dd if=x of=/dev/loop0', 'dd-raw-device');
    assertBlocked('dd if=x of=/dev/mapper/vg-root', 'dd-raw-device');
    assertBlocked('dd if=x of=/dev/md0', 'dd-raw-device');
    assertBlocked('mkfs -t ext4 /dev/sda', 'mkfs');
    assertBlocked('mke2fs /dev/sda', 'mkfs');
    assertBlocked('sudo mkfs.ext4 /dev/sda', 'mkfs');
    assertBlocked('sudo shutdown now', 'power');
    assertBlocked('/sbin/reboot', 'power');
    assertBlocked('/sbin/init 6', 'init-runlevel');
    assertBlocked('systemctl -i poweroff', 'systemctl-power');
    assertBlocked('systemctl --force --force reboot', 'systemctl-power');
    assertBlocked('systemctl isolate poweroff.target', 'systemctl-power');
    assertBlocked('systemctl start reboot.target', 'systemctl-power');
    assertBlocked('systemctl kexec', 'systemctl-power');
    assertBlocked('loginctl reboot', 'systemctl-power');
    assertBlocked('bomb(){ bomb|bomb& };bomb', 'fork-bomb');
    assertBlocked(': () { : | : & } ; :', 'fork-bomb');
    assertBlocked('bash -c ":(){ :|:& };:"', 'fork-bomb');
    assertAllowed('systemctl start nginx');
    assertAllowed('loginctl list-sessions');
    assertAllowed('init');
    assertAllowed('init 3');
  });

  it('refuses redirects and copy/tee writes to raw block devices [AC:command-hardline#AC-2]', () => {
    assertBlocked('cat x > /dev/sda', 'raw-device-write');
    assertBlocked('cat x >/dev/sda1', 'raw-device-write');
    assertBlocked('echo x>/dev/sda', 'raw-device-write');
    assertBlocked('echo x >> /dev/nvme0n1', 'raw-device-write');
    assertBlocked('cat x >| /dev/vda', 'raw-device-write');
    assertBlocked('cat x &> /dev/sda', 'raw-device-write');
    assertBlocked('cat x &>> /dev/sda', 'raw-device-write');
    assertBlocked('cat x 2> /dev/sda', 'raw-device-write');
    assertBlocked('cat x > "/dev/sda"', 'raw-device-write');
    assertBlocked('cat x > /dev/../dev/sda', 'raw-device-write');
    assertBlocked('> /dev/sda', 'raw-device-write');
    assertBlocked(': > /dev/mmcblk0', 'raw-device-write');
    assertBlocked('exec > /dev/xvda', 'raw-device-write');
    assertBlocked('echo a > /tmp/x; echo b > /dev/sdc', 'raw-device-write');
    assertBlocked('sudo bash -c "cat x > /dev/sda"', 'raw-device-write');
    assertBlocked('cat <<EOF > /dev/sda\nhi\nEOF', 'raw-device-write');
    assertBlocked('cat x > /dev/disk2', 'raw-device-write');
    assertBlocked('cat x > /dev/loop0', 'raw-device-write');
    assertBlocked('cat x > /dev/mapper/vg-root', 'raw-device-write');
    assertBlocked('cat x > /dev/md0', 'raw-device-write');
    assertBlocked('cat x > /dev/dm-0', 'raw-device-write');
    assertBlocked('cat x > /dev/hda', 'raw-device-write');

    assertBlocked('tee /dev/sda', 'raw-device-write');
    assertBlocked('tee -a /dev/sda', 'raw-device-write');
    assertBlocked('cat x | sudo tee /dev/sda', 'raw-device-write');
    assertBlocked('tee /tmp/a /dev/sdb', 'raw-device-write');
    assertBlocked('cp img /dev/sda', 'raw-device-write');
    assertBlocked('mv a /dev/sdb', 'raw-device-write');
    assertBlocked('install x /dev/sda', 'raw-device-write');
  });

  it('lets harmless device redirects, tee, and reads through', () => {
    assertAllowed('echo hi > /dev/null');
    assertAllowed('cmd 2>/dev/null');
    assertAllowed('cmd > /dev/null 2>&1');
    assertAllowed('cmd &> /dev/null');
    assertAllowed('cmd >&2');
    assertAllowed('cmd 2>&1');
    assertAllowed('cmd 2>&-');
    assertAllowed('cmd > /dev/stderr');
    assertAllowed('cmd > /dev/stdout');
    assertAllowed('cmd > /dev/tty');
    assertAllowed('cmd > /dev/zero');
    assertAllowed('cmd > /dev/fd/2');
    assertAllowed('cmd > /dev/pts/0');
    assertAllowed('cat x > ./dev/sda');
    assertAllowed('cat x > out.txt');
    assertAllowed('cat /dev/sda > disk.img');
    assertAllowed('cp /dev/sda disk.img');
    assertAllowed('dd if=/dev/sda of=disk.img');
    assertAllowed('tee /dev/null');
    assertAllowed('tee out.txt');
    assertAllowed('tee -a build.log');
    assertAllowed('cp a b');
  });

  it('quote-masks explanatory text that mentions device writes', () => {
    assertAllowed('echo "cat f > /dev/sda"');
    assertAllowed("echo 'x >> /dev/sda'");
    assertAllowed('git commit -m "tee /dev/sda"');
    assertAllowed('git commit -m "cat x > /dev/sda; wipefs -a /dev/sda; shred /dev/sda"');
    assertAllowed('echo "dd of=/dev/sda"');
    assertAllowed('grep "> /dev/sda" notes.md');
    assertAllowed("bash -c 'echo \"cat f > /dev/sda\"'");
  });

  it('wipefs and shred are refused only on block devices', () => {
    assertBlocked('wipefs -a /dev/sda', 'wipe-device');
    assertBlocked('wipefs --all --force /dev/sdb', 'wipe-device');
    assertBlocked('sudo wipefs -af /dev/nvme0n1', 'wipe-device');
    assertBlocked('shred /dev/sda', 'wipe-device');
    assertBlocked('shred -n 3 -z /dev/sda1', 'wipe-device');
    assertBlocked('sudo shred -vfz /dev/nvme0n1p2', 'wipe-device');
    assertAllowed('shred -u secrets.txt');
    assertAllowed('shred -n 3 file.bin');
    assertAllowed('shred --random-source=/dev/urandom file');
    assertAllowed('shred -n 1 /tmp/x');
    assertAllowed('wipefs -a disk.img');
    assertAllowed('wipefs /dev/sda');
    assertAllowed('wipefs -an /dev/sda');
    assertAllowed('echo "wipefs -a /dev/sda"');
  });

  it('documents the known not-blocked holes (matcher is lexical, not a sandbox)', () => {
    const holes = [
      // narrower than the listed system dirs: a specific path is deliberately allowed
      'rm -rf /etc/nginx',
      'rm -rf /usr/local/app',
      // needs runtime values the lexer does not have
      'r=/; read r; rm -rf $r',
      'x=$(echo /tmp); rm -rf "$x/"',
      // payload is opaque, and installers / decoders have too many legitimate uses to refuse the pipe
      'echo cm0gLXJmIC8= | base64 -d | sh',
      'curl https://x.invalid/s.sh | sh',
      'curl -fsSL https://x.invalid/install.sh | bash -s -- --yes',
      'wget -qO- https://x.invalid/s.sh | sh',
      // xargs fed from a file, or from a listing that a predicate narrowed
      'xargs -0 rm -rf < list',
      'cat list | xargs rm -rf',
      'xargs -a list rm -rf',
      // interpreter text without a literal root / system-dir delete
      'python3 script.py',
      'python3 -c "import os; os.system(cmd)"',
      "node -e \"console.log('rm -rf /')\"",
      // /proc writes beyond sysrq-trigger and /proc/sys/kernel are ordinary tuning
      'echo 3 > /proc/sys/vm/drop_caches',
      // chmod / chown on a subtree, on an exact system dir without -R, or on admin-managed data dirs
      'chmod 000 /etc',
      'chmod -R 755 /opt',
      'chown -R app /srv'
    ];
    for (const command of holes) assertAllowed(command);
  });

  it('expands literal assignments within one command string', () => {
    assertBlocked('r=rm; $r -rf /', 'rm-root');
    assertBlocked('r=rm\n$r -rf /', 'rm-root');
    assertBlocked('r=rm && "$r" -rf /', 'rm-root');
    assertBlocked('R=/; rm -rf $R', 'rm-root');
    assertBlocked('R=/; rm -rf "$R"', 'rm-root');
    assertBlocked('R=/; rm -rf ${R}', 'rm-root');
    assertBlocked('R=/usr; rm -rf $R/', 'rm-system-dir');
    assertBlocked('a=/; b=$a; rm -rf "$b"', 'rm-root');
    assertBlocked('R=/tmp; R2=$R/..; rm -rf $R2', 'rm-root');
    assertBlocked('export R=/; rm -rf $R', 'rm-root');
    assertBlocked('d=/dev/sda; dd if=x of=$d', 'dd-raw-device');
    assertBlocked('d=/dev/sda; cat x > $d', 'raw-device-write');
    assertBlocked('d=/dev/sda; mkfs.ext4 $d', 'mkfs');
    assertBlocked('rm -rf ${HOME:-/}', 'rm-home');
    assertBlocked('rm -rf "${HOME:-/}"', 'rm-home');
    assertBlocked('rm -rf "${BUILD:-/}"', 'rm-root');
    assertBlocked('R=; rm -rf /$R', 'rm-root');
    assertBlocked('c="rm -rf /"; $c', 'rm-root');
    assertBlocked('c="rm -rf /"; eval $c', 'rm-root');
    assertBlocked('c="rm -rf /"; echo $c | sh', 'rm-root');
    assertBlocked('c="rm -rf /"; sh -c "$c"', 'rm-root');
    assertBlocked('export R=/; sh -c \'rm -rf $R\'', 'rm-root');
    assertBlocked('R=/ sh -c \'rm -rf $R\'', 'rm-root');
    assertBlocked('{ r=rm; $r -rf /; }', 'rm-root');
    assertBlocked('(r=rm; $r -rf /)', 'rm-root');
    assertBlocked('r=rm; (r=ls; :); $r -rf /', 'rm-root');
    assertBlocked('r=ls; r=rm; $r -rf /', 'rm-root');
    assertBlocked('sudo -u root bash -c "r=rm; \\$r -rf /"', 'rm-root');

    // controls: same shapes, harmless values or no execution of the variable
    assertAllowed('echo "$r"');
    assertAllowed('r=rm; echo $r');
    assertAllowed('r=rm; echo "$r -rf /"');
    assertAllowed('r=ls; $r -rf /');
    assertAllowed('R=/tmp; rm -rf $R');
    assertAllowed('R=/tmp; rm -rf "$R/x"');
    assertAllowed('R=/; echo $R');
    assertAllowed('R=/; ls $R');
    assertAllowed('R=/; R=/tmp; rm -rf $R');
    assertAllowed('R=/; unset R; rm -rf $R');
    assertAllowed('R=/; read R; rm -rf $R');
    assertAllowed('R=/; export R; sh -c "echo hi"');
    assertAllowed('FOO=/ rm -rf $FOO');
    assertAllowed('R=/ echo hi; rm -rf $R');
    assertAllowed('r=rm | cat; $r -rf /');
    assertAllowed('r=rm & $r -rf /');
    assertAllowed('(r=rm); $r -rf /');
    assertAllowed('r=rm || true; echo done');
    assertAllowed('false || r=rm; $r -rf /');
    assertAllowed('R=/; sh -c \'rm -rf $R\'');
    assertAllowed('d=/dev/sda; dd if=$d of=out.img');
    assertAllowed('d=/dev/null; dd if=x of=$d');
    assertAllowed('rm -rf ${BUILD:-/tmp}');
    assertAllowed('rm -rf ${BUILD:-}/x');
    assertAllowed('rm -rf "${BUILD:-./build}"');
    assertAllowed('c="rm -rf /"; echo $c');
    assertAllowed('c="rm -rf /"; git commit -m "$c"');
    assertAllowed('c="rm -rf /"; echo "$c" > note.txt');
    assertAllowed('R=`pwd`/; rm -rf "$R"');
    assertAllowed("R='$X'; rm -rf $R");
    assertAllowed("R=/; rm -rf '$R'");
  });

  it('expands command substitutions that are a single echo / printf of literal words', () => {
    assertBlocked('rm -rf $(echo /)', 'rm-root');
    assertBlocked('rm -rf "$(echo /)"', 'rm-root');
    assertBlocked("rm -rf $(printf '/')", 'rm-root');
    assertBlocked('rm -rf `echo /`', 'rm-root');
    assertBlocked('rm -rf "`echo /`"', 'rm-root');
    assertBlocked('rm -rf $(echo -n /)', 'rm-root');
    assertBlocked('rm -rf $(echo /usr)', 'rm-system-dir');
    assertBlocked('$(echo rm) -rf /', 'rm-root');
    assertBlocked('`echo rm` -rf /', 'rm-root');
    assertBlocked('$(echo rm -rf /)', 'rm-root');
    assertBlocked('sudo $(echo rm) -rf /', 'rm-root');
    assertBlocked('x=$(echo /); rm -rf $x', 'rm-root');
    assertBlocked('x=$(echo /); rm -rf "$x"', 'rm-root');
    assertBlocked("x=`printf '/'`; rm -rf $x", 'rm-root');
    assertBlocked('x=$(echo /usr); rm -rf "$x/"', 'rm-system-dir');
    assertBlocked('cd $(echo /) && rm -rf .', 'rm-root');
    assertBlocked('sh -c "rm -rf $(echo /)"', 'rm-root');
    assertBlocked('d=$(echo /dev/sda); dd if=x of=$d', 'dd-raw-device');

    // controls: harmless literal results
    assertAllowed('rm -rf $(echo /tmp/x)');
    assertAllowed('rm -rf "$(echo /tmp)/x"');
    assertAllowed("rm -rf $(printf 'build')");
    assertAllowed('x=$(echo /tmp/x); rm -rf $x');
    assertAllowed('x=$(echo a rm -rf /); echo done');
    assertAllowed('$(echo ls) -la /');
    assertAllowed('echo $(echo /)');
    assertAllowed('git commit -m "$(echo rm -rf /)"');
    assertAllowed("echo '$(echo rm) -rf /'");

    // unknown substitutions stay allowed: pipes, variables, other commands, globs, printf formats
    assertAllowed('rm -rf $(echo / | cat)');
    assertAllowed('rm -rf $(echo /; true)');
    assertAllowed('rm -rf $(echo $X)');
    assertAllowed('X=/; rm -rf $(echo $X)');
    assertAllowed('rm -rf $(cat roots.txt)');
    assertAllowed('rm -rf $(pwd)x');
    assertAllowed('x=$(pwd); rm -rf $x');
    assertAllowed('rm -rf $(echo $(echo /))');
    assertAllowed("rm -rf $(printf '%s' /)");
    assertAllowed('rm -rf $(echo /*)');
    assertAllowed('rm -rf $(echo -e /)');
    assertAllowed('rm -rf $(echo / > out.txt)');
    assertAllowed('rm -rf $(echo)');
  });

  it('replays for loops over a literal word list', () => {
    assertBlocked('for r in /; do rm -rf $r; done', 'rm-root');
    assertBlocked('for r in /; do rm -rf "$r"; done', 'rm-root');
    assertBlocked('for d in / /home; do rm -rf "$d"; done', 'rm-root');
    assertBlocked('for d in /tmp/x /home; do rm -rf "$d"; done', 'rm-system-dir');
    assertBlocked('for d in /home /; do rm -rf $d; done', 'rm-system-dir');
    assertBlocked('for c in rm; do $c -rf /; done', 'rm-root');
    assertBlocked('for c in ls rm; do $c -rf /; done', 'rm-root');
    assertBlocked('for c in rm; do sudo "$c" -rf /; done', 'rm-root');
    assertBlocked('for r in /\ndo\n  rm -rf $r\ndone', 'rm-root');
    assertBlocked('for r in /; do\n  echo $r\n  rm -rf $r\ndone', 'rm-root');
    assertBlocked('for r in /; do for s in a b; do rm -rf $r; done; done', 'rm-root');
    assertBlocked('for a in x y; do for r in /; do rm -rf $r; done; done', 'rm-root');
    assertBlocked('for r in /; do echo $r; done; rm -rf $r', 'rm-root');
    assertBlocked('(for r in /; do rm -rf $r; done)', 'rm-root');
    assertBlocked('for r in x; do (cd /; rm -rf .); done', 'rm-root');
    assertBlocked('for r in /; do true; done && for d in /; do rm -rf $d; done', 'rm-root');
    assertBlocked('R=/; for d in $R; do rm -rf $d; done', 'rm-root');
    assertBlocked('for d in /dev/sda; do dd if=x of=$d; done', 'dd-raw-device');
    assertBlocked('for i in 1 2; do rm -rf /; done', 'rm-root');
    assertBlocked('for i in 1; do reboot; done', 'power');
    assertBlocked('for d in /tmp; do cd $d; done; cd /; rm -rf .', 'rm-root');

    // controls: same shapes with harmless values, or loop variable never reaches a dangerous command
    assertAllowed('for d in /tmp/x; do rm -rf $d; done');
    assertAllowed('for d in /tmp/x /tmp/y; do rm -rf "$d"; done');
    assertAllowed('for d in a b; do rm -rf ./$d; done');
    assertAllowed('for r in /; do echo $r; done');
    assertAllowed('for r in /; do ls $r; done');
    assertAllowed('for r in /; do rm -f $r/x; done');
    assertAllowed('for r in /; do rm -rf $r/tmp-build; done');
    assertAllowed('for c in ls; do $c -rf /; done');
    assertAllowed('for r in /tmp; do cd $r; done; rm -rf .');
    assertAllowed('for r in /; do true; done; r=x; rm -rf $r');

    // unknown lists stay allowed: glob, brace, command substitution, variable, positional args
    assertAllowed('for f in *.log; do rm $f; done');
    assertAllowed('for f in /*; do rm -rf $f; done');
    assertAllowed('for d in {/,/home}; do rm -rf $d; done');
    assertAllowed('for d in $(echo /; ls); do rm -rf $d; done');
    assertAllowed('for d in $(ls); do rm -rf $d; done');
    assertAllowed('for d in $DIRS; do rm -rf $d; done');
    assertAllowed('for d; do rm -rf $d; done');
    assertAllowed('for d in "$@"; do rm -rf "$d"; done');
    assertAllowed('for r in /; do read r; rm -rf $r; done');
  });

  it('follows alias and function definitions only once they are called [AC:command-hardline#AC-3]', () => {
    assertBlocked("alias r='rm -rf /'; r", 'rm-root');
    assertBlocked('alias r="rm -rf /"\nr', 'rm-root');
    assertBlocked("alias r='rm -rf'; r /", 'rm-root');
    assertBlocked("alias r=rm; r -rf /", 'rm-root');
    assertBlocked("alias r='rm -rf /' && r", 'rm-root');
    assertBlocked("alias a='rm -rf /'; alias b=a; b", 'rm-root');
    assertBlocked("alias r='sudo rm -rf /'; r", 'rm-root');
    assertBlocked("R=/; alias r='rm -rf $R'; r", 'rm-root');
    assertBlocked("alias x=ls; alias x='rm -rf /'; x", 'rm-root');
    assertBlocked("alias r='rm -rf /'; eval r", 'rm-root');

    assertBlocked('f() { rm -rf /; }; f', 'rm-root');
    assertBlocked('f(){ rm -rf /; }; f', 'rm-root');
    assertBlocked('f () { rm -rf /; }; f', 'rm-root');
    assertBlocked('f() { rm -rf /; } && f', 'rm-root');
    assertBlocked('f() ( rm -rf / ); f', 'rm-root');
    assertBlocked('function f { rm -rf /; }; f', 'rm-root');
    assertBlocked('function f() { rm -rf /; }; f', 'rm-root');
    assertBlocked('f()\n{\n  rm -rf /\n}\nf', 'rm-root');
    assertBlocked('f() { rm -rf /; }; echo a; f', 'rm-root');
    assertBlocked('f() { rm -rf /; }; true && f', 'rm-root');
    assertBlocked('f() { rm -rf /; }; sudo f', 'rm-root');
    assertBlocked('f() { g; }; g() { rm -rf /; }; f', 'rm-root');
    assertBlocked('f() { reboot; }; f', 'power');
    assertBlocked('f() { echo a; }; f; rm -rf /', 'rm-root');
    assertBlocked('r=/; f() { rm -rf $r; }; f', 'rm-root');

    // controls: defined but never called, called under another name, shadowed, removed, or harmless
    assertAllowed("alias r='rm -rf /'");
    assertAllowed("alias r='rm -rf /'; echo r");
    assertAllowed("alias r='rm -rf /'; unalias r; r");
    assertAllowed("alias r='rm -rf /'; unalias -a; r");
    assertAllowed("alias r='rm -rf /'; alias r=ls; r");
    assertAllowed("alias r='rm -rf /'; 'r'");
    assertAllowed("alias r='rm -rf /' | cat; r");
    assertAllowed("alias r='rm -rf /' & r");
    assertAllowed("(alias r='rm -rf /'); r");
    assertAllowed("false || alias r='rm -rf /'; r");
    assertAllowed("alias r='rm -rf /'; bash -c r");
    assertAllowed("alias ll='ls -l'; ll /");
    assertAllowed("alias rm='rm -i'; rm -r ./build");
    assertAllowed("alias ls='ls -l'; ls /");
    assertAllowed("alias r='echo rm -rf /'; r");
    assertAllowed("alias r='rm -rf /tmp/x'; r");
    assertAllowed('f() { rm -rf /; }');
    assertAllowed('f() { rm -rf /; }; g');
    assertAllowed('f() { rm -rf /; }; echo f');
    assertAllowed('f() ( rm -rf / )');
    assertAllowed('function f { rm -rf /; }');
    assertAllowed('f() { rm -rf /; }; unset -f f; f');
    assertAllowed('f() { rm -rf /; }; f() { echo hi; }; f');
    assertAllowed('f() { rm -rf /; }; (f() { :; }); echo ok');
    assertAllowed('f() { echo hi; }; f');
    assertAllowed('f() { rm -rf ./build; }; f');
    assertAllowed('f() { rm -rf /tmp/x; }; f');
    assertAllowed('f() { f; }; f');
    assertAllowed('f() { f; f; f; f; f; f; f; f; f; f; }; f');
    assertAllowed('(f() { rm -rf /; }); f');
    assertAllowed('f() { rm -rf /; } | cat; g');
    assertAllowed('git commit -m "f() { rm -rf /; }; f"');
    assertAllowed('echo "alias r=\'rm -rf /\'; r"');
  });

  it('binds positional parameters for function calls and sh -c', () => {
    assertBlocked('f() { rm -rf "$1"; }; f /', 'rm-root');
    assertBlocked('f() { rm -rf $1; }; f /', 'rm-root');
    assertBlocked('f() { rm -rf "${1}"; }; f /', 'rm-root');
    assertBlocked('f() { rm -rf "$1"; }; f /home', 'rm-system-dir');
    assertBlocked('f() { rm -rf "$1"; }; sudo f /', 'rm-root');
    assertBlocked('f() { rm -rf "$1"; }; f ~', 'rm-home');
    assertBlocked('cleanup() { rm -rf "$1" "$2"; }; cleanup /tmp/x /', 'rm-root');
    assertBlocked('cleanup() { rm -rf "$1" "$2"; }; cleanup / /tmp/x', 'rm-root');
    assertBlocked('f() { rm -rf "$@"; }; f /', 'rm-root');
    assertBlocked('f() { rm -rf "$@"; }; f ./a /', 'rm-root');
    assertBlocked('f() { rm -rf $@; }; f /tmp/x /etc', 'rm-system-dir');
    assertBlocked('f() { rm -rf "$*"; }; f /', 'rm-root');
    assertBlocked('f() { rm -rf "$*"; }; f ./a /', 'rm-root');
    assertBlocked('f() { rm -rf "/$2"; }; f a', 'rm-root');
    assertBlocked('f() { rm -rf "$1/$2"; }; f / ""', 'rm-root');
    assertAllowed('f() { rm -rf "$1/$2"; }; f / x');
    assertBlocked('f() { $1 -rf /; }; f rm', 'rm-root');
    assertBlocked('f() { rm -rf "${1:-/}"; }; f', 'rm-root');
    assertBlocked('f() { rm -rf "${1:-/}"; }; f ""', 'rm-root');
    assertBlocked('f() { rm -rf "${2:-/}"; }; f ./build', 'rm-root');
    assertBlocked('f() { rm -rf "${1:-/}"; }; f /', 'rm-root');
    assertBlocked('f() { rm -rf "${1-/}"; }; f', 'rm-root');
    assertBlocked('f() { for d in "$@"; do rm -rf "$d"; done; }; f ./a /', 'rm-root');
    assertBlocked('function f { rm -rf "$1"; }; f /', 'rm-root');
    assertBlocked('f() ( rm -rf "$1" ); f /', 'rm-root');
    assertBlocked('f() { shift; rm -rf "$1"; }; f ./a /', 'rm-root');
    assertBlocked('f() { shift 2; rm -rf "$1"; }; f a b /', 'rm-root');
    assertBlocked('f() { set -- /; rm -rf "$1"; }; f ./a', 'rm-root');
    assertBlocked('R=/; f() { rm -rf "$1"; }; f $R', 'rm-root');
    assertBlocked('f() { rm -rf "$1"; }; f "$HOME"', 'rm-home');

    // nested calls hand their own positionals on
    assertBlocked('g() { rm -rf "$1"; }; f() { g "$1"; }; f /', 'rm-root');
    assertBlocked('g() { rm -rf "$2"; }; f() { g x "$1"; }; f /', 'rm-root');
    assertBlocked('g() { rm -rf "$@"; }; f() { g ./a "$@"; }; f /', 'rm-root');
    assertBlocked('g() { rm -rf "$1"; }; f() { g "$2"; }; f ./a /', 'rm-root');
    assertBlocked('f() { g "$1"; }; g() { rm -rf "$1"; }; f /', 'rm-root');
    assertAllowed('f() { rm -rf "$1"; g; }; g() { rm -rf "$1"; }; f ./a /');
    assertAllowed('g() { rm -rf "$1"; }; f() { g "$1"; }; f ./build');
    assertAllowed('g() { rm -rf "$1"; }; f() { g ./build; }; f /');
    assertAllowed('g() { rm -rf "$1"; }; f() { g "$2"; }; f / ./build');
    // a recursive function stays bounded by the expansion cap
    assertAllowed('f() { f "$1"; }; f /tmp/x');
    assertAllowed('f() { rm -rf "$1"; f "$1"; }; f ./build');
    assertBlocked('f() { rm -rf "$1"; f "$1"; }; f /', 'rm-root');

    // safe, unknown or unused arguments, and definitions that are never called
    assertAllowed('f() { rm -rf "$1"; }; f ./build');
    assertAllowed('f() { rm -rf "$1"; }; f /tmp/x');
    assertAllowed('f() { rm -rf "$1"; }; f "$x"');
    assertAllowed('f() { rm -rf "$1"; }; f $x');
    assertAllowed('f() { rm -rf "$1"; }; f "$(mktemp -d)"');
    assertAllowed('f() { rm -rf "$1"; }; f \'$HOME\'');
    assertAllowed('f() { rm -rf "$1"; }; f \'~\'');
    assertAllowed('f() { rm -rf "$1"; }');
    assertAllowed('f() { rm -rf "$1"; }; g /');
    assertAllowed('f() { rm -rf "$1"; }; echo f /');
    assertAllowed('f() { rm -rf "$1"; }; f ./build /');
    assertAllowed('f() { rm -rf "$2"; }; f / ./build');
    assertAllowed('f() { rm -rf "$1"; }; (f() { :; }); f /tmp/x');
    assertAllowed('f() { rm -rf "$1"; }; f');
    assertAllowed('f() { rm -rf "/$1"; }; f tmp-build');
    assertAllowed('f() { rm -rf "$@"; }; f');
    assertAllowed('f() { rm -rf "$@"; }; f ./a ./b');
    assertAllowed('f() { rm -rf "$@"; }; f "$x"');
    assertAllowed('f() { rm -rf "$*"; }; f ./build');
    assertAllowed('f() { shift; rm -rf "$1"; }; f / ./build');
    assertAllowed('f() { shift 2; rm -rf "$1"; }; f / / ./build');
    assertAllowed('f() { set -- ./build; rm -rf "$1"; }; f /');
    assertAllowed('f() { echo "$1"; }; f /');
    assertAllowed('f() { ls "$1"; }; f /');
    assertAllowed('f() { rm -f "$1"; }; f /');
    assertAllowed('f() { rm -rf "$1/build"; }; f /');
    assertAllowed('f() { rm -rf "$1"; }; echo "f /"');
    // $# and $0 are counts / names, never paths
    assertAllowed('f() { rm -rf "$#"; }; f / /');
    assertAllowed('f() { rm -rf "$0"; }; f /');
    assertAllowed('f() { [ "$#" -gt 0 ] && rm -rf ./build; }; f /');
    assertAllowed('f() { rm -rf "/$#"; }; f');
    assertAllowed('f() { rm -rf "/$#"; }; f a');
    // defaults apply only when the argument was not passed (or is empty for :-)
    assertAllowed('f() { rm -rf "${1:-/}"; }; f ./build');
    assertAllowed('f() { rm -rf "${1:-/}"; }; f "$x"');
    assertAllowed('f() { rm -rf "${1:-./build}"; }; f');
    assertAllowed('f() { rm -rf "${1-/}"; }; f ""');
    assertAllowed('f() { rm -rf "${2:-./build}"; }; f /');
    // outside any function or sh -c, the script's own arguments are unknown
    assertAllowed('rm -rf "$1"');
    assertAllowed('rm -rf "${1:-/}"');
    assertAllowed('rm -rf "$@"');
    assertAllowed('rm -rf "$*"');
    assertAllowed('for d in "$@"; do rm -rf "$d"; done');

    // sh -c / bash -c: $0 is the first operand after the script, $1.. follow
    assertBlocked("sh -c 'rm -rf \"$1\"' _ /", 'rm-root');
    assertBlocked("bash -c 'rm -rf \"$1\"' x /", 'rm-root');
    assertBlocked("bash -c 'rm -rf \"$1\"' x /home", 'rm-system-dir');
    assertBlocked("sudo bash -c 'rm -rf \"$1\"' x /", 'rm-root');
    assertBlocked("bash -lc 'rm -rf \"$1\"' x /", 'rm-root');
    assertBlocked("sh -c 'rm -rf \"$2\"' _ ./a /", 'rm-root');
    assertBlocked("sh -c 'rm -rf \"$@\"' _ ./a /", 'rm-root');
    assertBlocked("sh -c 'rm -rf \"$*\"' _ /", 'rm-root');
    assertBlocked("sh -c 'rm -rf \"${1:-/}\"' _", 'rm-root');
    assertBlocked("sh -c 'rm -rf \"${1:-/}\"'", 'rm-root');
    assertBlocked("sh -c 'rm -rf \"$0\"' /", 'rm-root');
    assertBlocked('sh -c "rm -rf \\"\\$1\\"" _ /', 'rm-root');
    assertBlocked("sh -c 'g() { rm -rf \"$1\"; }; g \"$1\"' _ /", 'rm-root');
    assertBlocked("sh -c 'g() { rm -rf \"$1\"; }; g /' _ ./build", 'rm-root');
    assertBlocked("r=/; sh -c 'rm -rf \"$1\"' _ $r", 'rm-root');
    assertAllowed("bash -c 'rm -rf \"$1\"' x ./build");
    assertAllowed("sh -c 'rm -rf \"$1\"' / ./build");
    assertAllowed("sh -c 'rm -rf \"$1\"' _ \"$x\"");
    assertAllowed("sh -c 'rm -rf \"$1\"' _");
    assertAllowed("sh -c 'rm -rf \"$1\"'");
    assertAllowed("sh -c 'rm -rf \"$@\"' _");
    assertAllowed("sh -c 'rm -rf \"${1:-./build}\"'");
    assertAllowed("sh -c 'rm -rf \"${1:-/}\"' _ ./build");
    assertAllowed("sh -c 'rm -rf \"$2\"' _ /");
    assertAllowed("sh -c 'echo \"$1\"' _ /");
    assertAllowed("sh -c 'rm -rf \"$#\"' _ /");
    assertAllowed("sh -c 'rm -rf \"$0\"' ./build /");
    assertAllowed("sh -c 'rm -rf \"$1\"' _ '$HOME'");
    // positionals of a function or shell are not visible to a child shell
    assertAllowed('f() { sh -c \'rm -rf "$1"\'; }; f /');
    assertAllowed('f() { bash -c \'rm -rf "$1"\' x ./build; }; f /');
    assertBlocked('f() { bash -c \'rm -rf "$1"\' x "$1"; }; f /', 'rm-root');
    // eval shares the caller's positionals
    assertBlocked('f() { eval \'rm -rf "$1"\'; }; f /', 'rm-root');
    assertAllowed('f() { eval \'rm -rf "$1"\'; }; f ./build');
    // xargs keeps its existing rules; the {} placeholder is not a positional parameter
    assertAllowed("xargs -I{} sh -c 'rm -rf \"{}\"'");
    assertAllowed("ls | xargs -I{} sh -c 'rm -rf \"{}\"'");
    assertAllowed("find . -name x | xargs -I{} sh -c 'rm -rf \"$1\"' _ {}");
    assertAllowed("printf '/\\n' | xargs -I{} sh -c 'rm -rf \"$1\"' _ {}");
    assertBlocked("xargs -I{} sh -c 'rm -rf /' ", 'rm-root');
  });

  it('refuses non-recursive chmod / chown / chgrp of / itself, not of subdirectories', () => {
    assertBlocked('chmod 000 /', 'root-perm');
    assertBlocked('chmod 0 /', 'root-perm');
    assertBlocked('chmod 700 /', 'root-perm');
    assertBlocked('chmod 644 /', 'root-perm');
    assertBlocked('chmod a-x /', 'root-perm');
    assertBlocked('chmod go-rx /', 'root-perm');
    assertBlocked('chmod u=rw,go= /', 'root-perm');
    assertBlocked('chmod -v 000 /', 'root-perm');
    assertBlocked('chmod 000 -- /', 'root-perm');
    assertBlocked('chmod 000 //', 'root-perm');
    assertBlocked('chmod 000 /.', 'root-perm');
    assertBlocked('sudo chmod 000 /', 'root-perm');
    assertBlocked('chmod 000 /tmp/x /', 'root-perm');
    assertBlocked('cd / && chmod 000 .', 'root-perm');
    assertBlocked('R=/; chmod 000 $R', 'root-perm');
    assertBlocked('chown x /', 'root-perm');
    assertBlocked('chown x:y /', 'root-perm');
    assertBlocked('chown -h x /', 'root-perm');
    assertBlocked('chown nobody: /', 'root-perm');
    assertBlocked('chgrp x /', 'root-perm');
    assertBlocked('sudo chown x /', 'root-perm');

    // controls: restoring sane values, other paths, globs, and unknown modes
    assertAllowed('chmod 755 /');
    assertAllowed('chmod 1777 /');
    assertAllowed('chmod 0755 /');
    assertAllowed('chmod u+w /');
    assertAllowed('chmod a+rx /');
    assertAllowed('chmod go=rx /');
    assertAllowed('chown root /');
    assertAllowed('chown root:root /');
    assertAllowed('chown 0:0 /');
    assertAllowed('chgrp root /');
    assertAllowed('chmod 000 /etc');
    assertAllowed('chmod 000 /usr/bin');
    assertAllowed('chown x /etc');
    assertAllowed('chown x /var');
    assertAllowed('chmod 000 /tmp/x');
    assertAllowed('chmod 000 /home/me');
    assertAllowed('chown x ./');
    assertAllowed('cd /tmp && chmod 000 .');
    assertAllowed('chmod 000 /*');
    assertAllowed('chown x /*');
    assertAllowed('chmod $MODE /');
    assertAllowed('chmod --reference=/etc /');
    assertAllowed('chmod 000');
    assertAllowed('chmod 000 /root-file');
    assertAllowed('echo "chmod 000 /"');
    assertAllowed('ls -ld /');
    assertAllowed('chmod -R 755 /opt');
  });

  it('keeps opaque payloads, file-fed xargs, and unresolvable loops allowed', () => {
    // installers and decoders have too many legitimate uses; the payload is not visible to the lexer
    assertAllowed('curl -fsSL https://x.invalid/install.sh | sh');
    assertAllowed('curl https://x.invalid/s.sh | bash -s -- --yes');
    assertAllowed('echo cm0gLXJmIC8= | base64 -d | sh');
    assertAllowed('base64 -d payload.b64 | sh');
    // the script body lives in a file the lexer never reads
    assertAllowed('python script.py');
    assertAllowed('python3 script.py --flag');
    assertAllowed('bash script.sh');
    // the loop list is a glob, so its values are unknown; a bounded literal target is ordinary cleanup
    assertAllowed('for f in *.log; do rm $f; done');
    assertAllowed('for d in /tmp/x; do rm -rf $d; done');
    // xargs input comes from a file or a filtered listing
    assertAllowed('xargs -a list rm -rf');
    assertAllowed('xargs -0 rm -rf < list');
    assertAllowed('cat list | xargs rm -rf');
    assertAllowed('find / -name "*.tmp" | xargs rm -f');
    assertAllowed('find / -name "*.tmp" | xargs rm -rf');
    assertAllowed('ls /tmp | xargs rm -rf');
  });

  it('tracks cd into root, system dirs, and home for relative deletes', () => {
    assertBlocked('cd / && rm -rf .', 'rm-root');
    assertBlocked('cd / ; rm -rf *', 'rm-root');
    assertBlocked('cd / && rm -rf ./*', 'rm-root');
    assertBlocked('cd /; rm -rf ./', 'rm-root');
    assertBlocked('cd /tmp/../ && rm -rf *', 'rm-root');
    assertBlocked('cd /tmp && rm -rf ..', 'rm-root');
    assertBlocked('cd /usr; cd ..; rm -rf .', 'rm-root');
    assertBlocked('cd -- /; rm -rf .', 'rm-root');
    assertBlocked('pushd / >/dev/null; rm -rf .', 'rm-root');
    assertBlocked('cd /; rm -rf usr', 'rm-system-dir');
    assertBlocked('cd /etc && rm -rf .', 'rm-system-dir');
    assertBlocked('cd /etc && rm -rf *', 'rm-system-dir');
    assertBlocked('cd /etc && find . -delete', 'rm-system-dir');
    assertBlocked('cd / && find . -exec rm -rf {} +', 'rm-root');
    assertBlocked('cd / && find -delete', 'rm-root');
    assertBlocked('cd ~ && rm -rf *', 'rm-home');
    assertBlocked('cd && rm -rf .', 'rm-home');
    assertBlocked('cd $HOME && rm -rf ./*', 'rm-home');
    assertBlocked('cd ${HOME} && rm -rf .', 'rm-home');
    assertBlocked('R=/; cd $R && rm -rf .', 'rm-root');
    assertBlocked('cd / && sudo rm -rf .', 'rm-root');
    assertBlocked('cd /; (rm -rf .)', 'rm-root');
    assertBlocked('cd / && { rm -rf .; }', 'rm-root');
    assertBlocked('cd /; echo | rm -rf .', 'rm-root');
    assertBlocked('cd /; sh -c "rm -rf ."', 'rm-root');
    assertBlocked('bash -c "cd / && rm -rf ."', 'rm-root');
    assertBlocked('cd / && rm -rf $(echo x) .', 'rm-root');

    // controls
    assertAllowed('cd /tmp && rm -rf ./x');
    assertAllowed('cd /tmp && rm -rf .');
    assertAllowed('cd /tmp && rm -rf *');
    assertAllowed('cd / && ls');
    assertAllowed('cd / && ls -la .');
    assertAllowed('cd / && rm -rf tmp/x');
    assertAllowed('cd / && rm -rf ./x');
    assertAllowed('cd / && rm -f x');
    assertAllowed('cd /etc && rm -rf nginx');
    assertAllowed('cd /home/agent/proj && rm -rf .');
    assertAllowed('cd /home/agent/proj && rm -rf *');
    assertAllowed('cd /; cd /tmp; rm -rf *');
    assertAllowed('cd /; cd /tmp/build && rm -rf .');
    assertAllowed('cd /; cd -; rm -rf .');
    assertAllowed('cd /; cd $X; rm -rf .');
    assertAllowed('cd /; cd "$(mktemp -d)"; rm -rf .');
    assertAllowed('(cd /; ls); rm -rf .');
    assertAllowed('(cd / && ls) && rm -rf ./x');
    assertAllowed('cd / & rm -rf .');
    assertAllowed('cd / | cat; rm -rf .');
    assertAllowed('cd .. && rm -rf .');
    assertAllowed('cd; ls');
    assertAllowed('rm -rf .');
    assertAllowed('rm -rf *');
    assertAllowed('find . -delete');
  });

  it('refuses home dotfile globs', () => {
    assertBlocked('rm -rf "$HOME"/.[!.]*', 'rm-home');
    assertBlocked('rm -rf $HOME/.[!.]*', 'rm-home');
    assertBlocked('rm -rf ${HOME}/.??*', 'rm-home');
    assertBlocked('rm -rf ~/.*', 'rm-home');
    assertBlocked('rm -rf ~/.[^.]*', 'rm-home');
    assertBlocked('rm -rf ~/* ~/.*', 'rm-home');
    assertBlocked('rm -rf ~/.* ~/*', 'rm-home');
    assertBlocked('rm -rf -- ~/.*', 'rm-home');
    assertBlocked('rm -rf "$HOME/".*', 'rm-home');
    assertBlocked(`rm -rf ${process.env.HOME}/.*`, 'rm-home');
    assertBlocked('cd ~ && rm -rf .*', 'rm-home');
    assertBlocked('sudo rm -rf ~/.*', 'rm-home');

    assertAllowed('rm -rf ~/.cache');
    assertAllowed('rm -rf ~/.cache/*');
    assertAllowed('rm -rf ~/proj/.*');
    assertAllowed('rm -rf ~/proj/.[!.]*');
    assertAllowed('rm -rf "$HOME"/.config/foo');
    assertAllowed('rm -rf ~/.*.bak');
    assertAllowed('rm -rf ./.*');
    assertAllowed('rm -rf /tmp/x/.*');
    assertAllowed('ls ~/.*');
    assertAllowed('rm -f ~/.*');
  });

  it('follows xargs only when its input is an unfiltered root / system / home listing', () => {
    assertBlocked('find / | xargs rm -rf', 'rm-root');
    assertBlocked('find / | xargs rm', 'rm-root');
    assertBlocked('find / -print0 | xargs -0 rm -rf', 'rm-root');
    assertBlocked('find / -maxdepth 1 | xargs rm -rf', 'rm-root');
    assertBlocked('find / | xargs -I{} rm -rf {}', 'rm-root');
    assertBlocked('find / | xargs -I {} rm -rf {}', 'rm-root');
    assertBlocked('find / | xargs -n 10 -P 4 rm -rf', 'rm-root');
    assertBlocked('find / | sort | xargs rm -rf', 'rm-root');
    assertBlocked('find / | tee list.txt | xargs rm -rf', 'rm-root');
    assertBlocked('find / | sudo xargs rm -rf', 'rm-root');
    assertBlocked('find / | xargs sudo rm -rf', 'rm-root');
    assertBlocked('find /etc | xargs rm -rf', 'rm-system-dir');
    assertBlocked('find ~ | xargs rm -rf', 'rm-home');
    assertBlocked('ls -d /* | xargs rm -rf', 'rm-root');
    assertBlocked('ls / | xargs rm -rf', 'rm-root');
    assertBlocked('ls -A / | xargs rm -rf', 'rm-root');
    assertBlocked('ls /etc/* | xargs rm -rf', 'rm-system-dir');
    assertBlocked('cd / && ls | xargs rm -rf', 'rm-root');
    assertBlocked('cd / && find | xargs rm -rf', 'rm-root');
    assertBlocked('R=/; find $R | xargs rm -rf', 'rm-root');
    assertBlocked('xargs -I{} rm -rf /', 'rm-root');
    assertBlocked('echo x | xargs rm -rf /', 'rm-root');

    // controls: same commands with a filtered or file-backed input, or a non-rm consumer
    assertAllowed('find / -name x | xargs rm -rf');
    assertAllowed('find / -type f -name "*.tmp" | xargs rm -f');
    assertAllowed('find / -mtime +30 | xargs rm');
    assertAllowed('find / -name x -print0 | xargs -0 rm -rf');
    assertAllowed('find / -name x | xargs grep y');
    assertAllowed('find / | xargs grep y');
    assertAllowed('find / | xargs ls -l');
    assertAllowed('find / -maxdepth 1 | xargs echo');
    assertAllowed('find /tmp | xargs rm -rf');
    assertAllowed('find /home/agent/proj | xargs rm -rf');
    assertAllowed('find . | xargs rm -rf');
    assertAllowed('find . -name "*.pyc" | xargs rm');
    assertAllowed('find ~ -name "*.pyc" | xargs rm');
    assertAllowed('find / | grep foo | xargs rm -rf');
    assertAllowed('find / | head -n 5 | xargs rm -rf');
    assertAllowed('ls | xargs rm -rf');
    assertAllowed('ls /tmp | xargs rm -rf');
    assertAllowed('ls -I keep / | xargs rm -rf');
    assertAllowed('ls / | xargs echo');
    assertAllowed('cat list | xargs rm -rf');
    assertAllowed('cat list | sort | xargs rm -rf');
    assertAllowed('xargs rm -rf < list');
    assertAllowed('xargs -0 rm -rf < list');
    assertAllowed('xargs -a list rm -rf');
    assertAllowed('xargs --arg-file=list rm -rf');
    assertAllowed('printf "a\\nb" | xargs rm -rf');
    assertAllowed('xargs -I{} echo {}');
  });

  it('refuses recursive chmod / chown of root and exact system dirs, mv of root, and sysrq writes', () => {
    assertBlocked('chmod -R 000 /', 'recursive-perm');
    assertBlocked('chmod -R 000 /*', 'recursive-perm');
    assertBlocked('chmod -R 777 /', 'recursive-perm');
    assertBlocked('chmod -Rf a-x /etc', 'recursive-perm');
    assertBlocked('chmod --recursive 000 /usr', 'recursive-perm');
    assertBlocked('chmod -R 000 -- /', 'recursive-perm');
    assertBlocked('sudo chmod -R 000 /', 'recursive-perm');
    assertBlocked('chown -R x /', 'recursive-perm');
    assertBlocked('chown -R x:y /', 'recursive-perm');
    assertBlocked('chown -R x /usr', 'recursive-perm');
    assertBlocked('chown -hR x /var', 'recursive-perm');
    assertBlocked('chgrp -R x /etc', 'recursive-perm');
    assertBlocked('chown --recursive x /home', 'recursive-perm');
    assertBlocked('cd / && chmod -R 000 .', 'recursive-perm');
    assertBlocked('R=/; chown -R x $R', 'recursive-perm');
    assertAllowed('chmod -R 000 /tmp/x');
    assertAllowed('chmod -R 755 /var/www');
    assertAllowed('chmod -R u+w /usr/local/share/app');
    assertAllowed('chown -R x /etc/nginx');
    assertAllowed('chown -R x /etc/*');
    assertAllowed('chown -R x /home/me');
    assertAllowed('chown -R x ~');
    assertAllowed('chmod -R 755 ~/proj');
    assertAllowed('chmod -R 755 /opt');
    assertAllowed('chown -R app:app /srv');
    assertAllowed('chmod -R 755 ./build');
    assertAllowed('cd /tmp && chmod -R 755 .');
    assertAllowed('chmod +x script.sh');

    assertBlocked('mv / x', 'mv-system');
    assertBlocked('mv /* x', 'mv-system');
    assertBlocked('mv -f / x', 'mv-system');
    assertBlocked('mv / /dev/null', 'mv-system');
    assertBlocked('mv -t /tmp /', 'mv-system');
    assertBlocked('mv --target-directory=/tmp /', 'mv-system');
    assertBlocked('mv /etc /tmp/etc.old', 'mv-system');
    assertBlocked('mv /usr/bin /tmp/bin', 'mv-system');
    assertBlocked('mv a / x', 'mv-system');
    assertBlocked('sudo mv / x', 'mv-system');
    assertBlocked('cd / && mv * /tmp/x', 'mv-system');
    assertAllowed('mv x /');
    assertAllowed('mv x /etc');
    assertAllowed('mv a b');
    assertAllowed('mv /tmp/a /tmp/b');
    assertAllowed('mv /etc/hosts /tmp/hosts.bak');
    assertAllowed('mv /etc/* /tmp/x');
    assertAllowed('mv /home/* /mnt/backup');
    assertAllowed('mv ~/a ~/b');
    assertAllowed('mv /opt /srv/opt');
    assertAllowed('cd /tmp && mv * x');
    assertAllowed('mv -T /tmp/a /tmp/b');

    assertBlocked('echo b > /proc/sysrq-trigger', 'proc-write');
    assertBlocked('echo b >/proc/sysrq-trigger', 'proc-write');
    assertBlocked('echo c >> /proc/sysrq-trigger', 'proc-write');
    assertBlocked('> /proc/sysrq-trigger', 'proc-write');
    assertBlocked('echo o | tee /proc/sysrq-trigger', 'proc-write');
    assertBlocked('echo o | sudo tee -a /proc/sysrq-trigger', 'proc-write');
    assertBlocked('dd of=/proc/sysrq-trigger', 'proc-write');
    assertBlocked('cp x /proc/sysrq-trigger', 'proc-write');
    assertBlocked('sudo bash -c "echo b > /proc/sysrq-trigger"', 'proc-write');
    assertBlocked('echo b > /proc/../proc/sysrq-trigger', 'proc-write');
    assertBlocked('echo 0 > /proc/sys/kernel/randomize_va_space', 'proc-write');
    assertBlocked('echo x > /proc/sys/kernel/panic', 'proc-write');
    assertBlocked('echo x | tee /proc/sys/kernel/sysrq', 'proc-write');
    assertBlocked('P=/proc/sysrq-trigger; echo b > $P', 'proc-write');
    assertAllowed('cat /proc/sysrq-trigger');
    assertAllowed('cat /proc/sys/kernel/hostname');
    assertAllowed('echo 3 > /proc/sys/vm/drop_caches');
    assertAllowed('echo 1 > /proc/sys/net/ipv4/ip_forward');
    assertAllowed('echo x > /proc/self/oom_score_adj');
    assertAllowed('echo x > /proc/sys/kernelx/y');
    assertAllowed('echo "echo b > /proc/sysrq-trigger"');
    assertAllowed('grep sysrq /proc/sysrq-trigger.txt');
    assertAllowed('echo b > ./proc/sysrq-trigger');
  });

  it('inspects interpreter one-liners for a literal delete of root or a system dir only', () => {
    assertBlocked(`python -c "import shutil;shutil.rmtree('/')"`, 'rm-root');
    assertBlocked(`python3 -c "import shutil; shutil.rmtree('/', ignore_errors=True)"`, 'rm-root');
    assertBlocked(`python3.11 -c 'import shutil; shutil.rmtree("/etc")'`, 'rm-system-dir');
    assertBlocked(`python -c "from shutil import rmtree; rmtree( '/usr' )"`, 'rm-system-dir');
    assertBlocked(`python -c "import os;os.system('rm -rf /')"`, 'rm-root');
    assertBlocked(`python -c "import os;os.popen('rm -rf /')"`, 'rm-root');
    assertBlocked(`python -c "import subprocess;subprocess.run('rm -rf /', shell=True)"`, 'rm-root');
    assertBlocked(`python -c "import subprocess;subprocess.call(['rm','-rf','/'])"`, 'rm-root');
    assertBlocked(`python -c "import os;os.system('shutdown -h now')"`, 'power');
    assertBlocked(`sudo python3 -c "import shutil;shutil.rmtree('/')"`, 'rm-root');
    assertBlocked(`python -B -c "import shutil;shutil.rmtree('/')"`, 'rm-root');
    assertBlocked(`python3 - <<'EOF'\nimport shutil\nshutil.rmtree('/')\nEOF`, 'rm-root');
    assertBlocked(`python3 <<EOF\nimport os\nos.system("rm -rf /")\nEOF`, 'rm-root');
    assertBlocked(`node -e "require('fs').rmSync('/',{recursive:true})"`, 'rm-root');
    assertBlocked(`node -e "require('fs').rmSync('/', { recursive: true, force: true })"`, 'rm-root');
    assertBlocked(`node -e "require('fs').rmdirSync('/var',{recursive:true})"`, 'rm-system-dir');
    assertBlocked(`node -e "require('fs').promises.rm('/', {recursive:true})"`, 'rm-root');
    assertBlocked(`node --eval "require('fs').rmSync('/',{recursive:true})"`, 'rm-root');
    assertBlocked(`node -p "require('fs').rmSync('/',{recursive:true})"`, 'rm-root');
    assertBlocked(`node -e "require('child_process').execSync('rm -rf /')"`, 'rm-root');
    assertBlocked(`node -e "require('child_process').spawnSync('rm', ['-rf', '/'])"`, 'rm-root');
    assertBlocked(`node -e "require('child_process').execFileSync('rm', ['-rf', '/usr'])"`, 'rm-system-dir');
    assertBlocked(`node - <<'EOF'\nrequire('fs').rmSync('/',{recursive:true})\nEOF`, 'rm-root');
    assertBlocked(`perl -e 'system("rm -rf /")'`, 'rm-root');
    assertBlocked(`perl -e 'system("rm", "-rf", "/")'`, 'rm-root');
    assertBlocked(`perl -le 'system q(x); system("rm -rf /")'`, 'rm-root');
    assertBlocked(`perl -MFile::Path -e 'rmtree("/")'`, 'rm-root');
    assertBlocked(`perl -e 'exec("reboot")'`, 'power');
    assertBlocked(`ruby -e 'system("rm -rf /")'`, 'rm-root');
    assertBlocked(`ruby -e 'FileUtils.rm_rf("/")'`, 'rm-root');

    // controls: same interpreters, nothing that deletes root / a system dir
    assertAllowed('python -c "print(1)"');
    assertAllowed(`python -c "shutil.rmtree('./build')"`);
    assertAllowed(`python -c "shutil.rmtree('build')"`);
    assertAllowed(`python -c "shutil.rmtree('/tmp/x')"`);
    assertAllowed(`python -c "shutil.rmtree('/etc/nginx')"`);
    assertAllowed(`python -c "shutil.rmtree(path)"`);
    assertAllowed(`python -c "shutil.rmtree('~')"`);
    assertAllowed(`python -c "os.system('echo hi')"`);
    assertAllowed(`python -c "os.system('rm -rf ./build')"`);
    assertAllowed(`python -c "os.system(cmd)"`);
    assertAllowed(`python -c "print('rm -rf /')"`);
    assertAllowed(`python -c "print(\\"shutil.rmtree('/')\\")"`);
    assertAllowed(`python -c "subprocess.run(['echo', 'rm -rf /'])"`);
    assertAllowed(`python -c "subprocess.run(['ls', '/'])"`);
    assertAllowed('python script.py');
    assertAllowed('python -m pytest -c pytest.ini');
    assertAllowed('python3 - <<EOF\nprint("hi")\nEOF');
    assertAllowed(`python3 - <<'EOF'\nimport shutil\nshutil.rmtree('/tmp/x')\nEOF`);
    assertAllowed(`node -e "require('fs').rmSync('./dist',{recursive:true})"`);
    assertAllowed(`node -e "require('fs').rmSync('/tmp/x',{recursive:true})"`);
    assertAllowed(`node -e "require('fs').rmSync(dir,{recursive:true})"`);
    assertAllowed(`node -e "console.log('/')"`);
    assertAllowed(`node -e "console.log('rm -rf /')"`);
    assertAllowed(`node -e "require('child_process').execSync('ls /')"`);
    assertAllowed(`node -e "require('child_process').spawnSync('ls', ['-la', '/'])"`);
    assertAllowed(`node -pe "1+1"`);
    assertAllowed(`node script.js --eval "rmSync('/')"`);
    assertAllowed(`perl -e 'print "hi"'`);
    assertAllowed(`perl -e 'print "system(q(rm -rf /))"'`);
    assertAllowed(`perl -e 'system("ls /")'`);
    assertAllowed(`perl -MFile::Path -e 'rmtree("/tmp/x")'`);
    assertAllowed(`ruby -e 'FileUtils.rm_rf("./tmp")'`);
    assertAllowed(`echo "shutil.rmtree('/')"`);
    assertAllowed(`git commit -m "python -c \\"shutil.rmtree('/')\\""`);
    assertAllowed(`cat <<EOF\nshutil.rmtree('/')\nEOF`);
  });

  it('blocks recursive deletes of root, system dirs, and home [AC:command-hardline#AC-1]', () => {
    assertBlocked('rm -rf /', 'rm-root');
    assertBlocked('rm -fr /', 'rm-root');
    assertBlocked('rm -r /', 'rm-root');
    assertBlocked('rm --recursive --force /', 'rm-root');
    assertBlocked('rm -rf -- /', 'rm-root');
    assertBlocked('/bin/rm -rf /', 'rm-root');
    assertBlocked('rm -rf /*', 'rm-root');
    assertBlocked('rm -rf /tmp/foo/../../', 'rm-root');
    assertBlocked('sudo rm -rf /', 'rm-root');
    assertBlocked('sudo -n rm -rf /', 'rm-root');
    assertBlocked('echo hi && rm -rf /', 'rm-root');
    assertBlocked('echo hi; rm -rf /', 'rm-root');
    assertBlocked("bash -c 'rm -rf /'", 'rm-root');
    assertBlocked('bash -lc "rm -rf /"', 'rm-root');
    assertBlocked('echo "$(rm -rf /)"', 'rm-root');
    assertBlocked('rm -rf /home', 'rm-system-dir');
    assertBlocked('rm -rf /home/', 'rm-system-dir');
    assertBlocked('rm -rf /root', 'rm-system-dir');
    assertBlocked('rm -rf /etc', 'rm-system-dir');
    assertBlocked('rm -rf /usr', 'rm-system-dir');
    assertBlocked('rm -rf /usr/*', 'rm-system-dir');
    assertBlocked('rm -rf /tmp/foo/../../../etc', 'rm-system-dir');
    assertBlocked('rm -rf ~', 'rm-home');
    assertBlocked('rm -rf ~/', 'rm-home');
    assertBlocked('rm -rf ~/*', 'rm-home');
    assertBlocked('rm -rf $HOME', 'rm-home');
    assertBlocked('rm -rf "$HOME"', 'rm-home');
    assertBlocked('rm -rf ${HOME}', 'rm-home');
    assertBlocked('rm -rf "${HOME}"', 'rm-home');
    assertBlocked('rm -rf ${HOME}/', 'rm-home');
  });

  it('blocks mkfs, raw dd, fork bombs, and power commands [AC:command-hardline#AC-2]', () => {
    assertBlocked('mkfs.ext4', 'mkfs');
    assertBlocked('mkfs.ext4 /dev/sdb1', 'mkfs');
    assertBlocked('/sbin/mkfs.vfat /dev/sdb', 'mkfs');
    assertBlocked('mkfs', 'mkfs');
    assertBlocked('dd if=/dev/zero of=/dev/sda bs=1M', 'dd-raw-device');
    assertBlocked('dd of=/dev/nvme0n1', 'dd-raw-device');
    assertBlocked('dd of=/dev/nvme0n1p1', 'dd-raw-device');
    assertBlocked('dd of=/dev/mmcblk0', 'dd-raw-device');
    assertBlocked('dd of=/dev/vda', 'dd-raw-device');
    assertBlocked('dd of=/dev/xvda', 'dd-raw-device');
    assertBlocked('dd of=/dev/hda', 'dd-raw-device');
    assertBlocked(':(){ :|:& };:', 'fork-bomb');
    assertBlocked(':() { : | : & }; :', 'fork-bomb');
    assertBlocked('shutdown -h now', 'power');
    assertBlocked('reboot', 'power');
    assertBlocked('halt', 'power');
    assertBlocked('poweroff', 'power');
    assertBlocked('init 0', 'init-runlevel');
    assertBlocked('init 6', 'init-runlevel');
    assertBlocked('telinit 0', 'init-runlevel');
    assertBlocked('telinit 6', 'init-runlevel');
    assertBlocked('systemctl poweroff', 'systemctl-power');
    assertBlocked('systemctl reboot', 'systemctl-power');
    assertBlocked('systemctl halt', 'systemctl-power');
    assertBlocked('systemctl --no-block poweroff', 'systemctl-power');
    assertBlocked('kill -1', 'kill-minus-one');
    assertBlocked('kill -9 -1', 'kill-minus-one');
  });

  it('does not treat a quoted fork bomb as a command', () => {
    assertAllowed('echo ":(){ :|:& };:"');
    assertAllowed("bash -c 'git commit -m \"rm -rf /\"'");
  });
});

const ROOT_SCRIPT_RM = `"import shutil; shutil.rmtree('/')"`;
const NODE_RM = `"require('fs').rmSync('/',{recursive:true})"`;

describe('command hardline: every listed rule input', () => {
  it('refuses rm -rf of every listed system directory', () => {
    for (const dir of [
      '/sbin', '/lib', '/lib32', '/lib64', '/dev', '/sys', '/proc', '/opt', '/srv',
      '/usr/sbin', '/usr/lib', '/usr/lib64', '/Users', '/System', '/Library'
    ]) {
      assertBlocked(`rm -rf ${dir}`, 'rm-system-dir');
    }
  });

  it('follows -c scripts of every listed shell and commands after reserved words', () => {
    for (const shell of ['dash', 'zsh', 'ksh', 'ash', 'fish']) assertBlocked(`${shell} -c 'rm -rf /'`, 'rm-root');
    for (const command of [
      'if rm -rf /; then :; fi',
      'if true; then :; elif rm -rf /; then :; fi',
      'if false; then :; else rm -rf /; fi',
      'while rm -rf /; do :; done',
      'until rm -rf /; do :; done',
      'coproc rm -rf /'
    ]) {
      assertBlocked(command, 'rm-root');
    }
    // Reserved words can't name functions, so these bodies are scanned as plain commands.
    for (const word of ['time', 'coproc', 'while']) assertBlocked(`${word}() { rm -rf /; }; ${word}`, 'rm-root');
  });

  it('treats a shell as reading stdin unless it was given a script file', () => {
    for (const shell of ['bash -s', 'bash -s foo', 'bash -', 'bash +x', 'bash -x', 'bash -s script.sh', 'bash - script.sh']) {
      assertBlocked(`echo 'rm -rf /' | ${shell}`, 'rm-root');
    }
    assertAllowed(`echo 'rm -rf /' | bash script.sh`);
    assertAllowed(`echo 'rm -rf /' | bash -x script.sh`);
  });

  it('sees through every wrapper option that takes a value', () => {
    for (const wrapper of [
      'sudo --user root', 'sudo -g wheel', 'sudo --group wheel', 'sudo -h host', 'sudo --host host',
      'sudo -p pw', 'sudo --prompt pw', 'sudo -C 3', 'sudo --close-from 3', 'sudo -T 10',
      'sudo --command-timeout 10', 'sudo -r role', 'sudo --role role', 'sudo -t type', 'sudo --type type',
      'sudo --', 'command -p', 'env --unset FOO', 'env -C /tmp', 'env --chdir /tmp', 'nice --adjustment 10',
      'stdbuf -o L', 'stdbuf -i 0', 'stdbuf -e 0', 'stdbuf -oL', 'setsid -f', 'setsid -w -f', 'builtin',
      'doas -u root', 'doas -C /etc/doas.conf', 'doas -n', 'ionice -c 3', 'ionice -n 7', 'ionice -p 1',
      'ionice -P 1', 'ionice -u 1', 'ionice -t', 'timeout -k 5 10', 'timeout --signal KILL 10',
      'timeout --kill-after 5 10', 'timeout --preserve-status 10'
    ]) {
      assertBlocked(`${wrapper} rm -rf /`, 'rm-root');
    }
  });

  it('refuses recursive chmod of home only for modes that open it up or lock the owner out', () => {
    for (const mode of [
      '777', '600', '1777', '707', 'o+w', 'a+w', '+w', '=w', 'o=rw', 'u-w', 'a-r', 'u-x', 'ug-r', 'u+x,o+w'
    ]) {
      assertBlocked(`chmod -R ${mode} ~`, 'recursive-perm');
    }
    for (const mode of [
      '755', '700', '0755', '12345', 'g+w', 'u+w', 'g-w', 'o-w', 'a-s', 'zz,o+w', 'u+r', 'go-rwx', 'ug+rw', 'o+rx'
    ]) {
      assertAllowed(`chmod -R ${mode} ~`);
    }
  });

  it('refuses chmod / chown of / itself only when it stops being usable or owned by root', () => {
    for (const command of ['chmod 700 /', 'chmod a-x /', 'chmod u-x /', 'chmod go-r /', 'chmod =r /', 'chmod =x /', 'chown nobody /', 'chown root:nobody /']) {
      assertBlocked(command, 'root-perm');
    }
    for (const command of [
      'chmod 755 /', 'chmod 0755 /', 'chmod =rx /', 'chmod u+w /', 'chmod a=rwx /', 'chmod zz /',
      'chown root /', 'chown 0:0 /', 'chown root:root /', 'chown :root /',
      'chown --reference=/etc /', 'chmod --reference=/etc /'
    ]) {
      assertAllowed(command);
    }
  });

  it('skips the value of every xargs option before finding the command', () => {
    for (const option of [
      '-d x', '-E END', '-L 1', '-s 100', '--delimiter x', '--max-args 1', '--max-procs 2',
      '--max-chars 100', '--max-lines 1', '--process-slot-var V', '-n 1', '-P 4', '--'
    ]) {
      assertBlocked(`ls / | xargs ${option} rm -rf`, 'rm-root');
    }
    for (const filter of ['cat', 'tac', 'uniq', 'sort', 'tee x']) {
      assertBlocked(`ls / | ${filter} | xargs rm -rf`, 'rm-root');
    }
    assertAllowed('ls / | xargs -a list rm -rf');
    assertAllowed('ls / | xargs --arg-file list rm -rf');
    assertAllowed('ls / | xargs --arg-file=list rm -rf');
    assertAllowed('ls / | grep tmp | xargs rm -rf');
  });

  it('find: neutral predicates and root options do not narrow, real predicates and non-rm exec do', () => {
    for (const command of [
      'find / -xdev -delete', 'find / -mount -delete', 'find / -mindepth 1 -delete', 'find / -print -delete',
      'find / -execdir rm -rf {} \\;', 'find / -ok rm -rf {} \\;', 'find / -okdir rm -rf {} \\;',
      'find / -exec rm -rf {} +', 'find -H / -delete', 'find -L / -delete', 'find -P / -delete',
      'find -O3 / -delete', 'find -D tree / -delete'
    ]) {
      assertBlocked(command, 'rm-root');
    }
    for (const command of [
      "find / -exec echo {} \\; -name x", "find / -name '*.log' -delete", "find / '(' -name a ')' -delete",
      'find / ! -name a -delete', 'find / -execdir ls {} \\;', 'find / -okdir ls {} \\;'
    ]) {
      assertAllowed(command);
    }
  });

  it('systemctl: option values are not mistaken for the verb', () => {
    for (const option of ['-t service', '--type service', '-p X', '--property X', '-H host', '--host host', '-M m', '--machine m', '--state x', '--']) {
      assertBlocked(`systemctl ${option} poweroff`, 'systemctl-power');
    }
    for (const command of ['systemctl -t poweroff status', 'systemctl --type reboot status', 'systemctl -p reboot show', 'systemctl --property halt show', 'systemctl -H reboot status', 'systemctl --host reboot status', 'systemctl -M halt status', 'systemctl --machine halt status', 'systemctl --state reboot list-units']) {
      assertAllowed(command);
    }
  });

  it('shell -c is found after option values, and not after -- or a script operand', () => {
    for (const shell of ['bash -o pipefail -c', 'bash +o pipefail -c', 'bash -O extglob -c', 'bash +O extglob -c', 'bash --command', 'bash -xc', 'bash --norc -c', 'bash +x -c']) {
      assertBlocked(`${shell} 'rm -rf /'`, 'rm-root');
    }
    assertAllowed(`bash -- -c 'rm -rf /'`);
    assertAllowed(`bash script.sh -c 'rm -rf /'`);
    assertAllowed(`bash -o -c 'rm -rf /'`);
    assertAllowed(`bash +o -c 'rm -rf /'`);
    assertAllowed(`bash -O -c 'rm -rf /'`);
    assertAllowed(`bash +O -c 'rm -rf /'`);
  });

  it('wipefs is refused when it erases, and allowed when it only lists or dry-runs', () => {
    for (const flags of ['--all', '--force', '--offset 0', '-a', '-af', '-o 0', '--backup -a']) {
      assertBlocked(`wipefs ${flags} /dev/sda`, 'wipe-device');
    }
    assertAllowed('wipefs /dev/sda');
    assertAllowed('wipefs --no-act -a /dev/sda');
    assertAllowed('wipefs -a -n /dev/sda');
  });

  it('kill: list options and bare signals are not pid -1', () => {
    assertAllowed('kill -9');
    assertAllowed('kill -HUP');
    assertAllowed('kill -l -1');
    assertAllowed('kill -L -1');
    assertAllowed('kill --list -1');
    assertAllowed('kill --table -1');
  });

  it('interpreters: every inline flag and value option is understood', () => {
    for (const command of [
      `pypy3 -c ${ROOT_SCRIPT_RM}`, `pypy -c ${ROOT_SCRIPT_RM}`, `python3 -W ignore -c ${ROOT_SCRIPT_RM}`,
      `python3 -X dev -c ${ROOT_SCRIPT_RM}`, `python2 -Q new -c ${ROOT_SCRIPT_RM}`, `python3 -Bc ${ROOT_SCRIPT_RM}`,
      `python3 -u <<'EOF'\nimport shutil\nshutil.rmtree('/')\nEOF`,
      `nodejs -e ${NODE_RM}`, `node -r ts-node/register -e ${NODE_RM}`, `node --require x -e ${NODE_RM}`,
      `node --import x -e ${NODE_RM}`, `node --loader x -e ${NODE_RM}`, `node --input-type module -e ${NODE_RM}`,
      `node --eval=${NODE_RM}`, `node --print=${NODE_RM}`, `node -pe ${NODE_RM}`, `node -ep ${NODE_RM}`,
      `node --print ${NODE_RM}`,
      `php -r 'system("rm -rf /");'`, `php -d x=1 -r 'system("rm -rf /");'`, `php -c php.ini -r 'system("rm -rf /");'`,
      `ruby -we 'system("rm -rf /")'`, `ruby -I lib -e 'system("rm -rf /")'`, `ruby -r json -e 'system("rm -rf /")'`,
      `perl -I lib -e 'system("rm -rf /")'`, `perl -E 'system("rm -rf /")'`
    ]) {
      assertBlocked(command, 'rm-root');
    }
    for (const command of [
      `python3 -- -c ${ROOT_SCRIPT_RM}`, `python3 script.py <<'EOF'\nimport shutil\nshutil.rmtree('/')\nEOF`,
      'node --eval=1 script.js', `php -r 'print("hi");'`, 'php script.php', `php -d -r 'system("rm -rf /");'`
    ]) {
      assertAllowed(command);
    }
  });

  it('mv: target-directory forms still see the moved source', () => {
    for (const command of ['mv --target-directory /tmp /', 'mv -- / /tmp/x', 'mv -T / /tmp/x', 'mv -f -- /etc /tmp/etc']) {
      assertBlocked(command, 'mv-system');
    }
  });

  it('tracks exports, clobbering builtins, alias redefinition and popd', () => {
    for (const command of [
      "R=/; export R; sh -c 'rm -rf $R'",
      "declare -x R=/; sh -c 'rm -rf $R'",
      "typeset -x R=/; sh -c 'rm -rf $R'",
      "declare -rx R=/; sh -c 'rm -rf $R'",
      "R=/; declare -x R; sh -c 'rm -rf $R'",
      'R=/; printf x; rm -rf $R',
      'R=/; printf -v Q x; rm -rf $R'
    ]) {
      assertBlocked(command, 'rm-root');
    }
    for (const command of [
      "R=/; sh -c 'rm -rf $R'",
      "declare R=/; sh -c 'rm -rf $R'",
      'R=/; printf -v R x; rm -rf $R',
      'R=/; unset R; rm -rf $R',
      "alias x='rm -rf /'; false || alias x=ls; x",
      "alias x='rm -rf /'; alias x=$Y; x",
      'cd /tmp; pushd /; popd; rm -rf *'
    ]) {
      assertAllowed(command);
    }
  });

  it('fork bomb masking honours quotes, escapes and comments', () => {
    for (const command of [
      `echo "it's" :(){ :|:& };:`,
      `echo "a\\"b" :(){ :|:& };:`,
      `echo 'a\\' :(){ :|:& };:`,
      `echo "a\\\\" :(){ :|:& };:`,
      `echo a#b :(){ :|:& };:`,
      `echo \\' :(){ :|:& };:`,
      `echo \\" :(){ :|:& };:`,
      `echo hi # note\n:(){ :|:& };:`,
      `echo '#' :(){ :|:& };:`
    ]) {
      assertBlocked(command, 'fork-bomb');
    }
    for (const command of [
      `echo ":(){ :|:& };:"`,
      `# :(){ :|:& };:`,
      `echo hi # :(){ :|:& };:`,
      `echo hi;# :(){ :|:& };:`,
      `echo hi|# :(){ :|:& };:`
    ]) {
      assertAllowed(command);
    }
  });
});

describe('command hardline review fixes', () => {
  const timed = (command) => bestCpuMs(() => matchCommandHardline(command));

  it('fork bomb detection is linear on adversarial input', () => {
    for (const n of [100_000, 400_000]) {
      const inputs = {
        run: 'a'.repeat(n),
        colons: 'a:'.repeat(n / 2),
        unclosed: 'a'.repeat(n) + '()',
        spaced: 'a' + ' '.repeat(n),
        openers: '(){ '.repeat(n / 4)
      };
      for (const [label, command] of Object.entries(inputs)) {
        const { result, ms } = timed(command);
        assert.equal(result, null, `${label} ${n}`);
        assert.ok(ms < budgetMs(200), `${label} ${n} took ${ms.toFixed(0)}ms`);
      }
    }
  });

  it('classic and named fork bombs are still refused', () => {
    assertBlocked(':(){ :|:& };:', 'fork-bomb');
    assertBlocked(':(){:|:&};:', 'fork-bomb');
    assertBlocked('bomb(){ bomb|bomb& };bomb', 'fork-bomb');
    assertBlocked('f ( )  {  f | f &  } ;  f', 'fork-bomb');
    assertBlocked(`${'n'.repeat(200)}(){ ${'n'.repeat(200)}|${'n'.repeat(200)}& };${'n'.repeat(200)}`, 'fork-bomb');
    assertBlocked('echo hi; a.b(){ a.b|a.b& };a.b', 'fork-bomb');
    assertAllowed('foo(){ bar|bar& };foo');
  });

  it('variable doubling cannot exhaust memory; oversized values stay unknown', () => {
    let script = 'a0=xx';
    for (let i = 1; i <= 40; i += 1) script += `; a${i}="$a${i - 1}$a${i - 1}"`;
    const { result, ms } = timed(`${script}; rm -rf $a40`);
    assert.equal(result, null);
    assert.ok(ms < budgetMs(500), `took ${ms.toFixed(0)}ms`);
    assertAllowed(`${script}; echo $a40 $a40 $a40`);
    assertBlocked('d=/; e="$d$d"; rm -rf $e', 'rm-root');
    assertBlocked('r=rm; $r -rf /', 'rm-root');
  });

  it('resource exhaustion (deeply nested substitutions) does not throw or block', (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    const nested = `${'$('.repeat(3000)}echo${')'.repeat(3000)}`;
    assert.doesNotThrow(() => matchCommandHardline(nested));
    assert.equal(matchCommandHardline(nested), null);
    assert.ok(warn.mock.callCount() <= 1);
    assertBlocked('rm -rf /', 'rm-root');
  });

  describe('shell nesting depth', () => {
    const dq = (text) => `"${text.replace(/[\\"$`]/g, '\\$&')}"`;
    const nestShells = (layers, inner) => {
      let command = inner;
      for (let i = 0; i < layers; i += 1) command = `bash -c ${dq(command)}`;
      return command;
    };
    const nestEvals = (layers, inner) => {
      let command = inner;
      for (let i = 0; i < layers; i += 1) command = `eval ${dq(command)}`;
      return command;
    };

    it('refuses bash -c / eval nesting beyond the inspected depth', () => {
      for (const inner of ['ls', 'rm -rf /', 'echo hi']) {
        const match = matchCommandHardline(nestShells(10, inner));
        assert.equal(match?.ruleId, 'nesting-depth', inner);
        assert.match(match.reason, /嵌套 bash -c\/eval 超过 9 层，无法安全检查/);
      }
      assert.equal(matchCommandHardline(nestShells(12, 'ls'))?.ruleId, 'nesting-depth');
      assert.equal(matchCommandHardline(nestEvals(10, 'ls'))?.ruleId, 'nesting-depth');
      assert.equal(matchCommandHardline(nestEvals(10, 'rm -rf /'))?.ruleId, 'nesting-depth');
      assert.equal(matchCommandHardline(`sudo ${nestShells(10, 'ls')}`)?.ruleId, 'nesting-depth');
      assert.equal(matchCommandHardline(`echo start; ls && ${nestShells(10, 'ls')}`)?.ruleId, 'nesting-depth');
      const mixed = nestShells(5, nestEvals(5, 'ls'));
      assert.equal(matchCommandHardline(mixed)?.ruleId, 'nesting-depth');
    });

    it('still inspects every layer up to the limit', () => {
      for (const layers of [1, 2, 5, 8, 9]) {
        assertAllowed(nestShells(layers, 'ls'));
        assertAllowed(nestShells(layers, 'rm -rf ./build'));
        assertBlocked(nestShells(layers, 'rm -rf /'), 'rm-root');
        assertBlocked(nestShells(layers, 'reboot'), 'power');
      }
      for (const layers of [1, 5, 9]) {
        assertAllowed(nestEvals(layers, 'ls'));
        assertBlocked(nestEvals(layers, 'rm -rf /'), 'rm-root');
      }
      assertAllowed(nestShells(4, nestEvals(5, 'ls')));
      assertBlocked(nestShells(4, nestEvals(5, 'rm -rf /')), 'rm-root');
      assertAllowed("bash -c \"bash -c 'ls'\"");
      assertBlocked("bash -c \"bash -c 'rm -rf /'\"", 'rm-root');
      assertAllowed('sh -c "sh -c \\"sh -c \\\\\\"echo ok\\\\\\"\\""');
    });

    it('counts a chain, not the total number of shells', () => {
      const wide = Array.from({ length: 30 }, () => nestShells(3, 'ls')).join('; ');
      assertAllowed(wide);
      assertBlocked(`${wide}; ${nestShells(2, 'rm -rf /')}`, 'rm-root');
    });

    it('counts shells fed through pipes and heredocs', () => {
      let script = 'ls';
      for (let i = 0; i < 10; i += 1) script = `echo ${dq(script)} | bash`;
      assert.equal(matchCommandHardline(script)?.ruleId, 'nesting-depth');
    });

    it('function and alias expansion is not shell nesting', () => {
      assertAllowed('f() { g; }; g() { h; }; h() { i; }; i() { j; }; j() { k; }; k() { l; }; l() { m; }; m() { n; }; n() { o; }; o() { ls; }; f');
      assertAllowed('f() { f; }; f');
      assertAllowed('f() { eval f; }; true');
    });

    it('does not change the substitution-nesting resource exhaustion behaviour', (t) => {
      const warn = t.mock.method(console, 'warn', () => {});
      const nested = `${'$('.repeat(3000)}echo${')'.repeat(3000)}`;
      assert.equal(matchCommandHardline(nested), null);
      assert.ok(warn.mock.callCount() <= 1);
      assertAllowed(`echo ${'$('.repeat(5)}echo hi${')'.repeat(5)}`);
    });
  });

  describe('expansion caps', () => {
    const items = (n) => Array.from({ length: n }, (_, i) => `/tmp/d${i}`).join(' ');

    it('replays literal loops with up to 256 words and calls up to 128 functions', () => {
      assertBlocked(`for d in ${items(255)} /; do rm -rf "$d"; done`, 'rm-root');
      assertBlocked(`for d in ${items(100)} /home; do rm -rf "$d"; done`, 'rm-system-dir');
      assertAllowed(`for d in ${items(256)}; do rm -rf "$d"; done`);
      const calls = (n, last) => `f() { rm -rf "$1"; }; ${Array.from({ length: n }, () => 'f ./b').join('; ')}; f ${last}`;
      assertBlocked(calls(100, '/'), 'rm-root');
      assertBlocked(calls(126, '/'), 'rm-root');
    });

    it('lets commands through when a cap is exhausted (long literal lists in deploy scripts)', () => {
      // allow, not refuse: a deployment script with hundreds of literal paths is legitimate
      assertAllowed(`for d in ${items(300)} /; do rm -rf "$d"; done`);
      assertAllowed(`for d in ${items(400)}; do rm -rf "$d"; done`);
      const calls = (n, last) => `f() { rm -rf "$1"; }; ${Array.from({ length: n }, () => 'f ./b').join('; ')}; f ${last}`;
      assertAllowed(calls(200, '/'));
      const loop = (name, body) => `for ${name} in ${items(256)}; do ${body}; done`;
      assertAllowed(loop('a', loop('b', loop('c', 'rm -rf "$c"'))));
    });

    it('stays fast on huge inputs and doubling variables', () => {
      // CPU milliseconds, best of 3. A slow CI core measures ~150ms for the
      // 100k positional list; the budget only has to reject a seconds-scale blowup.
      const fastEnough = budgetMs(1000);
      const loop = timed(`for d in ${items(256)}; do rm -rf "$d"; done`);
      assert.equal(loop.result, null);
      assert.ok(loop.ms < fastEnough, `took ${loop.ms.toFixed(0)}ms`);
      const big = timed(`f() { rm -rf "$1"; }; ${Array.from({ length: 20_000 }, () => 'f ./b').join('; ')}`);
      assert.equal(big.result, null);
      assert.ok(big.ms < fastEnough, `took ${big.ms.toFixed(0)}ms`);
      const longPositional = timed(`f() { rm -rf "$@"; }; f ${'a '.repeat(100_000)}`);
      assert.equal(longPositional.result, null);
      assert.ok(longPositional.ms < fastEnough, `took ${longPositional.ms.toFixed(0)}ms`);
    });
  });

  it('unknown command substitutions stay unknown words instead of vanishing', () => {
    for (const command of [
      'cd $(mktemp -d) && rm -rf *',
      'cd `mktemp -d` && rm -rf *',
      'rm -rf $(pwd)/*',
      'rm -rf "$(mktemp -d)"/*',
      'rm -rf $(git rev-parse --show-toplevel)/*',
      'rm -rf $(pwd)/etc',
      'chmod -R 755 $(pwd)/*',
      'chown -R $(whoami) "$(pwd)"/',
      'rm -rf `pwd`/*',
      'rm -rf $(mktemp -d)',
      'cd <(echo x) && rm -rf *'
    ]) {
      assertAllowed(command);
    }
  });

  it('literal substitutions and real targets are still refused', () => {
    assertBlocked('rm -rf $(echo /)', 'rm-root');
    assertBlocked('rm -rf "$(echo /)"', 'rm-root');
    assertBlocked('rm -rf `echo /`', 'rm-root');
    assertBlocked('rm -rf $(echo /etc)', 'rm-system-dir');
    assertBlocked('cd $(echo /) && rm -rf *', 'rm-root');
    assertBlocked('rm -rf $(pwd) /', 'rm-root');
    assertBlocked('cd / && rm -rf $(pwd)x /*', 'rm-root');
    assertBlocked('cd && rm -rf *', 'rm-home');
  });

  it('read-only help and version queries of power / mkfs commands are allowed', () => {
    assertAllowed('shutdown --help');
    assertAllowed('reboot --help');
    assertAllowed('poweroff --version');
    assertAllowed('mkfs.ext4 --help');
    assertAllowed('mkfs.ext4 -V');
    assertAllowed('mke2fs --version');
    assertAllowed('mkfs --help');
    assertBlocked('shutdown -h now', 'power');
    assertBlocked('shutdown', 'power');
    assertBlocked('shutdown --help now', 'power');
    assertBlocked('mkfs.ext4 /dev/sda1', 'mkfs');
    assertBlocked('mkfs.ext4 -V /dev/sda1', 'mkfs');
    assertBlocked('mkfs -t ext4 /dev/sda1', 'mkfs');
  });

  it('chmod -R of home, mv of home, and root dotfile globs are refused', () => {
    assertBlocked('chmod -R 777 ~', 'recursive-perm');
    assertBlocked('chmod -R 777 $HOME', 'recursive-perm');
    assertBlocked('chmod -R a+rwx ~/', 'recursive-perm');
    assertBlocked('mv ~ /tmp', 'mv-system');
    assertBlocked('mv $HOME /tmp/home', 'mv-system');
    assertBlocked('rm -rf /.*', 'rm-root');
    assertBlocked('rm -rf /*.*', 'rm-root');
    assertBlocked('rm -rf /.[!.]*', 'rm-root');
    assertAllowed('chmod -R 755 ~');
    assertAllowed('chown -R me ~');
    assertAllowed('chmod -R 777 ~/project');
    assertAllowed('mv ~/file /tmp');
    assertAllowed('mv ~/a ~/b');
    assertAllowed('rm -rf /tmp/*.*');
    assertAllowed('rm -rf ./*.*');
  });
});

describe('command hardline execution gate', () => {
  it('bash and bg_run return a structured error before spawn, in bypass and auto mode [AC:command-hardline#AC-1] [AC:command-hardline#AC-2]', async () => {
    let started = 0;
    const tools = createBuiltinTools(
      stubServices({
        startBackgroundJob: async () => {
          started += 1;
          return { id: 'job-1', status: 'running' };
        }
      })
    );
    const bash = tools.find((tool) => tool.name === 'bash');
    const bg = tools.find((tool) => tool.name === 'bg_run');
    const dir = mkdtempSync(join(tmpdir(), 'hardline-bash-'));
    const canary = join(dir, 'canary');
    // bash really spawns when the guard is missing, so only use commands that are inert unguarded.
    const bashCommands = [
      'mkfs.ext4 /dev/hardline-nonexistent',
      'sudo mkfs.vfat /dev/hardline-nonexistent',
      'env mkfs /dev/hardline-nonexistent',
      `touch ${canary} && mkfs.ext4 /dev/hardline-nonexistent`,
      'echo x | sh -c "mkfs.ext4 /dev/hardline-nonexistent"',
      'm=mkfs.ext4; $m /dev/hardline-nonexistent',
      `touch ${canary} && m=mkfs.ext4 && $m /dev/hardline-nonexistent`
    ];
    // bg_run is stubbed here, so the full catastrophic set is safe to feed it.
    const bgCommands = [
      ...bashCommands,
      'rm -rf /',
      'r=rm; $r -rf /',
      'cd / && rm -rf .',
      'find / | xargs rm -rf',
      'sudo rm -rf ~',
      ':(){ :|:& };:',
      'kill -9 -1',
      'systemctl poweroff',
      'shutdown -h now'
    ];

    for (const mode of ['bypass', 'auto']) {
      const ctx = runContext(dir, mode);
      for (const [name, tool, commands] of [
        ['bash', bash, bashCommands],
        ['bg_run', bg, bgCommands]
      ]) {
        for (const command of commands) {
          const expected = matchCommandHardline(command);
          assert.ok(expected, command);
          const result = await tool.execute(ctx, { command });
          assert.equal(result.ok, false, `${name}/${mode}: ${command}`);
          const payload = JSON.parse(result.content);
          assert.equal(payload.error_code, HARDLINE_ERROR_CODE);
          assert.equal(payload.rule_id, expected.ruleId);
          assert.equal(result.metadata.hardline, true);
          assert.equal(result.metadata.ruleId, expected.ruleId);
        }
      }
    }
    assert.equal(started, 0, 'bg_run must not create a job for a blocked command');
    assert.equal(existsSync(canary), false, 'bash must not have spawned');

    const okJob = await bg.execute(runContext(dir, 'bypass'), { command: 'echo fine' });
    assert.equal(okJob.ok, true);
    assert.equal(started, 1, 'control: benign bg_run still starts a job');
  });

  it('still runs ordinary rm and echo [AC:command-hardline#AC-4]', async () => {
    const tools = createBuiltinTools(stubServices());
    const bash = tools.find((tool) => tool.name === 'bash');
    const dir = mkdtempSync(join(tmpdir(), 'hardline-allow-'));
    mkdirSync(join(dir, 'build'));
    writeFileSync(join(dir, 'build', 'out.txt'), 'x');
    const nested = join(dir, 'nested');
    mkdirSync(nested);
    writeFileSync(join(nested, 'leaf'), 'y');
    const ctx = runContext(dir, 'bypass');

    assertAllowed('echo hardline-ok');
    const echoed = await bash.execute(ctx, { command: 'echo hardline-ok' });
    assert.equal(echoed.ok, true, echoed.content);
    assert.match(echoed.content, /hardline-ok/);

    assertAllowed('rm -rf ./build');
    const removed = await bash.execute(ctx, { command: 'rm -rf ./build' });
    assert.equal(removed.ok, true, removed.content);
    assert.equal(existsSync(join(dir, 'build')), false);

    const rmTmp = `rm -rf ${nested}`;
    assertAllowed(rmTmp);
    const removedTmp = await bash.execute(ctx, { command: rmTmp });
    assert.equal(removedTmp.ok, true, removedTmp.content);
    assert.equal(existsSync(nested), false);
  });

  it('a secret env value printed by bash reaches the model redacted [AC:command-hardline#AC-5]', async (t) => {
    const name = 'ACCEPTANCE_FAKE_API_KEY';
    const secret = ['sk', 'acceptance', 'fake', 'value', '0123456789'].join('-');
    const previous = process.env[name];
    process.env[name] = secret;
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
    const bash = createBuiltinTools(stubServices()).find((tool) => tool.name === 'bash');
    const dir = mkdtempSync(join(tmpdir(), 'hardline-redact-'));
    const result = await bash.execute(runContext(dir, 'bypass'), { command: `printenv ${name}` });
    assert.equal(result.ok, true, result.content);
    assert.ok(!result.content.includes(secret), result.content);
    assert.match(result.content, new RegExp(`\\[REDACTED:${name}\\]`));
  });

  it('bash children do not inherit code-injection variables but keep HOME and PATH [AC:command-hardline#AC-6]', async (t) => {
    const injected = { NODE_OPTIONS: '--max-old-space-size=123', PROMPT_COMMAND: 'echo injected' };
    const previous = Object.fromEntries(Object.keys(injected).map((k) => [k, process.env[k]]));
    Object.assign(process.env, injected);
    t.after(() => {
      for (const [k, v] of Object.entries(previous)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
    const bash = createBuiltinTools(stubServices()).find((tool) => tool.name === 'bash');
    const dir = mkdtempSync(join(tmpdir(), 'hardline-env-'));
    const result = await bash.execute(runContext(dir, 'bypass'), {
      command: 'echo "opts=[${NODE_OPTIONS:-}] prompt=[${PROMPT_COMMAND:-}] home=[${HOME:+set}] path=[${PATH:+set}]"'
    });
    assert.equal(result.ok, true, result.content);
    assert.match(result.content, /opts=\[\] prompt=\[\] home=\[set\] path=\[set\]/);
  });

  it('startBackgroundJob throws before touching the store', async () => {
    assert.ok(matchCommandHardline('shutdown -h now'));
    await assert.rejects(
      () => startBackgroundJob({}, 'sid', 'shutdown -h now'),
      (err) => err instanceof CommandHardlineDeniedError && err.ruleId === 'power'
    );
  });

  it('SandboxManager refuses before spawn in direct, os, and auto modes', async () => {
    for (const mode of ['direct', 'os', 'auto', 'container']) {
      const dir = mkdtempSync(join(tmpdir(), `hardline-mgr-${mode}-`));
      const canary = join(dir, 'canary');
      const command = `touch ${canary} && mkfs.ext4`;
      assert.equal(matchCommandHardline(command)?.ruleId, 'mkfs', mode);
      const mgr = new SandboxManager(mode);
      const result = await mgr.execute(command, dir);
      assert.equal(result.code, 126, mode);
      assert.equal(result.tier, 0, mode);
      assert.equal(existsSync(canary), false, `${mode}: command must not have spawned`);
      const payload = JSON.parse(result.stderr);
      assert.equal(payload.error_code, HARDLINE_ERROR_CODE);
      assert.equal(payload.rule_id, 'mkfs');
    }
  });

  it('SandboxManager still runs benign commands (guard is not a blanket refusal)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hardline-mgr-ok-'));
    const result = await new SandboxManager('direct').execute('echo hardline-ok', dir);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /hardline-ok/);
  });

  it('cloudflare-computer backend never sends a hardline command over the wire', async () => {
    const hits = [];
    const server = createServer((req, res) => {
      hits.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ exitCode: 0, stdout: 'ran', stderr: '' }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const previous = process.env.CLOUDFLARE_COMPUTER_ENDPOINT;
    process.env.CLOUDFLARE_COMPUTER_ENDPOINT = `http://127.0.0.1:${address.port}`;
    try {
      const mgr = new SandboxManager('cloudflare-computer');
      assert.equal(mgr.activeProvider.name, 'cloudflare-computer');
      const denied = await mgr.execute('sudo mkfs.ext4 /dev/hardline-nonexistent', tmpdir(), { sessionId: 'hardline-cf' });
      assert.equal(denied.code, 126);
      assert.equal(JSON.parse(denied.stderr).rule_id, 'mkfs');
      assert.equal(hits.length, 0, 'blocked command must not reach the worker');

      const ok = await mgr.execute('echo hi', tmpdir(), { sessionId: 'hardline-cf' });
      assert.equal(ok.stdout, 'ran');
      assert.equal(hits.length, 1, 'control: benign command does reach the worker');
    } finally {
      if (previous === undefined) delete process.env.CLOUDFLARE_COMPUTER_ENDPOINT;
      else process.env.CLOUDFLARE_COMPUTER_ENDPOINT = previous;
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it('NativeAgentSandbox and env-created sandboxes refuse with kind and backend set', async () => {
    const native = new NativeAgentSandbox(() => 'direct');
    const nativeDenied = await native.execute({
      command: 'mkfs.ext4 /dev/hardline-nonexistent',
      cwd: tmpdir(),
      workspace: tmpdir(),
      timeoutMs: 2000
    });
    assert.equal(nativeDenied.code, 126);
    assert.equal(nativeDenied.kind, 'native');
    assert.equal(nativeDenied.backend, 'command-hardline');
    assert.equal(JSON.parse(nativeDenied.stderr).rule_id, 'mkfs');

    for (const kind of ['native', 'remote_vm', 'microservice']) {
      const sandbox = createAgentSandboxFromEnv({ RAW_AGENT_AGENT_SANDBOX_KIND: kind });
      const denied = await sandbox.execute({
        command: 'mkfs.ext4 /dev/hardline-nonexistent',
        cwd: tmpdir(),
        workspace: tmpdir(),
        timeoutMs: 2000
      });
      assert.equal(denied.code, 126, kind);
      assert.equal(denied.kind, kind);
      assert.equal(denied.backend, 'command-hardline');
    }
  });

  it('work_evidence verify_command cannot smuggle a hardline command', async () => {
    const tools = createBuiltinTools(stubServices());
    const tool = tools.find((t) => t.name === 'work_evidence');
    const dir = mkdtempSync(join(tmpdir(), 'hardline-evidence-'));
    const result = await tool.execute(runContext(dir, 'bypass'), { verify_command: 'sudo mkfs.ext4 /dev/hardline-nonexistent' });
    assert.equal(result.ok, false);
    const payload = JSON.parse(String(result.content).trim());
    assert.equal(payload.verify.exit_code, 126);
    assert.equal(payload.verify.sandbox_backend, 'command-hardline');
    assert.equal(JSON.parse(payload.verify.stderr_clip).error_code, HARDLINE_ERROR_CODE);
  });

  it('remote VM and microservice backends cannot skip the hardline', async () => {
    const hits = [];
    const server = createServer((req, res) => {
      hits.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ stdout: 'ran', stderr: '', code: 0 }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const remote = new RemoteVmAgentSandbox({ RAW_AGENT_SANDBOX_REMOTE_URL: base });
      const micro = new MicroserviceAgentSandbox({ RAW_AGENT_SANDBOX_RUNNER_URL: base });
      assert.ok(matchCommandHardline('rm -rf /'));
      const remoteDenied = await remote.execute({
        command: 'rm -rf /',
        cwd: '/tmp',
        workspace: '/tmp',
        timeoutMs: 2000
      });
      const microDenied = await micro.execute({
        command: 'mkfs.ext4',
        cwd: '/tmp',
        workspace: '/tmp',
        timeoutMs: 2000
      });
      assert.equal(remoteDenied.code, 126);
      assert.equal(remoteDenied.kind, 'remote_vm');
      assert.equal(remoteDenied.backend, 'command-hardline');
      assert.equal(JSON.parse(remoteDenied.stderr).rule_id, 'rm-root');
      assert.equal(microDenied.code, 126);
      assert.equal(microDenied.kind, 'microservice');
      assert.equal(microDenied.backend, 'command-hardline');
      assert.equal(JSON.parse(microDenied.stderr).rule_id, 'mkfs');
      assert.equal(hits.length, 0);

      const remoteOk = await remote.execute({
        command: 'echo hi',
        cwd: '/tmp',
        workspace: '/tmp',
        timeoutMs: 2000
      });
      assert.equal(remoteOk.stdout, 'ran');
      const microOk = await micro.execute({
        command: 'echo hi',
        cwd: '/tmp',
        workspace: '/tmp',
        timeoutMs: 2000
      });
      assert.equal(microOk.stdout, 'ran');
      assert.equal(hits.length, 2, 'control: benign commands reach both backends');
    } finally {
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
});

describe('command hardline before approval', () => {
  function makeDeps(tools) {
    const messages = [];
    const approvals = [];
    const traces = [];
    const deps = {
      tools,
      store: {
        appendMessage: (sessionId, role, parts) => messages.push({ sessionId, role, parts }),
        listApprovals: () => [],
        createApproval: (input) => {
          approvals.push(input);
          return { id: `appr-${approvals.length}`, ...input, status: 'pending' };
        },
        deleteApproval: () => {},
        getTask: () => undefined,
        updateTask: () => {}
      },
      envApprovalPolicy: undefined,
      maxParallelToolCalls: 1,
      modelAdapter: {},
      stateDir: tmpdir(),
      emitTrace: (sessionId, event) => traces.push({ sessionId, event })
    };
    return { deps, messages, approvals, traces };
  }

  function call(id, name, input) {
    return { type: 'tool_call', toolCallId: id, name, input };
  }

  const drivers = {
    checkToolApprovals: (deps, calls, ctx, session, tools) =>
      checkToolApprovals(deps, calls, ctx, undefined, session, tools),
    checkToolApprovalsForLoop: (deps, calls, ctx, session, tools) =>
      checkToolApprovalsForLoop(deps, calls, ctx, undefined, session, tools, undefined)
  };

  for (const [driverName, drive] of Object.entries(drivers)) {
    it(`${driverName}: ask mode refuses hardline commands with no pending approval [AC:command-hardline#AC-1]`, () => {
      const tools = createBuiltinTools(stubServices());
      const dir = mkdtempSync(join(tmpdir(), 'hardline-approval-'));
      const session = { id: 'sess-ask', metadata: { permissionMode: 'ask' } };
      const ctx = { ...runContext(dir, 'ask'), session };

      for (const [name, input] of [
        ['bash', { command: 'sudo rm -rf /' }],
        ['bash', { command: 'cat x > /dev/sda' }],
        ['bg_run', { command: 'shutdown -h now' }],
        ['work_evidence', { verify_command: 'mkfs.ext4 /dev/sdb' }]
      ]) {
        const { deps, messages, approvals, traces } = makeDeps(tools);
        const decision = drive(deps, [call('c1', name, input)], ctx, session, tools);
        assert.equal(decision, 'skip', `${name} ${JSON.stringify(input)}`);
        assert.equal(approvals.length, 0, 'no pending approval');
        assert.equal(messages.length, 1);
        assert.equal(messages[0].role, 'tool');
        const [part] = messages[0].parts;
        assert.equal(part.type, 'tool_result');
        assert.equal(part.toolCallId, 'c1');
        assert.equal(part.ok, false);
        const payload = JSON.parse(part.content);
        assert.equal(payload.error_code, HARDLINE_ERROR_CODE);
        assert.equal(part.problem.status, 403);
        assert.equal(traces[0].event.kind, 'command_hardline_denied');
        assert.equal(traces[0].event.payload.ruleId, payload.rule_id);
      }
    });

    it(`${driverName}: refuses in every permission mode, including bypass and auto [AC:command-hardline#AC-1] [AC:command-hardline#AC-2]`, () => {
      const tools = createBuiltinTools(stubServices());
      const dir = mkdtempSync(join(tmpdir(), 'hardline-approval-modes-'));
      for (const mode of ['ask', 'auto', 'acceptEdits', 'bypass']) {
        const session = { id: `sess-${mode}`, metadata: { permissionMode: mode } };
        const ctx = { ...runContext(dir, mode), session };
        const { deps, messages, approvals } = makeDeps(tools);
        const decision = drive(deps, [call('c1', 'bash', { command: 'rm -rf ~' })], ctx, session, tools);
        assert.equal(decision, 'skip', mode);
        assert.equal(approvals.length, 0, mode);
        assert.equal(JSON.parse(messages[0].parts[0].content).rule_id, 'rm-home', mode);
      }
    });

    it(`${driverName}: ordinary commands keep the original approval semantics`, () => {
      const tools = createBuiltinTools(stubServices());
      const dir = mkdtempSync(join(tmpdir(), 'hardline-approval-normal-'));

      const askSession = { id: 'sess-ask-ok', metadata: { permissionMode: 'ask' } };
      const askCtx = { ...runContext(dir, 'ask'), session: askSession };
      const ask = makeDeps(tools);
      const asked = drive(ask.deps, [call('c1', 'bash', { command: 'echo hi' })], askCtx, askSession, tools);
      assert.equal(asked, 'waiting');
      assert.equal(ask.approvals.length, 1);
      assert.equal(ask.approvals[0].toolName, 'bash');
      assert.equal(ask.messages.length, 0);

      for (const mode of ['bypass', 'auto']) {
        const session = { id: `sess-${mode}-ok`, metadata: { permissionMode: mode } };
        const ctx = { ...runContext(dir, mode), session };
        const run = makeDeps(tools);
        const decision = drive(run.deps, [call('c1', 'bash', { command: 'echo hi' })], ctx, session, tools);
        assert.equal(decision, 'proceed', mode);
        assert.equal(run.approvals.length, 0, mode);
        assert.equal(run.messages.length, 0, mode);
      }

      const auto = { id: 'sess-auto-risky', metadata: { permissionMode: 'auto' } };
      const autoCtx = { ...runContext(dir, 'auto'), session: auto };
      const risky = makeDeps(tools);
      const riskyDecision = drive(
        risky.deps,
        [call('c1', 'bash', { command: 'git push origin main' })],
        autoCtx,
        auto,
        tools
      );
      const expectRisky = tools.find((t) => t.name === 'bash').needsApproval(autoCtx, {
        command: 'git push origin main'
      });
      assert.equal(riskyDecision, expectRisky ? 'waiting' : 'proceed');
      assert.equal(risky.approvals.length, expectRisky ? 1 : 0);
    });

    it(`${driverName}: a hardline call pairs every sibling tool_call with a result`, () => {
      const tools = createBuiltinTools(stubServices());
      const dir = mkdtempSync(join(tmpdir(), 'hardline-approval-siblings-'));
      const session = { id: 'sess-sib', metadata: { permissionMode: 'ask' } };
      const ctx = { ...runContext(dir, 'ask'), session };
      const { deps, messages, approvals } = makeDeps(tools);
      const decision = drive(
        deps,
        [
          call('c1', 'bash', { command: 'echo hi' }),
          call('c2', 'bash', { command: 'reboot' }),
          call('c3', 'read_file', { path: 'a.txt' })
        ],
        ctx,
        session,
        tools
      );
      assert.equal(decision, 'skip');
      assert.equal(approvals.length, 0);
      const parts = messages[0].parts;
      assert.deepEqual(
        parts.map((p) => p.toolCallId),
        ['c1', 'c2', 'c3']
      );
      assert.equal(JSON.parse(parts[1].content).error_code, HARDLINE_ERROR_CODE);
      assert.equal(JSON.parse(parts[0].content).error_code, HARDLINE_SIBLING_SKIPPED_CODE);
      assert.equal(JSON.parse(parts[2].content).error_code, HARDLINE_SIBLING_SKIPPED_CODE);
      assert.ok(parts.every((p) => p.ok === false));
    });
  }

  it('only shell-running tools are inspected', () => {
    assert.equal(hardlineCommandOfToolCall('bash', { command: 'ls' }), 'ls');
    assert.equal(hardlineCommandOfToolCall('bg_run', { command: 'ls' }), 'ls');
    assert.equal(hardlineCommandOfToolCall('work_evidence', { verify_command: 'npm test' }), 'npm test');
    assert.equal(hardlineCommandOfToolCall('write_file', { command: 'rm -rf /' }), undefined);
    assert.equal(hardlineCommandOfToolCall('bash', undefined), undefined);
    assert.equal(hardlineCommandOfToolCall('bash', { command: 42 }), undefined);
  });

  it('write_file content mentioning a hardline command is not refused', () => {
    const tools = createBuiltinTools(stubServices());
    const dir = mkdtempSync(join(tmpdir(), 'hardline-approval-write-'));
    const session = { id: 'sess-write', metadata: { permissionMode: 'bypass' } };
    const ctx = { ...runContext(dir, 'bypass'), session };
    const { deps, messages } = makeDeps(tools);
    const decision = checkToolApprovals(
      deps,
      [call('c1', 'write_file', { path: 'notes.md', content: 'never run rm -rf /' })],
      ctx,
      undefined,
      session,
      tools
    );
    assert.equal(decision, 'proceed');
    assert.equal(messages.length, 0);
  });
});

it('hardline propagates unexpected scanner defects instead of treating them as resource exhaustion', () => {
  const defect = new Error('scanner defect');
  // Inject a scanner failure after the public trim guard has succeeded.
  const command = new Proxy(new String('echo safe'), {
    get(target, key) {
      if (key === 'trim') return () => 'echo safe';
      if (key === 'length') throw defect;
      return Reflect.get(target, key);
    }
  });
  assert.throws(() => matchCommandHardline(command), (error) => error === defect);
});
