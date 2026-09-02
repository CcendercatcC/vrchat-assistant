import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

const state = {
  level: LEVELS.info,
  dir: '',
  format: 'text',
  maxSize: 10 * 1024 * 1024,
  maxFiles: 5,
  console: true,
  color: 'auto',
  suppress: [],
  filePath: '',
  fileEnabled: false,
  closed: false,
  pid: process.pid,
};

function resolveDir() {
  if (process.env.VRC_MONITOR_LOG_DIR) {
    return path.resolve(process.env.VRC_MONITOR_LOG_DIR);
  }
  if (process.env.VRC_MONITOR_DIR) {
    return path.join(process.env.VRC_MONITOR_DIR, 'logs');
  }
  return path.join(path.dirname(process.cwd()), 'logs');
}

function parseLevel(value) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return LEVELS.info;
  const key = value.trim().toLowerCase();
  return LEVELS[key] ?? LEVELS.info;
}

function parseBool(value, defaultValue) {
  if (value === undefined || value === null) return defaultValue;
  const s = String(value).trim();
  if (s === '' || s === '0' || s.toLowerCase() === 'false') return false;
  return true;
}

function parseIntDefault(value, defaultValue) {
  if (value === undefined || value === null) return defaultValue;
  const n = parseInt(String(value), 10);
  return Number.isNaN(n) ? defaultValue : n;
}

