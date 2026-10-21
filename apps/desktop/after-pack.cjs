'use strict';

const { execFileSync } = require('node:child_process');
const { join } = require('node:path');
const { writeFileSync } = require('node:fs');
const { adHocCodesignArgs } = require('../../scripts/lib/desktop-mac-sign.cjs');

/**
 * electron-builder `identity: null` leaves Electron's broken signature.
 * macOS then reports the app as damaged. Ad-hoc sign after pack.
 */
module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  writeFileSync(join(appPath, 'Contents/Resources/desktop-update.json'), JSON.stringify({
    protocol: 1, platform: 'darwin', arch: 'arm64',
    version: context.packager.appInfo.version, buildId: new Date().toISOString(),
    notes: 'Local build / 本机构建：仅在独立环境验证通过后选择此版本更新。'
  }, null, 2));
  execFileSync('codesign', adHocCodesignArgs(appPath), { stdio: 'inherit' });
};
