import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import {
  PUBLIC_NPM_NAMES,
  PUBLIC_VERSION_FILES,
  assertPublishablePackage,
  buildPublishArgs,
  bumpSemver,
  emptyPublishAction,
  isNpmPublishTag,
  npmSupportsOidc,
  planPublicRelease,
  publishAuthMode,
  rewritePublicVersionPins,
  shouldPublishNpm,
  stripEmptyNpmAuth,
  withoutNpmTokens,
} from '../publish-npm-lib.mjs';
import { PUBLIC_PACKAGES, PUBLIC_PACK_FILES } from '../npm-artifacts.mjs';

const workflowPath = new URL('../../.github/workflows/publish-npm.yml', import.meta.url);
const workflowText = readFileSync(workflowPath, 'utf8');
const workflow = parse(workflowText);
const publishScript = readFileSync(new URL('../publish-npm-packages.mjs', import.meta.url), 'utf8');

test('普通 push 和 pull request 不会触发 npm 发布 [AC:npm-auto-publish#AC-1]', () => {
  assert.equal(workflow.on.push.branches, undefined);
  assert.equal(workflow.on.pull_request, undefined);
  assert.equal(workflow.on.pull_request_target, undefined);
  assert.equal(shouldPublishNpm({ eventName: 'push', refType: 'branch', refName: 'main' }), false);
  assert.equal(shouldPublishNpm({ eventName: 'pull_request', refType: 'branch', refName: 'main' }), false);
  assert.ok(workflow.on.workflow_dispatch);
  assert.deepEqual(workflow.on.release.types, ['released']);
});

test('发布使用 OIDC，不读取 NPM_TOKEN [AC:npm-auto-publish#AC-2]', () => {
  assert.equal(workflow.permissions['id-token'], 'write');
  assert.equal(workflow.jobs.publish.permissions['id-token'], 'write');
  assert.doesNotMatch(workflowText, /NPM_TOKEN/);
  assert.doesNotMatch(workflowText, /NODE_AUTH_TOKEN/);
  assert.match(workflowText, /npm@11\.12\.0/);
  assert.equal(publishAuthMode({ GITHUB_ACTIONS: 'true', NPM_TOKEN: 'secret' }), 'oidc');
  assert.equal(publishAuthMode({}), 'local');
  assert.equal(withoutNpmTokens({ NPM_TOKEN: 'a', NODE_AUTH_TOKEN: 'b', PATH: '/bin' }).PATH, '/bin');
  assert.equal('NPM_TOKEN' in withoutNpmTokens({ NPM_TOKEN: 'a', PATH: '/bin' }), false);
  assert.equal(npmSupportsOidc('11.5.1'), true);
  assert.equal(npmSupportsOidc('11.12.0'), true);
  assert.equal(npmSupportsOidc('10.9.2'), false);
  assert.equal(npmSupportsOidc('11.5.0'), false);
  assert.match(publishScript, /publishAuthMode/);
  assert.match(publishScript, /npmSupportsOidc/);
  assert.match(stripEmptyNpmAuth('//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}\nregistry=https://registry.npmjs.org/\n'), /^registry=/);
});

test('手动运行和 npm-v 正式 Release 才发布 [AC:npm-auto-publish#AC-3]', () => {
  assert.equal(shouldPublishNpm({ eventName: 'workflow_dispatch', prerelease: '', tagName: '' }), true);
  assert.equal(shouldPublishNpm({ eventName: 'release', prerelease: false, tagName: 'npm-v0.1.2' }), true);
  assert.equal(shouldPublishNpm({ eventName: 'release', prerelease: 'false', tagName: 'npm-v0.1.2' }), true);
  assert.equal(shouldPublishNpm({ eventName: 'release', prerelease: true, tagName: 'npm-v0.1.2' }), false);
  assert.equal(shouldPublishNpm({ eventName: 'release', prerelease: 'true', tagName: 'npm-v0.1.2' }), false);
  assert.equal(shouldPublishNpm({ eventName: 'release', prerelease: false, tagName: 'v0.1.2' }), false);
  assert.equal(shouldPublishNpm({ eventName: 'release', prerelease: false, tagName: 'desktop-v0.1.2' }), false);
  assert.equal(shouldPublishNpm({ eventName: 'push', prerelease: false, tagName: 'npm-v0.1.2' }), false);
  assert.equal(shouldPublishNpm({ eventName: 'push', refType: 'branch', refName: 'npm-v0.1.2' }), false);
  assert.equal(workflow.jobs.publish.needs.includes('release-gate'), true);
  assert.match(workflow.jobs.publish.if, /needs\.release-gate\.result == 'success'/);
  assert.equal(workflow.jobs['release-gate'].uses, './.github/workflows/release-gate.yml');
});

