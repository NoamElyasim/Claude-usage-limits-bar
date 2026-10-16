// electron-builder afterPack hook: re-signs the macOS app before it is put in
// the .dmg.
//
// There is no Apple certificate, so electron-builder leaves signing alone —
// but then the app keeps the signature Electron's own binaries shipped with,
// which Apple has since revoked for this Electron line. macOS kills a binary
// carrying a revoked signature on launch (and XProtect deletes it), so an
// unsigned build simply does not open. An ad-hoc signature replaces it.
//
// MAC_SIGN_IDENTITY picks a real identity instead (a keychain certificate name).
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const identity = process.env.MAC_SIGN_IDENTITY || '-';
  execFileSync('codesign', ['--force', '--deep', '-s', identity, appPath], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
};
