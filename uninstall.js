const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const DEFAULTS = {
  deployPath: path.join(process.env.LOCALAPPDATA || '', 'init'),
  registryScope: 'HKCU',
  regName: 'InitTask',
};

function expandEnv(p) {
  return String(p).replace(/%([^%]+)%/g, (_, name) => process.env[name] ?? `%${name}%`);
}

function loadUninstallConfig() {
  const cfg = { ...DEFAULTS };
  const candidates = [
    path.join(__dirname, 'config.json'),
    path.join(__dirname, 'cedar-map.json'),
    path.join(cfg.deployPath, 'config.json'),
  ];

  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw.deployPath) cfg.deployPath = path.resolve(expandEnv(raw.deployPath));
      if (raw.registryScope) cfg.registryScope = String(raw.registryScope).toUpperCase();
      if (raw.regName) cfg.regName = raw.regName;
    } catch {}
  }

  cfg.deployPath = path.resolve(expandEnv(cfg.deployPath));
  return cfg;
}

function getRegistryRunKey(scope) {
  const s = String(scope || 'HKCU').toUpperCase();
  if (s !== 'HKCU' && s !== 'HKLM') return null;
  return `${s}\\Software\\Microsoft\\Windows\\CurrentVersion\\Run`;
}

function isUnsafeDeletePath(dirPath) {
  const normalized = path.resolve(dirPath).replace(/\//g, '\\');
  return /^[A-Za-z]:\\?$/.test(normalized);
}

function removeRegistryRun(scope, regName) {
  const regKey = getRegistryRunKey(scope);
  if (!regKey || !regName) {
    return false;
  }
  try {
    execSync(`reg delete "${regKey}" /v "${regName}" /f`, {
      stdio: 'ignore',
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function scheduleDeployFolderDelete(deployPath) {
  if (isUnsafeDeletePath(deployPath)) {
    return false;
  }
  if (!fs.existsSync(deployPath)) {
    return true;
  }

  const cleanupVbs = path.join(
    process.env.TEMP || process.env.TMP || '.',
    `init-cleanup-${Date.now()}.vbs`
  );
  const q = (s) => String(s).replace(/"/g, '""');
  const vbsBody = [
    'Option Explicit',
    'WScript.Sleep 6000',
    'On Error Resume Next',
    'Dim fso',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    `If fso.FolderExists("${q(deployPath)}") Then fso.DeleteFolder "${q(deployPath)}", True`,
    'fso.DeleteFile WScript.ScriptFullName, True',
    '',
  ].join('\r\n');

  try {
    fs.writeFileSync(cleanupVbs, vbsBody, 'utf8');
    const wscript = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');
    const child = spawn(wscript, ['//B', '//Nologo', cleanupVbs], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function main() {
  if (process.platform !== 'win32') {
    return;
  }

  try {
    const cfg = loadUninstallConfig();
    removeRegistryRun(cfg.registryScope, cfg.regName);
    scheduleDeployFolderDelete(cfg.deployPath);
  } catch {}
}

try {
  main();
} catch {}
