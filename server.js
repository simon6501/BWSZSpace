const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { DatabaseSync, backup } = require('node:sqlite');

loadEnv();

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const ASSETS_DIR = path.join(ROOT, 'assests');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const DB_FILE = path.join(DATA_DIR, 'bwsz-space.sqlite');
const STATE_FILE = path.join(DATA_DIR, 'app-state.json'); // legacy mirror for easy inspection
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const PORT = Number(process.env.PORT || 3077);
const HOST = process.env.HOST || '127.0.0.1';
const DEFAULT_SESSION_SECRET = 'local-dev-session-secret-change-before-public';
const SESSION_SECRET = process.env.SESSION_SECRET || DEFAULT_SESSION_SECRET;
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const MAX_BODY_BYTES = 1024 * 1024 * 2;
const LOGIN_DISABLED = String(process.env.LOGIN_DISABLED || 'true').toLowerCase() !== 'false';
const LOGIN_WINDOW_MS = 1000 * 60 * 15;
const LOGIN_MAX_ATTEMPTS = 10;
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' https://www.gstatic.com",
  "connect-src 'self' https://*.googleapis.com https://*.firebaseio.com https://*.firestore.googleapis.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com"
].join('; ');

let db;
const sessions = new Map();
const loginAttempts = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

async function main() {
  validateRuntimeSecurity();
  await ensureStorage();
  const server = http.createServer(handleRequest);
  server.on('error', (error) => {
    console.error(`Failed to start BW&SZ's space on ${HOST}:${PORT}: ${error.message}`);
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    console.log(`BW&SZ's space is running at http://${HOST}:${PORT}`);
    console.log(`Local database: ${DB_FILE}`);
    console.log(`Auto backup: ${path.join(BACKUP_DIR, 'bwsz-space-latest.sqlite')}`);
    if (LOGIN_DISABLED) console.log('Login is currently disabled. Set LOGIN_DISABLED=false to enable password login again.');
  });
}

async function ensureStorage() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(BACKUP_DIR, { recursive: true });
  db = new DatabaseSync(DB_FILE);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS backup_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reason TEXT NOT NULL,
      file_path TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get('app_state');
  if (!row) {
    const initial = fs.existsSync(STATE_FILE)
      ? normalizeState(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')))
      : seedState();
    await writeState(initial, 'init');
  } else {
    await writeState(normalizeState(JSON.parse(row.value)), 'migrate');
  }

  await ensureUsers();
}

async function handleRequest(req, res) {
  setBaseHeaders(res);
  if (req.method === 'OPTIONS') return sendNoContent(res);

  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(url.pathname);

    if (pathname === '/api/health' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, name: "BW&SZ's space", database: 'sqlite', time: new Date().toISOString() });
    }
    if (pathname === '/api/auth/login' && req.method === 'POST') return login(req, res);
    if (pathname === '/api/auth/logout' && req.method === 'POST') return logout(req, res);
    if (pathname === '/api/auth/me' && req.method === 'GET') return me(req, res);

    if (pathname.startsWith('/api/')) {
      const auth = await requireAuth(req, res);
      if (!auth) return;

      if (pathname === '/api/state' && req.method === 'GET') return sendJson(res, 200, readState());
      if (pathname === '/api/state' && req.method === 'PUT') return updateState(req, res);
      if (pathname === '/api/modules' && req.method === 'GET') return sendJson(res, 200, readState().modules || []);
      if (pathname === '/api/backups' && req.method === 'GET') return sendJson(res, 200, listBackups());

      const moduleMatch = pathname.match(/^\/api\/modules\/([a-z0-9-]+)$/i);
      if (moduleMatch && req.method === 'GET') return getModule(res, moduleMatch[1]);
      if (moduleMatch && req.method === 'PUT') return updateModule(req, res, moduleMatch[1]);

      return sendJson(res, 404, { error: 'API_NOT_FOUND' });
    }

    if (pathname.startsWith('/assests/')) return serveAsset(req, res, pathname);
    return serveStatic(req, res, pathname);
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, { error: 'SERVER_ERROR', message: '服务器暂时没有处理成功。' });
  }
}