test('只允许两个已公开的包 [AC:npm-auto-publish#AC-4]', () => {
  assert.deepEqual(PUBLIC_PACKAGES, ['api-types', 'agent-loop']);
  assert.ok(PUBLIC_PACK_FILES.includes('SKILL.md'));
  const loopPkg = JSON.parse(readFileSync(new URL('../../packages/agent-loop/package.json', import.meta.url), 'utf8'));
  assert.ok(loopPkg.files.includes('SKILL.md'));
  assert.deepEqual(PUBLIC_NPM_NAMES, ['@mage-ai-lab/api-types', '@mage-ai-lab/agent-loop']);
  assert.deepEqual(
    assertPublishablePackage({ name: '@mage-ai-lab/agent-loop', version: '0.1.2' }),
    { name: '@mage-ai-lab/agent-loop', version: '0.1.2', tag: 'latest' },
  );
  assert.throws(
    () => assertPublishablePackage({ name: '@ppeng/agent-core', version: '0.1.0' }),
    /not in the public allowlist/,
  );
  assert.throws(
    () => assertPublishablePackage({ name: '@mage-ai-lab/api-types', version: '0.1.2', private: true }),
    /private package/,
  );
  assert.match(publishScript, /assertPublishablePackage/);
});

test('patch 在较高版本上递增，已存在的版本不再上传 [AC:npm-auto-publish#AC-5]', () => {
  assert.equal(bumpSemver('0.1.1', 'patch'), '0.1.2');
  assert.equal(bumpSemver('0.1.1', 'minor'), '0.2.0');
  assert.equal(bumpSemver('0.1.1', 'major'), '1.0.0');
  assert.deepEqual(
    planPublicRelease({
      versionType: 'patch',
      repoVersions: { 'api-types': '0.1.1', 'agent-loop': '0.1.1' },
      registryVersions: ['0.1.1', '0.1.1'],
    }),
    { version: '0.1.2', bump: true },
  );
  assert.deepEqual(
    planPublicRelease({
      versionType: 'patch',
      repoVersions: { 'api-types': '0.1.1', 'agent-loop': '0.1.1' },
      registryVersions: ['0.2.0', '0.1.1'],
    }),
    { version: '0.2.1', bump: true },
  );
  assert.deepEqual(
    planPublicRelease({
      versionType: 'republish',
      repoVersions: { 'api-types': '0.1.2', 'agent-loop': '0.1.2' },
      registryVersions: ['0.1.1', '0.1.1'],
    }),
    { version: '0.1.2', bump: false },
  );
  assert.equal(emptyPublishAction(0, 'fail'), 'fail');
  assert.equal(emptyPublishAction(0, 'skip'), 'ok');
  assert.equal(emptyPublishAction(1, 'fail'), 'publish');
  const args = buildPublishArgs('dist/pkg.tgz', 'latest', { provenance: true });
  assert.equal(args[0], 'publish');
  assert.ok(args[1].startsWith('/'));
  assert.ok(args.includes('--provenance'));
  assert.ok(args.includes('--access'));
  assert.ok(args.includes('public'));
  assert.ok(args.includes('--tag'));
  assert.ok(args.includes('latest'));
  const rewritten = rewritePublicVersionPins({
    dependencies: { '@ppeng/api-types': '0.1.1', jsonrepair: '^3.12.0' },
    packages: {
      'packages/api-types': { name: '@ppeng/api-types', version: '0.1.1' },
      'packages/core': { name: '@ppeng/agent-core', version: '0.1.0', dependencies: { '@ppeng/agent-loop': '0.1.1' } },
      'node_modules/encoding': { version: '0.1.13' },
    },
  }, '0.1.2');
  assert.equal(rewritten.dependencies['@ppeng/api-types'], '0.1.2');
  assert.equal(rewritten.dependencies.jsonrepair, '^3.12.0');
  assert.equal(rewritten.packages['packages/api-types'].version, '0.1.2');
  assert.equal(rewritten.packages['packages/core'].version, '0.1.0');
  assert.equal(rewritten.packages['packages/core'].dependencies['@ppeng/agent-loop'], '0.1.2');
  assert.equal(rewritten.packages['node_modules/encoding'].version, '0.1.13');

  const root = mkdtempSync(join(tmpdir(), 'npm-bump-'));
  try {
    for (const rel of PUBLIC_VERSION_FILES) {
      mkdirSync(join(root, rel, '..'), { recursive: true });
    }
    writeFileSync(join(root, 'packages/api-types/package.json'), JSON.stringify({ name: '@ppeng/api-types', version: '0.1.1' }, null, 2) + '\n');
    writeFileSync(join(root, 'packages/agent-loop/package.json'), JSON.stringify({
      name: '@ppeng/agent-loop', version: '0.1.1', dependencies: { '@ppeng/api-types': '0.1.1' },
    }, null, 2) + '\n');
    writeFileSync(join(root, 'packages/core/package.json'), JSON.stringify({
      name: '@ppeng/agent-core', version: '0.1.0', dependencies: { '@ppeng/agent-loop': '0.1.1', '@ppeng/api-types': '0.1.1' },
    }, null, 2) + '\n');
    writeFileSync(join(root, 'apps/web-console/package.json'), JSON.stringify({
      name: '@ppeng/agent-lab-web', version: '0.1.0', private: true, dependencies: { '@ppeng/api-types': '0.1.1' },
    }, null, 2) + '\n');
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify({
      packages: { 'packages/api-types': { name: '@ppeng/api-types', version: '0.1.1' } },
    }, null, 2) + '\n');
    const result = spawnSync(process.execPath, [
      'scripts/bump-public-packages.mjs',
      '--root', root,
      '--type', 'patch',
      '--registry-version', '0.1.1',
      '--registry-version', '0.1.1',
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(join(root, 'packages/agent-loop/package.json'), 'utf8')).version, '0.1.2');
    assert.equal(JSON.parse(readFileSync(join(root, 'packages/api-types/package.json'), 'utf8')).version, '0.1.2');
    assert.match(result.stdout, /0\.1\.2/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('推送 npm-v* tag 按已提交版本发布，已在 npm 上则跳过 [AC:npm-auto-publish#AC-6]', () => {
  assert.deepEqual(workflow.on.push.tags, ['npm-v*']);
  assert.equal(isNpmPublishTag('npm-v0.1.2'), true);
  assert.equal(isNpmPublishTag('v0.1.2'), false);
  assert.equal(isNpmPublishTag('desktop-v0.1.2'), false);
  assert.equal(isNpmPublishTag('npm-v'), false);
  assert.equal(shouldPublishNpm({ eventName: 'push', refType: 'tag', refName: 'npm-v0.1.2' }), true);
  assert.equal(shouldPublishNpm({ eventName: 'push', refType: 'tag', refName: 'v0.1.2' }), false);
  assert.equal(shouldPublishNpm({ eventName: 'push', refType: 'tag', refName: 'desktop-v0.1.2' }), false);
  assert.equal(shouldPublishNpm({ eventName: 'push', refType: 'branch', refName: 'main' }), false);
  const bump = workflow.jobs.publish.steps.find((step) => step.id === 'bump');
  assert.match(bump.if, /github\.event_name == 'workflow_dispatch'/);
  const publishStep = workflow.jobs.publish.steps.find((step) => step.name === 'Publish');
  assert.match(publishStep.env.NPM_PUBLISH_IF_EXISTS, /github\.event_name == 'push'/);
  assert.match(publishStep.env.NPM_PUBLISH_IF_EXISTS, /'skip'/);
  assert.match(publishStep.env.NPM_PUBLISH_DRY_RUN, /workflow_dispatch/);
  assert.equal(workflow.permissions['id-token'], 'write');
});
