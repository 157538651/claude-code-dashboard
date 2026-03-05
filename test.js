const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

// 使用独立测试数据库
const testDbPath = path.join(__dirname, 'test.db');
process.env.DASHBOARD_DB = testDbPath;

const { app, server, db, idleCleanupTimer, hashPassword } = require('./server.js');

const TEST_PORT = 3999;
let baseUrl;
let adminToken;

before(async () => {
  await new Promise(resolve => server.listen(TEST_PORT, resolve));
  baseUrl = `http://localhost:${TEST_PORT}`;
  // 用 scrypt 哈希创建测试用户
  const hash = hashPassword('testpass1');
  db.prepare('INSERT OR REPLACE INTO users (username, hash, created_at) VALUES (?, ?, ?)').run('testuser', hash, Date.now());
});

after(async () => {
  db.prepare("DELETE FROM users WHERE username IN ('testuser', 'newuser_test', 'migrateuser')").run();
  db.prepare("DELETE FROM tokens WHERE username IN ('testuser', 'newuser_test', 'migrateuser')").run();
  if (idleCleanupTimer) clearInterval(idleCleanupTimer);
  await new Promise(resolve => server.close(resolve));
  db.close();
  // 清理测试数据库文件
  try { fs.unlinkSync(testDbPath); } catch {}
  try { fs.unlinkSync(testDbPath + '-wal'); } catch {}
  try { fs.unlinkSync(testDbPath + '-shm'); } catch {}
});

async function post(path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
}

async function get(path, token) {
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${path}`, { headers });
  return { status: res.status, data: await res.json() };
}

async function del(path, token) {
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${path}`, { method: 'DELETE', headers });
  return { status: res.status, data: await res.json() };
}

// ---- Auth ----

describe('Auth', () => {
  it('GET /api/auth/status returns hasUsers', async () => {
    const { status, data } = await get('/api/auth/status');
    assert.strictEqual(status, 200);
    assert.strictEqual(data.hasUsers, true);
  });

  it('POST /api/login succeeds with correct credentials', async () => {
    const { status, data } = await post('/api/login', { username: 'testuser', password: 'testpass1' });
    assert.strictEqual(status, 200);
    assert.ok(data.token);
    assert.strictEqual(data.username, 'testuser');
    adminToken = data.token;
  });

  it('POST /api/login fails with wrong password', async () => {
    const { status } = await post('/api/login', { username: 'testuser', password: 'wrong' });
    assert.strictEqual(status, 401);
  });

  it('POST /api/login fails with empty fields', async () => {
    const { status } = await post('/api/login', { username: '', password: '' });
    assert.strictEqual(status, 400);
  });

  it('POST /api/register rejects duplicate user', async () => {
    const { status } = await post('/api/register', { username: 'testuser', password: 'testpass1' });
    assert.strictEqual(status, 409);
  });

  it('POST /api/register rejects short password', async () => {
    const { status } = await post('/api/register', { username: 'newuser', password: '12' });
    assert.strictEqual(status, 400);
  });

  it('POST /api/register succeeds with valid credentials', async () => {
    const { status, data } = await post('/api/register', { username: 'newuser_test', password: 'pass1234' });
    assert.strictEqual(status, 200);
    assert.ok(data.token);
    assert.strictEqual(data.username, 'newuser_test');
  });

  it('POST /api/login migrates SHA256 password to scrypt', async () => {
    // 用旧 SHA256 格式创建用户
    const crypto = require('crypto');
    const oldHash = crypto.createHash('sha256').update('migrate123').digest('hex');
    db.prepare('INSERT OR REPLACE INTO users (username, hash, created_at) VALUES (?, ?, ?)').run('migrateuser', oldHash, Date.now());

    // 登录应成功并迁移密码
    const { status, data } = await post('/api/login', { username: 'migrateuser', password: 'migrate123' });
    assert.strictEqual(status, 200);
    assert.ok(data.token);

    // 验证密码已迁移为 scrypt 格式（包含 ':'）
    const user = db.prepare('SELECT hash FROM users WHERE username = ?').get('migrateuser');
    assert.ok(user.hash.includes(':'), 'password should be migrated to scrypt format');

    // 迁移后再次登录仍成功
    const { status: s2 } = await post('/api/login', { username: 'migrateuser', password: 'migrate123' });
    assert.strictEqual(s2, 200);
  });
});

// ---- Projects ----

describe('Projects', () => {
  it('GET /api/projects requires auth', async () => {
    const { status } = await get('/api/projects');
    assert.strictEqual(status, 401);
  });

  it('GET /api/projects returns array with auth', async () => {
    const { status, data } = await get('/api/projects', adminToken);
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(data));
  });
});

// ---- Sessions ----

describe('Sessions', () => {
  it('GET /api/sessions requires auth', async () => {
    const { status } = await get('/api/sessions');
    assert.strictEqual(status, 401);
  });

  it('GET /api/sessions returns array with auth', async () => {
    const { status, data } = await get('/api/sessions', adminToken);
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(data));
  });

  it('DELETE /api/sessions/nonexistent returns success (stale cleanup)', async () => {
    const { status, data } = await del('/api/sessions/nonexistent', adminToken);
    assert.strictEqual(status, 200);
    assert.strictEqual(data.success, true);
  });
});

// ---- Health ----

describe('Health', () => {
  it('GET /api/health requires auth', async () => {
    const { status } = await get('/api/health');
    assert.strictEqual(status, 401);
  });

  it('GET /api/health returns metrics with auth', async () => {
    const { status, data } = await get('/api/health', adminToken);
    assert.strictEqual(status, 200);
    assert.strictEqual(data.status, 'ok');
    assert.ok(typeof data.uptime === 'number');
    assert.ok(typeof data.sessions === 'number');
    assert.ok(typeof data.memory.rss === 'number');
    assert.ok(typeof data.memory.heap === 'number');
  });
});

// ---- Clone ----

describe('Clone', () => {
  it('POST /api/clone rejects invalid git URL', async () => {
    const { status, data } = await post('/api/clone', { url: 'not-a-url' }, adminToken);
    assert.strictEqual(status, 400);
    assert.ok(data.error);
  });

  it('POST /api/clone rejects empty URL', async () => {
    const { status } = await post('/api/clone', {}, adminToken);
    assert.strictEqual(status, 400);
  });
});