async function login(req, res) {
  if (LOGIN_DISABLED) return sendJson(res, 200, { ...publicUser(await getLocalUser()), loginDisabled: true });
  const limiterKey = clientKey(req);
  if (isLoginLimited(limiterKey)) {
    return sendJson(res, 429, { error: 'TOO_MANY_ATTEMPTS', message: '登录尝试过多，请稍后再试。' });
  }
  const body = await readBody(req);
  const { username, password } = body || {};
  if (!username || !password) return sendJson(res, 400, { error: 'MISSING_CREDENTIALS', message: '请输入用户名和密码。' });

  const { users } = await readUsers();
  const user = users.find((item) => item.username === String(username).trim());
  if (!user || !(await verifyPassword(password, user.password))) {
    recordLoginFailure(limiterKey);
    return sendJson(res, 401, { error: 'INVALID_CREDENTIALS', message: '用户名或密码不正确。' });
  }

  loginAttempts.delete(limiterKey);
  const token = signToken(crypto.randomBytes(32).toString('base64url'));
  sessions.set(token, { userId: user.id, expiresAt: Date.now() + SESSION_TTL_MS });
  res.setHeader('Set-Cookie', cookie('bwsz_session', token, { httpOnly: true, sameSite: 'Lax', maxAge: SESSION_TTL_MS / 1000 }));
  return sendJson(res, 200, publicUser(user));
}

async function logout(req, res) {
  const token = getCookie(req, 'bwsz_session');
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', cookie('bwsz_session', '', { httpOnly: true, sameSite: 'Lax', maxAge: 0 }));
  return sendJson(res, 200, { ok: true });
}

async function me(req, res) {
  if (LOGIN_DISABLED) return sendJson(res, 200, { ...publicUser(await getLocalUser()), loginDisabled: true });
  const auth = await getAuthUser(req);
  if (!auth) return sendJson(res, 401, { error: 'UNAUTHENTICATED' });
  return sendJson(res, 200, publicUser(auth));
}

async function requireAuth(req, res) {
  if (LOGIN_DISABLED) return getLocalUser();
  const user = await getAuthUser(req);
  if (!user) {
    sendJson(res, 401, { error: 'UNAUTHENTICATED', message: '请先登录。' });
    return null;
  }
  return user;
}

async function getAuthUser(req) {
  const token = getCookie(req, 'bwsz_session');
  if (!token) return null;
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  const { users } = await readUsers();
  return users.find((user) => user.id === session.userId) || null;
}

async function getLocalUser() {
  const { users } = await readUsers();
  return users[0] || { id: 'bw-local', username: 'bw', displayName: 'BW', role: 'person', person: 'bw' };
}

async function updateState(req, res) {
  const nextState = normalizeState(await readBody(req));
  if (!nextState || typeof nextState !== 'object' || !Array.isArray(nextState.modules)) {
    return sendJson(res, 400, { error: 'INVALID_STATE', message: '状态数据格式不正确。' });
  }
  await writeState(nextState, 'state-write');
  return sendJson(res, 200, nextState);
}

function getModule(res, key) {
  const state = readState();
  if (!Object.prototype.hasOwnProperty.call(state.spaces || {}, key)) return sendJson(res, 404, { error: 'MODULE_NOT_FOUND' });
  return sendJson(res, 200, { key, data: state.spaces[key] });
}

async function updateModule(req, res, key) {
  const data = await readBody(req);
  const state = readState();
  state.spaces = state.spaces || {};
  state.spaces[key] = data;
  await writeState(state, `module-${key}`);
  return sendJson(res, 200, { key, data });
}

function readState() {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get('app_state');
  return row ? JSON.parse(row.value) : seedState();
}

