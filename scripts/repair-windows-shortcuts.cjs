const { app, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { repairShortcuts } = require('../electron/windows-integration.cjs');
const executable = process.argv[process.argv.indexOf('--installed-exe') + 1];
if (!process.argv.includes('--installed-exe') || typeof executable !== 'string' || !path.isAbsolute(executable) || path.basename(executable).toLowerCase() !== 'project grid.exe' || !fs.existsSync(executable) || !fs.existsSync(path.join(path.dirname(executable), 'Uninstall Project Grid.exe'))) throw new Error('请指定已安装的 Project Grid.exe。');
app.setPath('userData', fs.mkdtempSync(path.join(app.getPath('temp'), 'project-grid-shortcut-repair-')));
app.setAppUserModelId('local.projectgrid.maintenance');
app.whenReady().then(() => {
  const result = repairShortcuts({ shell, executable, iconSource: path.resolve(__dirname, '../assets/icon.ico'), userData: path.join(app.getPath('appData'), 'Project Grid'),
    programs: path.join(app.getPath('appData'), 'Microsoft/Windows/Start Menu/Programs'),
    commonPrograms: process.env.ProgramData ? path.join(process.env.ProgramData, 'Microsoft/Windows/Start Menu/Programs') : null,
    desktop: app.getPath('desktop'), commonDesktop: process.env.PUBLIC ? path.join(process.env.PUBLIC, 'Desktop') : null, createDesktop: true,
  });
  console.log(JSON.stringify(result));
  execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/ie4uinit.exe'), ['-show'], { windowsHide: true, timeout: 5000 }, () => app.exit(result.warnings.length ? 1 : 0));
}).catch(error => { console.error(error); app.exit(1); });
