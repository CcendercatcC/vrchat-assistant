/**
 * test/logger.test.mjs — 日志模块 core/logger.js 单元测试（node:test，零新 dev 依赖）
 *
 * 覆盖：级别过滤、json 格式键、脱敏（authToken/cookie/邮箱/password/授权码）、
 *       轮转触发与 gz 可读、suppress 子串过滤、命名子 logger 标签。
 * 自包含：临时目录，不依赖真实凭据。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..');

const { initLogger, getLogger, getLevelName, redactSecrets, setLevel, LEVELS } =
  await import(pathToFileURL(path.join(REPO, 'core', 'logger.js')).href);

let dir;
before(() => {
  dir = path.join(__dirname, 'logger-test-rundir');
  rmSync(dir, { recursive: true, force: true });
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('脱敏：authToken/cookie/邮箱/password/授权码 全部替换且零泄漏', () => {
  const out = redactSecrets(
    'authToken=abc123 cookie=xyz456 email=user@qq.com password=hunter2 smtp=mysecret'
  );
  assert.ok(!out.includes('abc123'), 'authToken 值不得泄漏');
  assert.ok(!out.includes('xyz456'), 'cookie 值不得泄漏');
  assert.ok(!out.includes('user@qq.com'), '邮箱不得泄漏');
  assert.ok(!out.includes('hunter2'), '密码不得泄漏');
  assert.ok(!out.includes('mysecret'), '授权码不得泄漏');
  assert.equal(out.match(/\[REDACTED\]/g)?.length, 5, '应有 5 处 [REDACTED]');
});

test('级别过滤：info 级别隐藏 debug，setLevel(debug) 后可见', () => {
  const d = path.join(dir, 'level');
  initLogger({ dir: d, format: 'text' });
  setLevel('info');
  const w = getLogger('app');
  w.info('visible info');
  w.debug('hidden debug');
  setLevel('debug');
  w.debug('now visible');
  const content = readFileSync(path.join(d, 'monitor.log'), 'utf8');
  assert.ok(content.includes('visible info'), 'info 应写入');
  assert.ok(!content.includes('hidden debug'), 'info 级下 debug 应隐藏');
  assert.ok(content.includes('now visible'), 'debug 级下 debug 应写入');
});

test('json 格式：每行合法 JSON，固定键 ts/level/name/msg/pid', () => {
  const d = path.join(dir, 'json');
  initLogger({ dir: d, format: 'json' });
  getLogger('api').info('hello', { worldId: 'wrld_x' });
  const lines = readFileSync(path.join(d, 'monitor.log'), 'utf8')
    .trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1, '应只有一行 JSONL');
  const obj = JSON.parse(lines[0]);
  assert.ok(typeof obj.ts === 'string' && obj.ts.includes('T'), 'ts 应为 ISO 时间');
  assert.equal(obj.level, 'info', 'level 应小写 info');
  assert.equal(obj.name, 'api', 'name 应为命名标签');
  assert.equal(obj.msg, 'hello', 'msg 应为正文');
  assert.ok(typeof obj.pid === 'number', 'pid 应为数字');
  assert.equal(obj.worldId, 'wrld_x', 'meta 应并入顶层');
});

test('命名子 logger：输出带组件标签', () => {
  const d = path.join(dir, 'named');
  initLogger({ dir: d, format: 'text' });
  getLogger('ws').info('conn ok');
  const content = readFileSync(path.join(d, 'monitor.log'), 'utf8');
  assert.ok(content.includes('[ws]'), '应带 [ws] 标签');
});

test('轮转：达到 maxSize 触发，gz 可读且命名含 UTC 时间戳+pid', () => {
  const d = path.join(dir, 'rotate');
  initLogger({ dir: d, format: 'text', maxSize: 2048, maxFiles: 3 });
  const l = getLogger('app');
  for (let i = 0; i < 150; i++) l.info('pad '.repeat(40) + i);
  const files = readdirSync(d);
  const gzs = files.filter((f) => f.endsWith('.gz'));
  assert.ok(gzs.length >= 1 && gzs.length <= 3, `gz 数 ${gzs.length} 应在 1-3`);
  assert.ok(files.includes('monitor.log'), '活跃文件应存在');
  for (const gz of gzs) {
    assert.match(gz, /^monitor-\d{8}-\d{6}-\d+\.log\.gz$/, '文件名应 YYYYMMDD-HHMMSS-pid');
    const buf = zlib.gunzipSync(readFileSync(path.join(d, gz))).toString();
    assert.ok(buf.trim().length > 0, 'gz 内容非空');
  }
});

test('suppress：命中子串的消息整条丢弃', () => {
  const d = path.join(dir, 'suppress');
  initLogger({ dir: d, format: 'text', suppress: ['ping', 'keepalive'] });
  const l = getLogger('mcp');
  l.info('ping request here');
  l.info('keepalive tick');
  l.info('normal event');
  const content = readFileSync(path.join(d, 'monitor.log'), 'utf8');
  assert.ok(!content.includes('ping request'), 'ping 应被 suppress');
  assert.ok(!content.includes('keepalive tick'), 'keepalive 应被 suppress');
  assert.ok(content.includes('normal event'), '正常事件应保留');
});

test('getLevelName：数字转人类可读级别名', () => {
  assert.equal(getLevelName(LEVELS.info), 'info');
  assert.equal(getLevelName(LEVELS.warn), 'warn');
  assert.equal(getLevelName(LEVELS.debug), 'debug');
  assert.equal(getLevelName(LEVELS.error), 'error');
  assert.equal(getLevelName(10), 'debug');
});
