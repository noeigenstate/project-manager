const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const APP_ID = 'local.projectgrid.desktop';
const APP_NAME = 'Project Grid';

function windowsAppId({ packaged, installed, profile }) {
  if (profile) return `${APP_ID}.test.${createHash('sha256').update(path.resolve(profile)).digest('hex').slice(0, 12)}`;
  if (!packaged) return `${APP_ID}.development`;
  return installed ? APP_ID : `${APP_ID}.portable`;
}

function materializeIcon(iconSource, userData) {
  const iconBytes = fs.readFileSync(iconSource);
  const iconFolder = path.join(userData, 'shell-icons');
  fs.mkdirSync(iconFolder, { recursive: true });
  const icon = path.join(iconFolder, `project-grid-${createHash('sha256').update(iconBytes).digest('hex').slice(0, 12)}.ico`);
  if (!fs.existsSync(icon)) fs.writeFileSync(icon, iconBytes);
  return icon;
}

function repairShortcuts({ shell, executable, iconSource, userData, programs, commonPrograms, desktop, commonDesktop, createDesktop = false }) {
  const changes = [], warnings = [];
  const icon = materializeIcon(iconSource, userData);
  const read = filename => { try { return shell.readShortcutLink(filename); } catch { return null; } };
  const same = (a, b) => typeof a === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  // Older development runs used the installed application's identity. Only
  // quarantine that exact identity on Electron shortcuts, leaving other apps alone.
  for (const [scope, folder] of [['user', programs], ['common', commonPrograms]]) {
    if (!folder) continue;
    const source = path.resolve(folder, 'Electron.lnk');
    const details = read(source);
    if (details?.appUserModelId !== APP_ID || path.basename(details.target || '').toLowerCase() !== 'electron.exe') continue;
    const backupFolder = path.resolve(userData, 'shortcut-backups');
    const backup = path.join(backupFolder, `Electron-${scope}-${Date.now()}.lnk`);
    if (path.dirname(source) !== path.resolve(folder) || path.dirname(backup) !== backupFolder) throw new Error('无效的快捷方式路径。');
    try { fs.mkdirSync(backupFolder, { recursive: true }); fs.copyFileSync(source, backup, fs.constants.COPYFILE_EXCL); fs.unlinkSync(source); changes.push({ action: 'quarantine-development-shortcut', source, backup }); }
    catch (error) { warnings.push(String(error.message)); }
  }
  const ensure = (filename, create) => {
    const exists = fs.existsSync(filename), previous = exists ? read(filename) : null;
    if (!exists && !create) return;
    if (exists && (!previous || previous.appUserModelId !== APP_ID && !same(previous.target, executable))) return;
    const wanted = { target: executable, cwd: path.dirname(executable), description: 'Project Grid 项目矩阵 · 多项目终端工作台', icon, iconIndex: 0, appUserModelId: APP_ID };
    if (previous && Object.entries(wanted).every(([key, value]) => previous[key] === value)) return;
    try {
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      if (!shell.writeShortcutLink(filename, exists ? 'update' : 'create', wanted)) throw new Error(`无法写入快捷方式：${filename}`);
      changes.push({ action: exists ? 'repair-shortcut' : 'create-shortcut', path: filename });
    } catch (error) { warnings.push(String(error.message)); }
  };
  ensure(path.join(programs, `${APP_NAME}.lnk`), true);
  if (commonPrograms) ensure(path.join(commonPrograms, `${APP_NAME}.lnk`), false);
  if (desktop) ensure(path.join(desktop, `${APP_NAME}.lnk`), createDesktop);
  if (commonDesktop) ensure(path.join(commonDesktop, `${APP_NAME}.lnk`), false);
  return { icon, changes, warnings };
}

module.exports = { APP_ID, APP_NAME, windowsAppId, materializeIcon, repairShortcuts };