async function writeState(state, reason) {
  state.meta = { ...(state.meta || {}), updatedAt: new Date().toISOString(), storage: 'sqlite' };
  const value = JSON.stringify(state);
  db.prepare(`
    INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run('app_state', value, state.meta.updatedAt);
  await writeJsonAtomic(STATE_FILE, state).catch(() => {});
  await backupDatabase(reason);
}

async function backupDatabase(reason) {
  await fsp.mkdir(BACKUP_DIR, { recursive: true });
  const latest = path.join(BACKUP_DIR, 'bwsz-space-latest.sqlite');
  await backup(db, latest);
  db.prepare('INSERT INTO backup_log (reason, file_path, created_at) VALUES (?, ?, ?)').run(reason, latest, new Date().toISOString());
}

function listBackups() {
  return db.prepare('SELECT reason, file_path AS filePath, created_at AS createdAt FROM backup_log ORDER BY id DESC LIMIT 50')
    .all()
    .map((item) => ({ ...item, filePath: path.basename(item.filePath || '') }));
}

async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  let filePath = pathname === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, pathname);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'FORBIDDEN' });
  try {
    const stat = await fsp.stat(resolved);
    if (stat.isDirectory()) filePath = path.join(resolved, 'index.html');
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(filePath).pipe(res);
  } catch {
    const index = path.join(PUBLIC_DIR, 'index.html');
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
    return fs.createReadStream(index).pipe(res);
  }
}

async function serveAsset(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  const relative = pathname.replace(/^\/assests\//, '');
  const filePath = path.join(ASSETS_DIR, relative);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(ASSETS_DIR)) return sendJson(res, 403, { error: 'FORBIDDEN' });
  try {
    const ext = path.extname(filePath).toLowerCase();
    await fsp.stat(resolved);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'public, max-age=3600' });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(resolved).pipe(res);
  } catch {
    return sendJson(res, 404, { error: 'ASSET_NOT_FOUND' });
  }
}

function setBaseHeaders(res) {
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}
function validateRuntimeSecurity() {
  if (process.env.NODE_ENV !== 'production') return;
  if (LOGIN_DISABLED) {
    throw new Error('Refusing to start in production with LOGIN_DISABLED=true.');
  }
  if (!process.env.SESSION_SECRET || SESSION_SECRET === DEFAULT_SESSION_SECRET || SESSION_SECRET.length < 32) {
    throw new Error('Refusing to start in production without a strong SESSION_SECRET.');
  }
}
function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
function sendNoContent(res) {
  res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
  res.end();
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}
async function readUsers() { return readJson(USERS_FILE); }
async function readJson(file) { return JSON.parse(await fsp.readFile(file, 'utf8')); }
async function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}
async function ensureUsers() {
  const defaults = [
    { username: 'bw', displayName: 'BW', person: 'bw', envPassword: process.env.BW_PASSWORD || process.env.APP_PASSWORD || 'bw-local-2026' },
    { username: 'sz', displayName: 'SZ', person: 'sz', envPassword: process.env.SZ_PASSWORD || process.env.APP_PASSWORD || 'sz-local-2026' }
  ];

  let existing = [];
  if (fs.existsSync(USERS_FILE)) {
    try {
      existing = (await readUsers()).users || [];
    } catch {
      existing = [];
    }
  }

  const users = [];
  for (const spec of defaults) {
    const found = existing.find((user) => user.username === spec.username || user.person === spec.person);
    if (found) {
      users.push({ ...found, username: spec.username, displayName: found.displayName || spec.displayName, role: 'person', person: spec.person });
    } else {
      users.push(await makeUser(spec.username, spec.envPassword, spec.displayName, spec.person));
      console.log(`Initialized local user: ${spec.username}`);
    }
  }
  await writeJsonAtomic(USERS_FILE, { users });
}

async function makeUser(username, password, displayName, person) {
  return { id: crypto.randomUUID(), username, displayName, role: 'person', person, createdAt: new Date().toISOString(), password: await hashPassword(password) };
}
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const iterations = 120000;
  const key = await pbkdf2(password, salt, iterations);
  return `pbkdf2$sha256$${iterations}$${salt}$${key}`;
}
async function verifyPassword(password, encoded) {
  const [method, digest, iterations, salt, expected] = String(encoded).split('$');
  if (method !== 'pbkdf2' || digest !== 'sha256') return false;
  const actual = await pbkdf2(password, salt, Number(iterations));
  return safeEqual(actual, expected);
}
function pbkdf2(password, salt, iterations) {
  return new Promise((resolve, reject) => crypto.pbkdf2(String(password), salt, iterations, 32, 'sha256', (error, derived) => error ? reject(error) : resolve(derived.toString('base64url'))));
}
function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}
function signToken(raw) {
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(raw).digest('base64url');
  return `${raw}.${sig}`;
}
function publicUser(user) { return { id: user.id, username: user.username, displayName: user.displayName, role: user.role, person: user.person || (user.username === 'sz' ? 'sz' : 'bw') }; }
function getCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}
function cookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/'];
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  return parts.join('; ');
}
function clientKey(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'local').split(',')[0].trim();
}
function isLoginLimited(key) {
  const entry = loginAttempts.get(key);
  if (!entry || Date.now() > entry.resetAt) return false;
  return entry.count >= LOGIN_MAX_ATTEMPTS;
}
function recordLoginFailure(key) {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return;
  }
  entry.count += 1;
}
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!process.env[key]) process.env[key] = value;
  }
}

function normalizeState(input) {
  const base = seedState();
  const state = input && typeof input === 'object' ? input : {};
  const oldSpaces = state.spaces || {};
  const normalized = {
    ...base,
    meta: { ...base.meta, ...(state.meta || {}), version: '0.2.0' },
    couple: { ...base.couple, ...(state.couple || {}) },
    people: mergePeople(base.people, state.people),
    modules: base.modules,
    spaces: { ...base.spaces }
  };

  normalized.spaces.home = { ...base.spaces.home, ...(oldSpaces.home || {}) };
  normalized.spaces.focus = { ...base.spaces.focus, ...(oldSpaces.focus || {}) };
  if (!normalized.spaces.focus.sessions?.length && Number(oldSpaces.home?.focusMinutes || 0) > 0) {
    normalized.spaces.focus.sessions = [{ id: crypto.randomUUID(), title: '历史专注记录', start: todayAt('09:00'), end: todayAt('10:00'), minutes: Number(oldSpaces.home.focusMinutes), source: 'migrated' }];
  }

  const oldProjects = oldSpaces.planning?.projects || oldSpaces.projects?.items || [];
  const oldTasks = oldSpaces.planning?.tasks || oldProjects.flatMap((project) => (project.tasks || []).map((task, index) => ({
    id: task.id || crypto.randomUUID(), projectId: project.id, title: task.text || task.title || `任务 ${index + 1}`, start: todayPlus(index), end: todayPlus(index + 1), level: project.energy || 'M', done: Boolean(task.done), notes: project.notes || ''
  })));
  normalized.spaces.planning = {
    ...base.spaces.planning,
    ...(oldSpaces.planning || {}),
    projects: oldProjects.map((project, index) => ({
      id: project.id || crypto.randomUUID(),
      title: project.title || `长期项目 ${index + 1}`,
      owner: project.owner || '共同',
      status: project.status || '进行中',
      color: project.color || pickColor(index),
      start: project.start || todayPlus(-2),
      end: project.end || todayPlus(14),
      notes: project.notes || ''
    })),
    tasks: oldTasks.length ? oldTasks : base.spaces.planning.tasks
  };

  normalized.spaces.submissions = { ...base.spaces.submissions, ...(oldSpaces.submissions || {}) };
  normalized.spaces.health = { ...base.spaces.health, ...(oldSpaces.health || {}) };
  normalized.spaces.care = { ...base.spaces.care, ...(oldSpaces.care || {}) };
  normalized.spaces.life = { ...base.spaces.life, ...(oldSpaces.life || {}) };
  normalized.spaces.memories = { ...base.spaces.memories, ...(oldSpaces.memories || {}) };
  normalized.spaces.mentor = { ...base.spaces.mentor, ...(oldSpaces.mentor || {}) };
  normalized.spaces.achievements = { ...base.spaces.achievements, ...(oldSpaces.achievements || {}) };
  normalized.spaces.dashboard = { ...base.spaces.dashboard, ...(oldSpaces.dashboard || {}) };
  tagPeople(normalized);
  return normalized;
}

function seedState() {
  const projectId = crypto.randomUUID();
  const now = new Date();
  return {
    meta: { name: "BW&SZ's space", locale: 'zh-CN', version: '0.2.0', storage: 'sqlite', createdAt: now.toISOString(), updatedAt: now.toISOString() },
    couple: {
      title: "BW&SZ's space",
      subtitle: '两个工程博士的生活、科研、专注与长期项目基地',
      members: [
        { id: 'bw', name: 'BW', field: 'Electrical Engineering', color: '#ff8c42' },
        { id: 'sz', name: 'SZ', field: 'CS / EE', color: '#4d9de0' }
      ]
    },
    people: {
      bw: { id: 'bw', name: 'BW', color: '#ff8c42', avatar: '/assets/dog.jpg' },
      sz: { id: 'sz', name: 'SZ', color: '#4d9de0', avatar: '/assets/dog.jpg' }
    },
    modules: [
      { key: 'home', area: 'research', title: '科研总览', icon: '⌂', accent: '#ff8c42', description: '' },
      { key: 'focus', area: 'research', title: '专注定时', icon: '◴', accent: '#ff6b8b', description: '' },
      { key: 'planning', area: 'research', title: '项目与日程', icon: '▦', accent: '#4d9de0', description: '' },
      { key: 'submissions', area: 'research', title: '投稿管理', icon: '✉', accent: '#9b5de5', description: '' },
      { key: 'mentor', area: 'research', title: '向上管理导师', icon: '☉', accent: '#6878c8', description: '' },
      { key: 'dashboard', area: 'research', title: '数据看板', icon: '▧', accent: '#3e8795', description: '' },
      { key: 'life', area: 'life', title: '生活待办', icon: '✓', accent: '#a7c957', description: '' },
      { key: 'health', area: 'life', title: '健康管理', icon: '♥', accent: '#43aa8b', description: '' },
      { key: 'care', area: 'life', title: '心灵关怀', icon: '✦', accent: '#f9c74f', description: '' },
      { key: 'memories', area: 'life', title: '我们的记忆', icon: '♡', accent: '#ff6b8b', description: '' },
      { key: 'achievements', area: 'research', title: '成就殿堂', icon: '★', accent: '#f9c74f', description: '' }
    ],
    spaces: {
      home: { todayNote: '先把重要的事情做小，再稳定推进。', pinned: ['专注 2 个深度块', '更新项目时间轴', '睡前完成健康复盘'] },
      focus: {
        active: null,
        preferredMinutes: 50,
        chartMode: 'week',
        sessions: [
          { id: crypto.randomUUID(), title: '读论文', start: isoAt(-2, '09:00'), end: isoAt(-2, '10:15'), minutes: 75, source: 'seed' },
          { id: crypto.randomUUID(), title: '写代码', start: isoAt(-1, '14:10'), end: isoAt(-1, '15:20'), minutes: 70, source: 'seed' },
          { id: crypto.randomUUID(), title: '整理实验', start: isoAt(0, '10:00'), end: isoAt(0, '10:45'), minutes: 45, source: 'seed' }
        ]
      },
      planning: {
        view: 'week',
        anchorDate: today(),
        selectedTaskId: null,
        projects: [
          { id: projectId, title: 'BW&SZ Space 本地版', owner: '共同', status: '进行中', color: '#ff8c42', start: todayPlus(-2), end: todayPlus(14), notes: '登录可开关、本地数据库、自动备份、专注和项目时间轴。' }
        ],
        tasks: [
          { id: crypto.randomUUID(), projectId, title: '完成专注定时页面', start: todayPlus(0), end: todayPlus(1), level: 'P1', done: false, notes: '支持补录、统计和自动保存。' },
          { id: crypto.randomUUID(), projectId, title: '项目时间轴拖拽', start: todayPlus(2), end: todayPlus(5), level: 'P2', done: false, notes: '拖动改变日期，拉伸改变跨度。' }
        ]
      },
      submissions: { papers: [{ id: crypto.randomUUID(), title: '待命名论文', venue: 'TBD', stage: '写作', deadline: '', next: '确认故事线和目标期刊会议' }] },
      health: {
        habits: [
          { id: 'sleep', title: '睡眠 7h+', kind: 'check', target: 1, doneBy: { bw: false, sz: false } },
          { id: 'water', title: '饮水 6 杯', kind: 'count', target: 6, doneBy: { bw: false, sz: false } },
          { id: 'move', title: '散步 / 运动', kind: 'check', target: 1, doneBy: { bw: false, sz: false } },
          { id: 'eyes', title: '护眼休息', kind: 'count', target: 3, doneBy: { bw: false, sz: false } }
        ],
        habitLogs: {},
        view: 'week',
        checkins: [], leave: []
      },
      care: { mood: '平静', notes: ['今天也要记得：我们不是在单打独斗。'] },
      life: { todos: [{ id: crypto.randomUUID(), text: '买点喜欢的水果', date: today(), createdAt: now.toISOString(), done: false, doneAt: '' }, { id: crypto.randomUUID(), text: '一起整理一下周末计划', date: today(), createdAt: now.toISOString(), done: false, doneAt: '' }] },
      memories: {
        moments: [
          { id: crypto.randomUUID(), title: 'BW&SZ Space 启动', date: today(), place: 'Home Lab', type: 'milestone', mood: '期待', detail: '我们开始把生活、科研和长期目标放进同一个共同空间。', tags: ['共同系统', '新开始'] }
        ]
      },
      mentor: { meetings: [{ id: crypto.randomUUID(), date: '', topic: '下次导师会', agenda: '进度、风险、需要导师决策的问题。' }], questions: ['下一阶段最需要导师拍板的是什么？'], followups: [] },
      achievements: { items: [], badgeTasks: [{ id: crypto.randomUUID(), title: '连续 5 天专注超过 60 分钟', metric: 'focus-5-days', target: 5, progress: 0, awarded: false }] },
      dashboard: { window: 'week' }
    }
  };
}

function today() { return new Date().toISOString().slice(0, 10); }
function todayAt(time) { return `${today()}T${time}:00`; }
function todayPlus(delta) { const d = new Date(); d.setDate(d.getDate() + delta); return d.toISOString().slice(0, 10); }
function isoAt(delta, time) { return `${todayPlus(delta)}T${time}:00`; }
function pickColor(index) { return ['#ff8c42', '#4d9de0', '#43aa8b', '#ff6b8b', '#9b5de5', '#f9c74f'][index % 6]; }

function mergePeople(basePeople, people = {}) {
  return {
    bw: { ...basePeople.bw, ...(people.bw || {}) },
    sz: { ...basePeople.sz, ...(people.sz || {}) }
  };
}

function tagPeople(state) {
  const current = 'bw';
  const spaces = state.spaces || {};
  for (const session of spaces.focus?.sessions || []) session.person = normalizePerson(session.person || session.owner || current);
  if (spaces.focus?.active) spaces.focus.active.person = normalizePerson(spaces.focus.active.person || current);
  for (const project of spaces.planning?.projects || []) project.owner = normalizePerson(project.owner);
  for (const task of spaces.planning?.tasks || []) task.owner = normalizePerson(task.owner);
  for (const paper of spaces.submissions?.papers || []) paper.owner = normalizePerson(paper.owner);
  for (const meeting of spaces.mentor?.meetings || []) meeting.owner = normalizePerson(meeting.owner);
  spaces.mentor.questions = (spaces.mentor?.questions || []).map((question) => typeof question === 'string' ? { id: crypto.randomUUID(), text: question, owner: current } : { ...question, owner: normalizePerson(question.owner) });
  for (const todo of spaces.life?.todos || []) {
    todo.person = normalizePerson(todo.person || current);
    todo.date = todo.date || String(todo.createdAt || today()).slice(0, 10);
    todo.createdAt = todo.createdAt || todayAt('09:00');
    todo.doneAt = todo.done ? (todo.doneAt || todayAt('18:00')) : '';
  }
  for (const habit of spaces.health?.habits || []) {
    habit.id = habit.id || crypto.randomUUID();
    habit.kind = habit.kind || inferHabitKind(habit);
    habit.target = habit.kind === 'count' ? Math.max(1, Number(habit.target || inferTargetFromTitle(habit.title) || 1)) : 1;
    if (!habit.doneBy) habit.doneBy = { bw: Boolean(habit.done), sz: false };
    delete habit.done;
  }
  spaces.health.habitLogs = spaces.health.habitLogs && typeof spaces.health.habitLogs === 'object' ? spaces.health.habitLogs : {};
  spaces.health.view = spaces.health.view || 'week';
  for (const checkin of spaces.health?.checkins || []) checkin.person = normalizePerson(checkin.person || current);
  spaces.care.notes = (spaces.care?.notes || []).map((note) => typeof note === 'string' ? { id: crypto.randomUUID(), text: note, person: current } : { ...note, person: normalizePerson(note.person || current) });
  for (const moment of spaces.memories?.moments || []) moment.person = normalizePerson(moment.person || moment.createdBy || current);
  for (const item of spaces.achievements?.items || []) item.person = normalizePerson(item.person || current);
  for (const task of spaces.achievements?.badgeTasks || []) task.person = normalizePerson(task.person || current);
}

function normalizePerson(value) {
  return value === 'sz' || String(value).toLowerCase() === 'sz' ? 'sz' : 'bw';
}

function inferHabitKind(habit) {
  if (Number(habit.target || 0) > 1) return 'count';
  return /饮水|杯|次|护眼|拉伸|番茄/.test(habit.title || '') ? 'count' : 'check';
}

function inferTargetFromTitle(title = '') {
  if (/饮水/.test(title)) return 6;
  if (/护眼|拉伸/.test(title)) return 3;
  const match = String(title).match(/(\d+)/);
  return match ? Number(match[1]) : 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