function parseSuppress(value) {
  if (!value || String(value).trim() === '') return [];
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildConfig(options) {
  const envOrOpt = (envKey, optKey) => {
    if (options && optKey in options) return options[optKey];
    return process.env[envKey];
  };

  const dir = options && 'dir' in options ? options.dir : resolveDir();
  const formatRaw = envOrOpt('VRC_MONITOR_LOG_FORMAT', 'format');
  const colorRaw = envOrOpt('VRC_MONITOR_LOG_COLOR', 'color');

  return {
    level: parseLevel(options?.level ?? process.env.VRC_MONITOR_LOG_LEVEL),
    dir,
    format: formatRaw === 'json' ? 'json' : 'text',
    maxSize: parseIntDefault(
      envOrOpt('VRC_MONITOR_LOG_MAX_SIZE', 'maxSize'),
      10 * 1024 * 1024
    ),
    maxFiles: parseIntDefault(
      envOrOpt('VRC_MONITOR_LOG_MAX_FILES', 'maxFiles'),
      5
    ),
    console: parseBool(
      envOrOpt('VRC_MONITOR_LOG_CONSOLE', 'console'),
      true
    ),
    color:
      colorRaw === 'auto' || colorRaw === undefined || colorRaw === null
        ? 'auto'
        : parseBool(colorRaw, false),
    suppress: parseSuppress(
      envOrOpt('VRC_MONITOR_LOG_SUPPRESS', 'suppress')
    ),
  };
}

export function initLogger(options = {}) {
  const cfg = buildConfig(options);

  state.level = cfg.level;
  state.dir = cfg.dir;
  state.format = cfg.format;
  state.maxSize = cfg.maxSize;
  state.maxFiles = cfg.maxFiles;
  state.console = cfg.console;
  state.color = cfg.color;
  state.suppress = cfg.suppress;
  state.filePath = path.join(state.dir, 'monitor.log');
  state.fileEnabled = true;
  state.closed = false;
  state.pid = process.pid;

  try {
    fs.mkdirSync(state.dir, { recursive: true });
    const testPath = path.join(state.dir, '.init-test');
    fs.writeFileSync(testPath, '');
    fs.unlinkSync(testPath);
  } catch (err) {
    state.fileEnabled = false;
    state.filePath = '';
    if (state.console) {
      console.warn(
        `[logger] 日志目录不可写，已降级为仅 console: ${err.message}`
      );
    }
  }

  return state;
}

function isOutputEnabled(level) {
  return level >= state.level;
}

function shouldSuppress(msg) {
  if (!state.suppress.length) return false;
  return state.suppress.some((sub) => msg.includes(sub));
}

export function redactSecrets(text) {
  if (typeof text !== 'string') return text;

  let out = text;

  out = out.replace(
    /((?:authToken|authorization|cookie|set-cookie))(\s*[:=]\s*)([^\s,;"']+)/gi,
    '$1$2[REDACTED]'
  );

  out = out.replace(
    /((?:password|passwd|pwd|secret|token))(\s*[:=]\s*)([^\s,;"']+)/gi,
    '$1$2[REDACTED]'
  );

  out = out.replace(
    /((?:smtp|imap|授权码|authcode))(\s*[:=:：]\s*)(\S+)/gi,
    '$1$2[REDACTED]'
  );

  out = out.replace(/(auth=)([^\s,;"']+)/gi, '$1[REDACTED]');
  out = out.replace(/(apiKey=)([^\s,;"']+)/gi, '$1[REDACTED]');

  out = out.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[REDACTED]');

  return out;
}

function formatText(ts, levelName, name, msg) {
  const upper = levelName.toUpperCase().padEnd(5);
  return `${ts} ${upper} [${name}] ${msg}`;
}

function formatJson(ts, levelName, name, msg, meta) {
  const obj = {
    ts,
    level: levelName.toLowerCase(),
    name,
    msg,
    pid: state.pid,
  };
  if (meta && typeof meta === 'object') {
    for (const [key, value] of Object.entries(meta)) {
      if (!(key in obj)) {
        obj[key] = value;
      }
    }
  }
  return JSON.stringify(obj);
}

function applyColor(line, levelName) {
  const reset = '\x1b[0m';
  switch (levelName.toLowerCase()) {
    case 'debug':
      return `\x1b[90m${line}${reset}`;
    case 'info':
      return `\x1b[32m${line}${reset}`;
    case 'warn':
      return `\x1b[33m${line}${reset}`;
    case 'error':
      return `\x1b[31m${line}${reset}`;
    default:
      return line;
  }
}

function writeToConsole(levelName, line) {
  if (!state.console) return;

  let output = line;
  const useColor =
    state.color === true ||
    (state.color === 'auto' && process.stdout.isTTY && state.format === 'text');
  if (useColor) {
    output = applyColor(line, levelName);
  }

  switch (levelName) {
    case 'debug':
      console.debug(output);
      break;
    case 'info':
      console.info(output);
      break;
    case 'warn':
      console.warn(output);
      break;
    case 'error':
      console.error(output);
      break;
    default:
      console.log(output);
  }
}

function cleanupOldLogs() {
  try {
    const files = fs.readdirSync(state.dir);
    const gzFiles = files
      .filter((f) => f.endsWith('.log.gz'))
      .map((f) => {
        const full = path.join(state.dir, f);
        return { name: f, path: full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => a.mtime - b.mtime);

    while (gzFiles.length > state.maxFiles) {
      const oldest = gzFiles.shift();
      try {
        fs.unlinkSync(oldest.path);
      } catch {
        // ignore cleanup errors
      }
    }
  } catch {
    // ignore cleanup errors
  }
}

function doRotate() {
  if (!state.fileEnabled || !fs.existsSync(state.filePath)) return;

  const now = new Date();
  const ts = now.toISOString().replace(/[-:T]/g, '').replace(/\.\d{3}Z$/, '');
  const rotatedName = `monitor-${ts}-${state.pid}.log`;
  const rotatedPath = path.join(state.dir, rotatedName);

  try {
    fs.renameSync(state.filePath, rotatedPath);
  } catch (err) {
    if (err && (err.code === 'EPERM' || err.code === 'EBUSY')) {
      const warnLine = `${new Date().toISOString()} WARN  [logger] 轮转失败，跳过本次: ${err.message}`;
      if (state.console) console.warn(warnLine);
      return;
    }
    throw err;
  }

  try {
    const data = fs.readFileSync(rotatedPath);
    const gz = zlib.gzipSync(data);
    fs.writeFileSync(`${rotatedPath}.gz`, gz);
    fs.unlinkSync(rotatedPath);
    cleanupOldLogs();
  } catch {
    // gzip failed: keep uncompressed rotated file
  }
}

function checkRotation(line) {
  if (!state.fileEnabled || !fs.existsSync(state.filePath)) return;
  const stats = fs.statSync(state.filePath);
  const lineBytes = Buffer.byteLength(line, 'utf8');
  if (stats.size + lineBytes > state.maxSize) {
    doRotate();
  }
}

function write(levelName, name, msg, meta) {
  if (state.closed) return;

  const rawMsg = typeof msg === 'string' ? msg : String(msg);
  if (shouldSuppress(rawMsg)) return;

  const levelValue = LEVELS[levelName] ?? LEVELS.info;
  if (!isOutputEnabled(levelValue)) return;

  const ts = new Date().toISOString();
  const redactedMsg = redactSecrets(rawMsg);

  let line;
  if (state.format === 'json') {
    const safeMeta = {};
    if (meta && typeof meta === 'object') {
      for (const [key, value] of Object.entries(meta)) {
        safeMeta[key] = typeof value === 'string' ? redactSecrets(value) : value;
      }
    }
    line = formatJson(ts, levelName, name, redactedMsg, safeMeta);
  } else {
    line = formatText(ts, levelName, name, redactedMsg);
  }

  writeToConsole(levelName, line);

  if (state.fileEnabled && state.filePath) {
    try {
      checkRotation(line);
      fs.appendFileSync(state.filePath, `${line}\n`, 'utf8');
    } catch (err) {
      if (state.console) {
        console.error(`[logger] 写入日志文件失败: ${err.message}`);
      }
    }
  }
}

export const logger = {
  debug(msg, meta) { write('debug', 'app', msg, meta); },
  info(msg, meta) { write('info', 'app', msg, meta); },
  warn(msg, meta) { write('warn', 'app', msg, meta); },
  error(msg, meta) { write('error', 'app', msg, meta); },
};

export function getLogger(name) {
  const n = String(name ?? 'app');
  return {
    debug(msg, meta) { write('debug', n, msg, meta); },
    info(msg, meta) { write('info', n, msg, meta); },
    warn(msg, meta) { write('warn', n, msg, meta); },
    error(msg, meta) { write('error', n, msg, meta); },
    name: n,
  };
}

export function setLevel(level) {
  state.level = parseLevel(level);
}

export function rotate() {
  doRotate();
}

export function closeLogger() {
  state.closed = true;
  state.fileEnabled = false;
  state.console = false;
}

initLogger();
