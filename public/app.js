const DOG_AVATAR = './assets/dog.jpg';
const FIREBASE_STATE_PATH = ['spaces', 'bwsz-state'];

const serverApi = {
  storage: 'server',
  async request(path, options = {}) {
    const response = await fetch(path, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      credentials: 'same-origin',
      ...options
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || data.error || '请求失败');
    return data;
  },
  login(username, password) { return this.request('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }); },
  me() { return this.request('/api/auth/me'); },
  logout() { return this.request('/api/auth/logout', { method: 'POST', body: '{}' }); },
  state() { return this.request('/api/state'); },
  save(state) { return this.request('/api/state', { method: 'PUT', body: JSON.stringify(state) }); },
  backups() { return this.request('/api/backups'); }
};

const firebaseApi = {
  storage: 'firebase',
  app: null,
  auth: null,
  db: null,
  unsubscribeState: null,
  lastWriteId: '',
  async init() {
    if (this.app) return;
    if (!window.BWSZ_FIREBASE_CONFIG?.apiKey) throw new Error('缺少 Firebase 配置。');
    await loadFirebaseCompatSdk();
    this.app = firebase.apps?.length ? firebase.app() : firebase.initializeApp(window.BWSZ_FIREBASE_CONFIG);
    this.auth = firebase.auth();
    this.db = firebase.firestore();
  },
  async login(username, password) {
    await this.init();
    const identity = resolveFirebaseIdentity(username);
    const credential = await this.auth.signInWithEmailAndPassword(identity.email, password);
    const user = credential.user;
    assertFirebaseUserAllowed(user);
    return firebasePublicUser(user);
  },
  async me() {
    await this.init();
    const user = await this.waitForUser();
    if (!user) throw new Error('UNAUTHENTICATED');
    assertFirebaseUserAllowed(user);
    return firebasePublicUser(user);
  },
  async logout() {
    await this.init();
    if (this.unsubscribeState) {
      this.unsubscribeState();
      this.unsubscribeState = null;
    }
    await this.auth.signOut();
    return { ok: true };
  },
  waitForUser() {
    return new Promise((resolve) => {
      const unsubscribe = this.auth.onAuthStateChanged((user) => {
        unsubscribe();
        resolve(user);
      });
    });
  },
  docRef() {
    return this.db.collection(FIREBASE_STATE_PATH[0]).doc(FIREBASE_STATE_PATH[1]);
  },
  async state() {
    await this.init();
    const snapshot = await this.docRef().get();
    if (!snapshot.exists) {
      const initial = clientSeedState();
      await this.writeRemoteState(initial, 'init');
      this.listenRemoteState();
      return initial;
    }
    const data = snapshot.data() || {};
    const state = normalizeRemoteState(data.state || data);
    this.listenRemoteState();
    return state;
  },
  async save(state) {
    await this.init();
    const next = normalizeRemoteState(state);
    next.meta = { ...(next.meta || {}), storage: 'firebase', updatedAt: new Date().toISOString(), updatedBy: currentPerson() };
    await this.writeRemoteState(next, 'state-write');
    return next;
  },
  async writeRemoteState(state, reason) {
    this.lastWriteId = cryptoId();
    await this.docRef().set({
      state,
      reason,
      writeId: this.lastWriteId,
      updatedBy: this.auth.currentUser?.email || '',
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  },
  listenRemoteState() {
    if (this.unsubscribeState) return;
    this.unsubscribeState = this.docRef().onSnapshot((snapshot) => {
      if (!snapshot.exists || !app.state) return;
      const data = snapshot.data() || {};
      if (data.writeId && data.writeId === this.lastWriteId) return;
      if (app.saving || app.dirty || document.activeElement?.matches('input, textarea, select')) return;
      applyRemoteState(normalizeRemoteState(data.state || data));
    });
  },
  backups() { return Promise.resolve([]); }
};

const api = shouldUseFirebase() ? firebaseApi : serverApi;
let firebaseSdkPromise = null;

function loadFirebaseCompatSdk() {
  if (window.firebase?.auth && window.firebase?.firestore) return Promise.resolve();
  if (firebaseSdkPromise) return firebaseSdkPromise;
  const version = '12.12.1';
  firebaseSdkPromise = loadScript(`https://www.gstatic.com/firebasejs/${version}/firebase-app-compat.js`)
    .then(() => Promise.all([
      loadScript(`https://www.gstatic.com/firebasejs/${version}/firebase-auth-compat.js`),
      loadScript(`https://www.gstatic.com/firebasejs/${version}/firebase-firestore-compat.js`)
    ]))
    .then(() => {
      if (!window.firebase?.auth || !window.firebase?.firestore) throw new Error('Firebase SDK 没有加载完整。');
    });
  return firebaseSdkPromise;
}

function loadScript(src) {
  if (document.querySelector(`script[src="${src}"]`)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`无法加载 ${src}`));
    document.head.appendChild(script);
  });
}

function shouldUseFirebase() {
  const forced = new URLSearchParams(window.location.search).get('storage') || window.BWSZ_STORAGE;
  if (forced === 'firebase') return true;
  if (forced === 'server' || forced === 'sqlite' || forced === 'local') return false;
  const host = window.location.hostname;
  const isLocal = !host || host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local');
  return Boolean(window.BWSZ_FIREBASE_CONFIG?.apiKey && !isLocal);
}

function resolveFirebaseIdentity(username) {
  const raw = String(username || '').trim().toLowerCase();
  const users = window.BWSZ_FIREBASE_USERS || {};
  if (users[raw]?.email) return { key: raw, ...users[raw] };
  const found = Object.entries(users).find(([, user]) => String(user.email || '').toLowerCase() === raw);
  if (found) return { key: found[0], ...found[1] };
  if (raw.includes('@')) return { key: raw.split('@')[0], email: raw, person: raw.startsWith('sz') ? 'sz' : 'bw', displayName: raw.startsWith('sz') ? 'SZ' : 'BW' };
  throw new Error('请输入 bw / sz，或完整邮箱。');
}

function assertFirebaseUserAllowed(user) {
  const email = String(user?.email || '').toLowerCase();
  const allowed = Object.values(window.BWSZ_FIREBASE_USERS || {}).map((item) => String(item.email || '').toLowerCase()).filter(Boolean);
  if (allowed.length && !allowed.includes(email)) {
    firebaseApi.auth?.signOut();
    throw new Error('这个账号没有进入 BW&SZ space 的权限。');
  }
}

function firebasePublicUser(user) {
  const email = String(user?.email || '').toLowerCase();
  const entry = Object.entries(window.BWSZ_FIREBASE_USERS || {}).find(([, item]) => String(item.email || '').toLowerCase() === email);
  const key = entry?.[0] || (email.startsWith('sz') ? 'sz' : 'bw');
  const info = entry?.[1] || {};
  return { id: user.uid, username: key, displayName: info.displayName || key.toUpperCase(), person: info.person || key, email, storage: 'firebase' };
}

function normalizeRemoteState(state) {
  const base = clientSeedState();
  const next = state && typeof state === 'object' ? state : {};
  return {
    ...base,
    ...next,
    meta: { ...base.meta, ...(next.meta || {}), storage: 'firebase' },
    couple: { ...base.couple, ...(next.couple || {}) },
    people: { ...base.people, ...(next.people || {}) },
    modules: Array.isArray(next.modules) ? next.modules : base.modules,
    spaces: mergeSpaces(base.spaces, next.spaces || {})
  };
}

function mergeSpaces(baseSpaces, spaces) {
  return Object.fromEntries(Object.keys(baseSpaces).map((key) => [key, { ...baseSpaces[key], ...(spaces[key] || {}) }]));
}

function clientSeedState() {
  const now = new Date().toISOString();
  const projectId = cryptoId();
  return {
    meta: { name: "BW&SZ's space", locale: 'zh-CN', version: '0.3.0', storage: 'firebase', createdAt: now, updatedAt: now },
    couple: { title: "BW&SZ's space", subtitle: '两个工程博士的生活、科研、专注与长期项目基地' },
    people: {
      bw: { id: 'bw', name: 'BW', color: '#ff8c42', avatar: DOG_AVATAR },
      sz: { id: 'sz', name: 'SZ', color: '#4d9de0', avatar: DOG_AVATAR }
    },
    modules: defaultModules(),
    spaces: {
      home: { todayNote: '先把重要的事情做小，再稳定推进。', pinned: [] },
      focus: { active: null, preferredMinutes: 50, chartMode: 'week', chartAnchor: today(), sessions: [] },
      planning: { view: 'week', anchorDate: today(), selectedTaskId: null, projects: [], tasks: [] },
      submissions: { papers: [] },
      mentor: { meetings: [], questions: [], followups: [] },
      dashboard: { window: 'week' },
      achievements: { items: [], badgeTasks: [] },
      life: { todos: [] },
      health: { habits: [
        { id: 'sleep', title: '睡眠 7h+', kind: 'check', target: 1, doneBy: { bw: false, sz: false } },
        { id: 'water', title: '饮水 6 杯', kind: 'count', target: 6, doneBy: { bw: false, sz: false } },
        { id: 'move', title: '散步 / 运动', kind: 'check', target: 1, doneBy: { bw: false, sz: false } },
        { id: 'eyes', title: '护眼休息', kind: 'count', target: 3, doneBy: { bw: false, sz: false } }
      ], habitLogs: {}, view: 'week', checkins: [], leave: [] },
      care: { mood: '平静', notes: [] },
      memories: { moments: [{ id: projectId, title: '系统上线第一天', date: today(), place: 'Home Lab', type: 'milestone', mood: '期待', detail: 'BW&SZ Space 上线，开始记录共同生活和长期计划。', tags: ['共同系统', '第一天'], person: 'bw' }] }
    }
  };
}

function applyRemoteState(nextState) {
  app.state = nextState;
  ensureModuleAreas();
  ensurePeople();
  updateIdentityChrome();
  renderAreas();
  renderNav();
  renderActive({ preserveScroll: true, quiet: true });
  $('#saveBtn').textContent = '云端同步已更新';
}


const app = {
  user: null,
  state: null,
  activeArea: 'research',
  active: 'home',
  dirty: false,
  saving: false,
  saveQueued: false,
  saveTimer: null,
  focusTick: null,
  drag: null,
  swipe: null,
};

const $ = (selector) => document.querySelector(selector);
const content = $('#content');

window.addEventListener('DOMContentLoaded', boot);
document.addEventListener('pointermove', handleTimelinePointerMove);
document.addEventListener('pointerup', handleTimelinePointerUp);
document.addEventListener('pointerup', handleSwipePointerUp);

async function boot() {
  bindShellEvents();
  tickClock();
  setInterval(tickClock, 1000 * 20);
  try {
    app.user = await api.me();
    await enterApp();
  } catch {
    showLogin();
  }
}

function bindShellEvents() {
  $('#loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    $('#loginMessage').textContent = '';
    try {
      app.user = await api.login($('#username').value.trim(), $('#password').value);
      await enterApp();
    } catch (error) {
      $('#loginMessage').textContent = error.message;
    }
  });

  $('#logoutBtn').addEventListener('click', async () => {
    await api.logout();
    app.user = null;
    app.state = null;
    showLogin();
  });

  $('#saveBtn').addEventListener('click', () => toast(api.storage === 'firebase' ? '已开启云端同步：修改会写入 Firestore。' : '已开启自动保存：每次修改都会写入 SQLite 并生成最新备份。'));
  content.addEventListener('click', handleContentClick);
  content.addEventListener('submit', handleContentSubmit);
  content.addEventListener('input', handleContentInput);
  content.addEventListener('pointerdown', handleSwipePointerDown);
}

async function enterApp() {
  app.state = await api.state();
  ensureModuleAreas();
  const hadPeople = Boolean(app.state.people?.bw && app.state.people?.sz);
  ensurePeople();
  app.activeArea = 'research';
  app.active = 'home';
  $('#loginView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
  $('#logoutBtn').classList.toggle('hidden', Boolean(app.user?.loginDisabled));
  updateIdentityChrome();
  $('#saveBtn').textContent = api.storage === 'firebase' ? '云端同步已开启' : '自动保存已开启';
  $('#exportBtn').textContent = api.storage === 'firebase' ? 'Firebase 云端' : '备份记录';
  renderAreas();
  renderNav();
  renderActive();
  startFocusTicker();
  if (!hadPeople) markDirty();
}

function showLogin() {
  $('#appView').classList.add('hidden');
  $('#loginView').classList.remove('hidden');
}

function renderAreas() {
  const areaNav = $('#areaNav');
  areaNav.innerHTML = `
    <div class="nav-section-title">一级入口</div>
    ${areaList().map((area) => `
      <button class="area-button ${area.key === app.activeArea ? 'active' : ''}" data-area="${area.key}" style="--area:${area.accent}">
        <span>${area.icon}</span>
        <strong>${area.title}</strong>
      </button>
    `).join('')}
    <div class="nav-section-title secondary">二级页面</div>
  `;
  areaNav.querySelectorAll('[data-area]').forEach((button) => {
    button.addEventListener('click', () => {
      app.activeArea = button.dataset.area;
      app.active = modulesForArea(app.activeArea)[0]?.key || app.state.modules[0]?.key;
      renderAreas();
      renderNav();
      renderActive({ preserveScroll: true, quiet: true });
    });
  });
}

function renderNav() {
  const nav = $('#moduleNav');
  const modules = modulesForArea(app.activeArea);
  if (!modules.some((mod) => mod.key === app.active)) app.active = modules[0]?.key || app.active;
  nav.innerHTML = modules.map((mod) => `
    <button class="nav-button ${mod.key === app.active ? 'active' : ''}" style="--active:${escAttr(mod.accent)}" data-nav="${escAttr(mod.key)}">
      <i>${moduleLogo(mod.key)}</i><span>${esc(mod.title)}</span>
    </button>
  `).join('');
  nav.querySelectorAll('[data-nav]').forEach((button) => {
    button.addEventListener('click', () => {
      app.active = button.dataset.nav;
      renderNav();
      renderActive();
    });
  });
}

function moduleLogo(key) {
  const paths = {
    home: '<path d="M4 10.5 12 4l8 6.5v8a1.5 1.5 0 0 1-1.5 1.5H15v-5H9v5H5.5A1.5 1.5 0 0 1 4 18.5z"/>',
    focus: '<circle cx="12" cy="13" r="7"/><path d="M9 2h6M12 7v6l4 2"/>',
    planning: '<path d="M4 6h16M4 12h16M4 18h16"/><path d="M8 4v16M16 4v16"/>',
    submissions: '<path d="M4 5h16v14H4z"/><path d="m4 7 8 6 8-6"/>',
    mentor: '<path d="M5 6h14v9H8l-3 3z"/><path d="M8 9h8M8 12h5"/>',
    dashboard: '<path d="M5 19V9M12 19V5M19 19v-7"/>',
    achievements: '<path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
    life: '<path d="M5 12.5 10 17 19 7"/>',
    health: '<path d="M12 20s-7-4.2-7-10a4 4 0 0 1 7-2.7A4 4 0 0 1 19 10c0 5.8-7 10-7 10z"/>',
    care: '<path d="M12 3l1.4 4.2L18 8.5l-4.6 1.3L12 14l-1.4-4.2L6 8.5l4.6-1.3z"/><path d="M18 14l.8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8z"/>',
    memories: '<path d="M6 4h12v16l-6-3-6 3z"/><path d="M9 8h6"/>',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[key] || paths.home}</svg>`;
}

function renderActive(options = {}) {
  const previousScrollY = window.scrollY;
  if (options.quiet) content.classList.add('quiet-render');
  const module = getModule(app.active) || app.state.modules[0];
  app.activeArea = module.area || moduleArea(module.key);
  $('#heroTitle').textContent = module.key === 'home' ? app.state.couple.title : module.title;
  $('#heroSubtitle').textContent = module.description;
  content.innerHTML = '';
  const renderers = {
    home: renderHome,
    focus: renderFocus,
    planning: renderPlanning,
    submissions: renderSubmissions,
    health: renderHealth,
    care: renderCare,
    life: renderLife,
    memories: renderMemories,
    mentor: renderMentor,
    achievements: renderAchievements,
    dashboard: renderDashboard
  };
  (renderers[module.key] || renderGeneric)(module);
  if (options.preserveScroll) requestAnimationFrame(() => window.scrollTo(0, previousScrollY));
  if (options.quiet) requestAnimationFrame(() => content.classList.remove('quiet-render'));
}

function renderHome() {
  const metrics = collectMetrics();
  addCard('今日状态', '专注、任务、健康和导师事项的轻量总览。', `
    <div class="hero-metrics">
      <div><b>${metrics.focusToday}</b><span>今日专注分钟</span></div>
      <div><b>${metrics.openTasks}</b><span>未完成任务</span></div>
      <div><b>${metrics.healthDone}/${metrics.healthTotal}</b><span>健康打卡</span></div>
      <div><b>${metrics.badges}</b><span>成就徽章</span></div>
    </div>
  `, 'full');

  addCard('今日便签', '两个人都能看懂的下一步。', `
    <textarea data-field="spaces.home.todayNote">${esc(app.state.spaces.home.todayNote || '')}</textarea>
  `, 'wide');

  addCard('今日 Todo', '自动汇总今天需要处理的任务。', renderTodayTodo(), 'home-todo');

  addCard('快速入口', '常用动作直接跳转。', `
    <div class="quick-grid">
      <button class="quick-card" data-jump="focus"><strong>开始专注</strong><span>计时 / 补录 / 统计</span></button>
      <button class="quick-card" data-jump="planning"><strong>排项目时间轴</strong><span>拖动任务块改时间</span></button>
      <button class="quick-card" data-jump="health"><strong>健康打卡</strong><span>睡眠、饮水、运动</span></button>
      <button class="quick-card" data-jump="life"><strong>生活待办</strong><span>小事记下来，做完划掉</span></button>
      <button class="quick-card" data-jump="memories"><strong>记录我们的瞬间</strong><span>纪念日、旅行和小确幸</span></button>
      <button class="quick-card" data-jump="mentor"><strong>准备导师会</strong><span>问题池和 follow-up</span></button>
    </div>
  `, 'wide');
}

function renderTodayTodo() {
  const todayKey = today();
  const researchTasks = personalTasks()
    .filter((task) => !task.done && dateInRange(todayKey, task.start, task.end))
    .slice(0, 5);
  const health = ensureHealth();
  const healthTodos = (health.habits || [])
    .filter((habit) => habitValue(habit, currentPerson()) < habitTarget(habit))
    .slice(0, 4);
  const total = researchTasks.length + healthTodos.length;
  if (!total) return '<div class="today-empty"><b>今天清爽</b><span>没有到期任务。可以安排一个深度专注块。</span></div>';
  return `
    <div class="today-todo-list">
      ${researchTasks.map((task) => `
        <button class="today-todo-item" data-jump="planning">
          <span class="todo-dot research"></span>
          <strong>${esc(task.title)}</strong>
          <small>${esc(task.level || 'P1')} · ${esc(task.start)} → ${esc(task.end)}</small>
        </button>
      `).join('')}
      ${healthTodos.map((habit) => `
        <button class="today-todo-item" data-jump="health">
          <span class="todo-dot health"></span>
          <strong>${esc(habit.title)}</strong>
          <small>健康打卡 · ${habitValue(habit, currentPerson())}/${habitTarget(habit)}</small>
        </button>
      `).join('')}
    </div>`;
}

function renderFocus() {
  const focus = app.state.spaces.focus;
  const active = focus.active;
  const elapsed = active ? Math.max(0, Math.floor((Date.now() - new Date(active.startedAt).getTime()) / 1000)) : 0;
  const mode = focus.chartMode || 'week';
  focus.chartAnchor = clampFocusAnchor(mode, focus.chartAnchor || today());
  const stats = focusPeriodStats(mode, focus.chartAnchor);
  const peak = peakHour(focus.sessions || []);
  const byPerson = focusByPerson();

  addCard('两个人的专注', '共同可见，用颜色区分是谁的数据。', `
    <div class="person-summary">
      <div data-person="bw">${personBadge('bw')}<b>${byPerson.bw}</b><span>分钟</span></div>
      <div data-person="sz">${personBadge('sz')}<b>${byPerson.sz}</b><span>分钟</span></div>
    </div>
  `, 'full');

  addCard('专注定时器', '开始之前只需要写一个意图；结束时自动入库和备份。', `
    <div class="focus-timer">
      <div class="focus-ring ${active ? 'running' : ''}">
        <span id="focusTime">${formatSeconds(elapsed)}</span>
        <small>${active ? esc(active.title || '正在专注') : '准备开始'}</small>
      </div>
      <div class="focus-controls">
        <input id="focusTitle" placeholder="例如：写完实验记录" value="${escAttr(active?.title || '')}">
        <div class="action-row">
          ${active ? '<button class="primary-button" data-action="finish-focus">完成并记录</button><button class="secondary-button" data-action="cancel-focus">放弃本次</button>' : '<button class="primary-button" data-action="start-focus">开始专注</button>'}
        </div>
      </div>
    </div>
  `, 'wide');

  addCard('手动补录', '人性化一点：忘记开计时也没关系，事后补上。', `
    <form class="form-grid" data-form="focus-manual">
      <label>做了什么<input name="title" required placeholder="例如：写文献综述"></label>
      <label>日期<input name="date" type="date" value="${today()}" required></label>
      <label>开始时间<input name="startTime" type="time" value="09:00" required></label>
      <label>结束时间<input name="endTime" type="time" value="10:00" required></label>
      <label class="full">备注<input name="note" placeholder="例如：状态、地点、是否被打断（可选）"></label>
      <button class="primary-button full">补录专注</button>
    </form>
  `);

  addCard('专注使用时间', '参考 Apple 屏幕使用时间：按天 / 周 / 月看柱状图。', `
    ${renderFocusChart(mode, focus.chartAnchor, stats)}
    <div class="insight-row">
      <span class="chip">总计 ${stats.total} 分钟</span>
      <span class="chip">平均 ${stats.avg} 分钟</span>
      <span class="chip">更专注时段 ${peak}</span>
    </div>
  `, 'full');

  addCard('最近记录', api.storage === 'firebase' ? '自动同步到 Firestore。' : '自动保存到本地 SQLite。', `
    <div class="list compact-list">
      ${(focus.sessions || []).slice().reverse().slice(0, 8).map((session) => `
        <article class="item"><div class="item-head"><h3>${personBadge(session.person)} ${esc(session.title || '专注')}</h3><span class="chip">${session.minutes} 分钟</span></div><p>${formatDateTime(session.start)} - ${formatTime(session.end)} · ${esc(session.source || 'timer')}</p></article>
      `).join('') || '<p class="tiny">还没有专注记录。</p>'}
    </div>
  `, 'full');
}

function renderPlanning() {
  const planning = app.state.spaces.planning;
  const projects = personalProjects();
  const tasks = personalTasks();
  const selected = tasks.find((task) => task.id === planning.selectedTaskId) || tasks[0];
  if (selected && planning.selectedTaskId !== selected.id) planning.selectedTaskId = selected.id;

  addCard('新增长期项目', '项目是容器，任务才进入时间轴。', `
    <form class="form-grid" data-form="project">
      <label>项目名<input name="title" required placeholder="例如：期刊返修 / 家庭网站 / 实验平台"></label>
      <label>归属<input value="${escAttr(personName(currentPerson()))}" disabled></label>
      <label>开始日期<input name="start" type="date" value="${today()}"></label>
      <label>结束日期<input name="end" type="date" value="${dateAdd(today(), 14)}"></label>
      <label class="full">备注<textarea name="notes" placeholder="例如：目标、边界、风险"></textarea></label>
      <button class="primary-button full">添加长期项目</button>
    </form>
  `, 'wide');

  addCard('添加任务 / 临时任务', '任务可以归属项目，也可以作为临时任务存在；level 用来表达优先级。', `
    <form class="form-grid" data-form="task">
      <label>任务名<input name="title" required placeholder="例如：补一张消融实验图"></label>
      <label>归属项目<select name="projectId"><option value="">临时任务</option>${projects.map((project) => `<option value="${escAttr(project.id)}">${esc(project.title)}</option>`).join('')}</select></label>
      <label>开始日期<input name="start" type="date" value="${today()}"></label>
      <label>结束日期<input name="end" type="date" value="${dateAdd(today(), 1)}"></label>
      <label>Level<select name="level"><option>P0</option><option selected>P1</option><option>P2</option><option>P3</option></select></label>
      <label class="full">具体内容<textarea name="notes" placeholder="例如：验收标准、资料链接、上下文"></textarea></label>
      <button class="primary-button full">添加到时间轴</button>
    </form>
  `);

  addCard('Project Timeline', '拖动任务块改变开始时间；拖左右边缘拉长或缩短。', `
    <div class="timeline-toolbar">
      <div class="segmented">${['week','month'].map((mode) => `<button class="${planning.view === mode ? 'active' : ''}" data-planning-view="${mode}">${modeLabel(mode)}</button>`).join('')}</div>
      <div class="action-row"><button class="mini-button" data-action="timeline-prev">←</button><button class="mini-button" data-action="timeline-today">今天</button><button class="mini-button" data-action="timeline-next">→</button></div>
    </div>
    ${renderTimeline({ ...planning, projects, tasks })}
  `, 'full');

  addCard('任务详情', '点击任务块或列表后在这里修改。', `<div id="taskDetailSlot">${renderTaskEditor(selected, { ...planning, projects, tasks })}</div>`, 'wide');

  addCard('每日 / 每周任务', '同一批任务换一个更轻的列表视角。', renderTaskLists({ ...planning, projects, tasks }));
}

function renderSubmissions() {
  const papers = personalPapers();
  addCard('投稿流水线', '保留轻量投稿管理，后续可接入项目时间轴。', `
    <div class="list">${papers.map((paper) => `<article class="item"><div class="item-head"><h3>${personBadge(paper.owner)} ${esc(paper.title)}</h3><span class="chip">${esc(paper.stage)}</span></div><p>目标：${esc(paper.venue || 'TBD')} · 截止：${esc(paper.deadline || '未设定')}</p><p>下一步：${esc(paper.next || '待补充')}</p></article>`).join('')}</div>
  `, 'wide');
  addCard('新增投稿', '论文投稿仍可以独立追踪。', `
    <form class="form-grid" data-form="paper">
      <label>论文标题<input name="title" required></label><label>目标 venue<input name="venue"></label>
      <label>阶段<input name="stage" value="写作"></label><label>截止日期<input name="deadline" type="date"></label>
      <label class="full">下一步<textarea name="next"></textarea></label><button class="primary-button full">加入投稿管理</button>
    </form>
  `);
}

function renderHealth() {
  const health = ensureHealth();
  const habits = health.habits || [];
  const mode = health.view || 'week';

  addCard('今日健康打卡', '两个人都能看到；打卡型可取消，次数型可加减次数。', `
    <div class="health-habit-grid">
      ${habits.map(renderHabitCard).join('') || '<p class="tiny">还没有习惯，先添加一个。</p>'}
    </div>
  `, 'full');

  addCard('习惯管理', '可以添加、修改、删除习惯；次数型适合饮水、护眼、拉伸等。', `
    <form class="form-grid" data-form="health-habit-add">
      <label>习惯名<input name="title" required placeholder="例如：饮水 / 护眼 / 伸展"></label>
      <label>类型<select name="kind"><option value="check">打卡型</option><option value="count">次数型</option></select></label>
      <label>目标次数<input name="target" type="number" min="1" value="1"></label>
      <button class="primary-button full">添加习惯</button>
    </form>
    <div class="habit-manage-list">
      ${habits.map((habit) => `
        <form class="habit-edit-row" data-form="health-habit-edit" data-habit-id="${escAttr(habit.id)}">
          <input name="title" value="${escAttr(habit.title)}" required>
          <select name="kind"><option value="check" ${habit.kind !== 'count' ? 'selected' : ''}>打卡型</option><option value="count" ${habit.kind === 'count' ? 'selected' : ''}>次数型</option></select>
          <input name="target" type="number" min="1" value="${habitTarget(habit)}">
          <button class="mini-button">保存</button>
          <button class="mini-button danger" type="button" data-delete-habit="${escAttr(habit.id)}">删除</button>
        </form>
      `).join('') || '<p class="tiny">暂无可编辑习惯。</p>'}
    </div>
  `, 'full');

  addCard('打卡记录', '按日 / 周 / 月查看两个人的完成情况。', `
    <div class="segmented">
      ${['day','week','month'].map((item) => `<button class="${mode === item ? 'active' : ''}" data-health-view="${item}">${modeLabel(item)}</button>`).join('')}
    </div>
    ${renderHealthRecords(mode)}
  `, 'full');

  addCard('健康记录 / 请假', '可以记录状态，记录会标明是谁写的。', `
    <form class="form-grid" data-form="health-note">
      <label>类别<select name="type"><option>恢复</option><option>病假</option><option>运动</option><option>睡眠</option><option>用眼</option></select></label>
      <label>日期<input name="date" type="date" value="${today()}"></label>
      <label class="full">记录<textarea name="note" placeholder="例如：今天低能量，改成恢复优先。"></textarea></label>
      <button class="primary-button full">记录健康状态</button>
    </form>
  `, 'full');
  addCard('最近健康状态', '两个人共同可见。', `<div class="list compact-list">${(health.checkins || []).slice().reverse().slice(0, 8).map((item) => `<article class="item"><div class="item-head"><h3>${personBadge(item.person)} ${esc(item.type)}</h3><span class="chip">${esc(item.date)}</span></div><p>${esc(item.note || '')}</p></article>`).join('') || '<p class="tiny">还没有健康记录。</p>'}</div>`, 'full');
}

function renderHabitCard(habit) {
  const target = habitTarget(habit);
  const current = habitValue(habit, currentPerson());
  const done = current >= target;
  const kind = habit.kind === 'count' ? '次数型' : '打卡型';
  return `
    <article class="habit-card ${done ? 'done' : ''}">
      <div class="habit-card-head">
        <h3>${esc(habit.title)}</h3>
        <span class="chip">${kind} · 目标 ${target}</span>
      </div>
      <div class="habit-person-lines">
        ${['bw','sz'].map((person) => renderHabitPersonLine(habit, person)).join('')}
      </div>
      <div class="habit-control-row">
        ${habit.kind === 'count'
          ? `<button class="mini-button" data-habit-action="decrement" data-habit-id="${escAttr(habit.id)}">−</button><strong>${current}/${target}</strong><button class="mini-button" data-habit-action="increment" data-habit-id="${escAttr(habit.id)}">＋</button>`
          : `<button class="mini-button" data-habit-action="toggle" data-habit-id="${escAttr(habit.id)}">${done ? '取消打卡' : '完成打卡'}</button>`}
      </div>
    </article>`;
}

function renderHabitPersonLine(habit, person) {
  const target = habitTarget(habit);
  const value = habitValue(habit, person);
  const pct = Math.round((Math.min(value, target) / target) * 100);
  return `
    <div class="habit-person-line" data-person="${escAttr(person)}">
      ${personBadge(person)}
      <div class="progress"><span style="--value:${pct}%"></span></div>
      <b>${value}/${target}</b>
    </div>`;
}

function renderHealthRecords(mode) {
  const days = healthRecordDays(mode);
  const label = mode === 'day' ? '今天' : mode === 'week' ? '本周' : '本月';
  return `
    <div class="health-record-grid ${mode}">
      ${days.map((day) => {
        const summary = healthDaySummary(day);
        return `
          <article class="health-record-card ${day === today() ? 'today' : ''}">
            <div class="health-record-head"><strong>${esc(healthDayTitle(day, mode))}</strong><span>${summary.done}/${summary.total}</span></div>
            <div class="health-record-people">
              ${['bw','sz'].map((person) => `<div data-person="${escAttr(person)}"><i></i><b>${esc(personName(person))}</b><span>${summary.people[person]}/${summary.perPerson}</span></div>`).join('')}
            </div>
          </article>`;
      }).join('')}
    </div>
    <p class="tiny">${label}记录按每个习惯是否达到当天目标统计；次数型达到目标才算完成。</p>`;
}


function renderCare() {
  const care = app.state.spaces.care;
  care.notes = normalizeCareNotes(care.notes || []);
  addCard('心情温度', '', `<label>现在的状态<input data-field="spaces.care.mood" value="${escAttr(care.mood || '')}"></label>`, 'full');
  addCard('鼓励与感谢', '', `
    <div class="list care-note-list">
      ${care.notes.map((note) => `
        <article class="item care-note-item">
          <span>${personBadge(note.person)} ${esc(note.text || note.note || '')}</span>
          <button class="mini-button delete-note" data-delete-care-note="${escAttr(note.id)}" aria-label="删除">删除</button>
        </article>
      `).join('') || '<p class="tiny">还没有记录。</p>'}
    </div>
    <form data-form="care-note" class="action-row"><input name="note" required placeholder="今天想感谢 / 鼓励对方的一句话"><button class="mini-button">添加</button></form>
  `, 'full');
}

function renderLife() {
  const life = app.state.spaces.life || { todos: [] };
  const todos = life.todos || [];
  const openTodos = todos.filter((todo) => !todo.done).sort((a, b) => todoDate(a).localeCompare(todoDate(b)));
  const recentDone = todos
    .filter((todo) => todo.done && String(todo.doneAt || todoDate(todo)).slice(0, 10) >= dateAdd(today(), -3))
    .sort((a, b) => String(b.doneAt || todoDate(b)).localeCompare(String(a.doneAt || todoDate(a))));
  addCard('加一个生活待办', '不需要项目、不需要时间轴，就写一句要做什么。', `
    <form class="todo-add" data-form="life-todo">
      <input name="text" required placeholder="例如：取快递 / 买牛奶 / 订周末餐厅">
      <input name="date" type="date" value="${today()}" aria-label="待办日期">
      <button class="primary-button">添加</button>
    </form>
    <p class="tiny">还剩 ${openTodos.length} 件小事没做。</p>
  `, 'full');

  addCard('生活 Todo List', '简单一点：做完点一下就划掉。', `
    <div class="todo-section">
      <div class="todo-section-head"><h3>要做</h3><span>${openTodos.length}</span></div>
      <div class="todo-list">${openTodos.map(renderTodoRow).join('') || '<p class="tiny">现在没有待办。</p>'}</div>
    </div>
    <div class="todo-section done-section">
      <div class="todo-section-head"><h3>已完成 · 近 3 天</h3><span>${recentDone.length}</span></div>
      <div class="todo-list">${recentDone.map(renderTodoRow).join('') || '<p class="tiny">近 3 天还没有完成记录。</p>'}</div>
    </div>
  `, 'full');
}

function renderTodoRow(todo) {
  return `
    <button class="todo-row ${todo.done ? 'done' : ''}" data-life-todo="${escAttr(todo.id)}">
      <span class="todo-check">${todo.done ? '✓' : ''}</span>
      <span class="todo-owner">${personBadge(todo.person)}</span>
      <strong>${esc(todo.text)}</strong>
      <time>${esc(todoDate(todo))}${todo.doneBy ? ` · ${esc(personName(todo.doneBy))} 完成` : ''}</time>
    </button>`;
}

function todoDate(todo) {
  return todo.date || String(todo.createdAt || '').slice(0, 10) || today();
}

function renderMemories() {
  const memories = app.state.spaces.memories || { moments: [] };
  const moments = memories.moments || [];
  addCard('添加重要时刻', '不只记录大事，也记录那些以后会想念的普通一天。', `
    <form class="form-grid" data-form="memory">
      <label>标题<input name="title" required placeholder="例如：第一次一起搬家 / 一场很开心的散步"></label>
      <label>日期<input name="date" type="date" value="${today()}" required></label>
      <label>地点<input name="place" placeholder="例如：城市 / 校园 / 家里 / 路上"></label>
      <label>类型<select name="type"><option>milestone</option><option>anniversary</option><option>travel</option><option>daily</option><option>celebration</option></select></label>
      <label>心情<input name="mood" placeholder="例如：开心 / 感动 / 被治愈 / 很踏实"></label>
      <label>标签<input name="tags" placeholder="例如：旅行，纪念日，晚霞"></label>
      <label class="full">故事<textarea name="detail" placeholder="例如：发生了什么？为什么值得留下？"></textarea></label>
      <button class="primary-button full">保存到我们的记忆</button>
    </form>
  `, 'wide');

  addCard('记忆时间线', '按时间倒序保存两个人共同生活的证据。', `
    <div class="memory-timeline">
      ${moments.slice().sort((a, b) => String(b.date).localeCompare(String(a.date))).map((moment) => `
        <article class="memory-card">
          <div class="memory-date"><b>${esc(formatMemoryDay(moment.date))}</b><span>${esc(String(moment.date || '').slice(0, 4))}</span></div>
          <div>
            <div class="item-head"><h3>${personBadge(moment.person)} ${esc(moment.title)}</h3><span class="chip">${esc(moment.type || 'moment')}</span></div>
            <p>${esc(moment.detail || '')}</p>
            <div class="chip-row">
              ${moment.place ? `<span class="chip">📍 ${esc(moment.place)}</span>` : ''}
              ${moment.mood ? `<span class="chip">心情 ${esc(moment.mood)}</span>` : ''}
              ${(moment.tags || []).map((tag) => `<span class="chip">#${esc(tag)}</span>`).join('')}
            </div>
          </div>
        </article>
      `).join('') || '<p class="tiny">还没有记录，先写下第一个重要时刻吧。</p>'}
    </div>
  `, 'full');
}

function renderMentor() {
  const mentor = personalMentor();
  addCard('导师会准备', `${personName(currentPerson())} 的导师管理，只显示当前账号自己的记录。`, `
    <form class="form-grid" data-form="mentor-meeting">
      <label>日期<input name="date" type="date" value="${today()}"></label><label>主题<input name="topic" value="下次导师会" required></label>
      <label class="full">议程 / 材料<textarea name="agenda" placeholder="例如：进度、风险、需要导师拍板的问题"></textarea></label>
      <button class="primary-button full">新增导师会</button>
    </form>
  `, 'wide');
  addCard('问题池', '把不确定性整理成可决策问题。', `<div class="list">${(mentor.questions || []).map((q) => `<p class="item">${personBadge(q.owner)} ${esc(q.text || q)}</p>`).join('')}</div><form data-form="mentor-question" class="action-row"><input name="question" required placeholder="新增一个需要导师回答的问题"><button class="mini-button">添加</button></form>`);
  addCard('会议与跟进', '每次会后留证据。', `<div class="list compact-list">${(mentor.meetings || []).slice().reverse().map((m) => `<article class="item"><div class="item-head"><h3>${personBadge(m.owner)} ${esc(m.topic)}</h3><span class="chip">${esc(m.date || '待定')}</span></div><p>${esc(m.agenda || '')}</p></article>`).join('')}</div>`, 'full');
}

function renderAchievements() {
  autoAwardBadges();
  const achievements = app.state.spaces.achievements;
  addCard('自动徽章', '不是普通列表：它会根据专注、任务和健康数据自动点亮。', `
    <div class="badge-grid">
      ${achievementCatalog().map((badge) => `<div class="badge-card ${badge.awarded ? 'awarded' : ''}"><div>${badge.icon}</div><strong>${esc(badge.title)}</strong><span>${esc(badge.desc)}</span><em>${badge.awarded ? '已点亮' : `${badge.progress}/${badge.target}`}</em></div>`).join('')}
    </div>
  `, 'full');
  addCard('手动徽章任务', '也可以自己定义值得庆祝的目标。', `
    <form class="form-grid" data-form="badge-task"><label>徽章任务<input name="title" required placeholder="例如：完成一次完整投稿"></label><label>目标次数<input name="target" type="number" min="1" value="1"></label><button class="primary-button full">添加徽章任务</button></form>
    <div class="list compact-list">${(achievements.badgeTasks || []).map((task) => `<article class="item"><div class="item-head"><h3>${esc(task.title)}</h3><span class="chip">${task.progress || 0}/${task.target || 1}</span></div></article>`).join('')}</div>
  `, 'wide');
  addCard('手动添加徽章', '重要但系统识别不了的时刻，可以手动加。', `<form class="form-grid" data-form="achievement"><label>标题<input name="title" required></label><label>日期<input name="date" type="date" value="${today()}"></label><label class="full">细节<textarea name="detail"></textarea></label><button class="primary-button full">加入殿堂</button></form>`);
}

function renderDashboard() {
  const metrics = collectMetrics();
  addCard('宏观核心数据', '只看几个真正影响系统运转的指标。', `
    <div class="hero-metrics">
      <div><b>${metrics.focusWeek}</b><span>本周专注分钟</span></div>
      <div><b>${metrics.doneTasks}/${metrics.totalTasks}</b><span>任务完成</span></div>
      <div><b>${metrics.healthDone}/${metrics.healthTotal}</b><span>今日健康</span></div>
      <div><b>${metrics.mentorOpen}</b><span>导师问题池</span></div>
    </div>
  `, 'full');
  addCard('专注趋势', '轻量柱状图，不堆复杂图表。', renderBars(focusStats('week').bars, focusStats('week').max), 'wide');
  if (api.storage === 'firebase') {
    addCard('云端同步状态', '', `<p><code>Firestore: spaces/bwsz-state</code></p><p><code>Auth: BW / SZ</code></p>`);
  } else {
    addCard('本地数据库状态', '', `<p><code>data/bwsz-space.sqlite</code></p><p><code>data/backups/bwsz-space-latest.sqlite</code></p>`);
  }
}


function renderGeneric(module) {
  addCard(module.title, module.description, '<p>这个模块已经在注册表中，等待实现具体界面。</p>');
}

function renderTaskEditor(selected, planning) {
  if (!selected) return '<p class="tiny">还没有任务。</p>';
  return `
    <form class="form-grid" data-form="task-edit" data-task-id="${escAttr(selected.id)}">
      <label>任务名<input name="title" value="${escAttr(selected.title)}" required></label>
      <label>归属项目<select name="projectId"><option value="">临时任务</option>${planning.projects.map((project) => `<option value="${escAttr(project.id)}" ${project.id === selected.projectId ? 'selected' : ''}>${esc(project.title)}</option>`).join('')}</select></label>
      <label>开始日期<input name="start" type="date" value="${escAttr(selected.start)}"></label>
      <label>结束日期<input name="end" type="date" value="${escAttr(selected.end)}"></label>
      <label>Level<select name="level">${['P0','P1','P2','P3'].map((level) => `<option ${selected.level === level ? 'selected' : ''}>${level}</option>`).join('')}</select></label>
      <label>状态<select name="done"><option value="false" ${!selected.done ? 'selected' : ''}>未完成</option><option value="true" ${selected.done ? 'selected' : ''}>已完成</option></select></label>
      <label class="full">具体内容<textarea name="notes">${esc(selected.notes || '')}</textarea></label>
      <button class="primary-button full">保存任务详情</button>
    </form>
  `;
}

function selectTaskInPlace(taskId) {
  const planning = app.state.spaces.planning;
  const task = planning.tasks.find((item) => item.id === taskId);
  if (!task) return;
  planning.selectedTaskId = taskId;
  content.querySelectorAll('[data-select-task]').forEach((node) => node.classList.toggle('selected', node.dataset.selectTask === taskId));
  const slot = $('#taskDetailSlot');
  if (slot) slot.innerHTML = renderTaskEditor(task, { ...planning, projects: personalProjects(), tasks: personalTasks() });
}

function addCard(title, description, body, width = '') {
  const article = document.createElement('article');
  article.className = `panel-card ${width}`.trim();
  article.innerHTML = `<div class="panel-title"><div><h2>${esc(title)}</h2>${description ? `<p>${esc(description)}</p>` : ''}</div></div>${body}`;
  content.appendChild(article);
}

function handleContentClick(event) {
  const jump = event.target.closest('[data-jump]');
  if (jump) return switchTo(jump.dataset.jump);

  const focusMode = event.target.closest('[data-focus-mode]');
  if (focusMode) {
    const focus = app.state.spaces.focus;
    focus.chartMode = focusMode.dataset.focusMode;
    focus.chartAnchor = clampFocusAnchor(focus.chartMode, focus.chartAnchor || today());
    markDirty();
    return renderActive({ preserveScroll: true, quiet: true });
  }

  const planningView = event.target.closest('[data-planning-view]');
  if (planningView) { app.state.spaces.planning.view = planningView.dataset.planningView; markDirty(); return renderActive({ preserveScroll: true, quiet: true }); }

  const healthView = event.target.closest('[data-health-view]');
  if (healthView) { ensureHealth().view = healthView.dataset.healthView; markDirty(); return renderActive({ preserveScroll: true, quiet: true }); }

  const habitAction = event.target.closest('[data-habit-action]');
  if (habitAction) {
    updateHabitProgress(habitAction.dataset.habitId, habitAction.dataset.habitAction);
    markDirty();
    return renderActive({ preserveScroll: true, quiet: true });
  }

  const deleteHabit = event.target.closest('[data-delete-habit]');
  if (deleteHabit) {
    deleteHealthHabit(deleteHabit.dataset.deleteHabit);
    markDirty('已删除习惯。');
    return renderActive({ preserveScroll: true, quiet: true });
  }

  const deleteCareNote = event.target.closest('[data-delete-care-note]');
  if (deleteCareNote) {
    const care = app.state.spaces.care;
    care.notes = normalizeCareNotes(care.notes || []).filter((note) => note.id !== deleteCareNote.dataset.deleteCareNote);
    markDirty('已删除。');
    return renderActive({ preserveScroll: true, quiet: true });
  }

  const taskBlock = event.target.closest('[data-select-task]');
  if (taskBlock && !event.target.closest('.resize-handle')) {
    selectTaskInPlace(taskBlock.dataset.selectTask);
    return;
  }

  const lifeTodo = event.target.closest('[data-life-todo]');
  if (lifeTodo) {
    const todo = app.state.spaces.life.todos.find((item) => item.id === lifeTodo.dataset.lifeTodo);
    if (todo) {
      todo.done = !todo.done;
      todo.doneBy = todo.done ? currentPerson() : '';
      todo.doneAt = todo.done ? new Date().toISOString() : '';
    }
    markDirty();
    return renderActive({ preserveScroll: true, quiet: true });
  }

  const action = event.target.closest('[data-action]')?.dataset.action;
  if (!action) return;
  if (action === 'start-focus') return startFocus();
  if (action === 'finish-focus') return finishFocus();
  if (action === 'cancel-focus') return cancelFocus();
  if (action === 'focus-prev') return shiftFocusPeriod(-1);
  if (action === 'focus-next') return shiftFocusPeriod(1);
  if (action === 'timeline-prev') return shiftTimeline(-1);
  if (action === 'timeline-next') return shiftTimeline(1);
  if (action === 'timeline-today') { app.state.spaces.planning.anchorDate = today(); markDirty(); return renderActive({ preserveScroll: true, quiet: true }); }
}

function handleContentSubmit(event) {
  const form = event.target.closest('form[data-form]');
  if (!form) return;
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form).entries());
  const id = cryptoId();

  if (form.dataset.form === 'focus-manual') addFocusSession(data.title, `${data.date}T${data.startTime}:00`, `${data.date}T${data.endTime}:00`, 'manual', data.note);
  if (form.dataset.form === 'project') app.state.spaces.planning.projects.push({ id, title: data.title, owner: currentPerson(), status: '进行中', color: pickColor(app.state.spaces.planning.projects.length), start: data.start || today(), end: ensureEnd(data.start, data.end), notes: data.notes || '' });
  if (form.dataset.form === 'task') app.state.spaces.planning.tasks.push({ id, title: data.title, owner: currentPerson(), projectId: data.projectId, start: data.start || today(), end: ensureEnd(data.start, data.end), level: data.level || 'P1', done: false, notes: data.notes || '' });
  if (form.dataset.form === 'task-edit') updateTask(form.dataset.taskId, { ...data, owner: currentPerson(), done: data.done === 'true', end: ensureEnd(data.start, data.end) });
  if (form.dataset.form === 'paper') app.state.spaces.submissions.papers.unshift({ id, owner: currentPerson(), ...data });
  if (form.dataset.form === 'health-note') { app.state.spaces.health.checkins = app.state.spaces.health.checkins || []; app.state.spaces.health.checkins.push({ id, person: currentPerson(), ...data }); }
  if (form.dataset.form === 'health-habit-add') {
    const health = ensureHealth();
    const kind = data.kind === 'count' ? 'count' : 'check';
    health.habits.push({ id, title: data.title, kind, target: kind === 'count' ? Math.max(1, Number(data.target || 1)) : 1, doneBy: { bw: false, sz: false } });
  }
  if (form.dataset.form === 'health-habit-edit') {
    const health = ensureHealth();
    const habit = health.habits.find((item) => item.id === form.dataset.habitId);
    if (habit) {
      habit.title = data.title || habit.title;
      habit.kind = data.kind === 'count' ? 'count' : 'check';
      habit.target = habit.kind === 'count' ? Math.max(1, Number(data.target || 1)) : 1;
    }
  }
  if (form.dataset.form === 'care-note') app.state.spaces.care.notes.unshift({ id, person: currentPerson(), text: data.note });
  if (form.dataset.form === 'life-todo') {
    app.state.spaces.life = app.state.spaces.life || { todos: [] };
    app.state.spaces.life.todos.unshift({ id, person: currentPerson(), text: data.text, date: data.date || today(), createdAt: new Date().toISOString(), done: false, doneBy: '', doneAt: '' });
  }
  if (form.dataset.form === 'memory') {
    app.state.spaces.memories = app.state.spaces.memories || { moments: [] };
    app.state.spaces.memories.moments.unshift({ id, person: currentPerson(), ...data, tags: splitTags(data.tags) });
  }
  if (form.dataset.form === 'mentor-question') app.state.spaces.mentor.questions.unshift({ id, owner: currentPerson(), text: data.question });
  if (form.dataset.form === 'mentor-meeting') app.state.spaces.mentor.meetings.unshift({ id, owner: currentPerson(), ...data });
  if (form.dataset.form === 'badge-task') app.state.spaces.achievements.badgeTasks.push({ id, person: currentPerson(), title: data.title, target: Number(data.target || 1), progress: 0, awarded: false });
  if (form.dataset.form === 'achievement') app.state.spaces.achievements.items.unshift({ id, person: currentPerson(), level: 'manual', ...data });
  markDirty(api.storage === 'firebase' ? '已同步到云端。' : '已自动保存到本地数据库。');
  renderActive({ preserveScroll: true, quiet: true });
}

function handleContentInput(event) {
  const field = event.target.closest('[data-field]');
  if (!field) return;
  setDeep(app.state, field.dataset.field, field.value);
  markDirty();
}


function startFocus() {
  const title = $('#focusTitle')?.value?.trim() || '专注';
  app.state.spaces.focus.active = { id: cryptoId(), person: currentPerson(), title, startedAt: new Date().toISOString() };
  markDirty('专注开始。');
  renderActive({ preserveScroll: true, quiet: true });
  startFocusTicker();
}
function finishFocus() {
  const active = app.state.spaces.focus.active;
  if (!active) return;
  const end = new Date().toISOString();
  addFocusSession(active.title, active.startedAt, end, 'timer');
  app.state.spaces.focus.active = null;
  markDirty('已记录本次专注。');
  renderActive({ preserveScroll: true, quiet: true });
}
function cancelFocus() {
  app.state.spaces.focus.active = null;
  markDirty('已放弃本次专注。');
  renderActive({ preserveScroll: true, quiet: true });
}
function addFocusSession(title, start, end, source, note = '') {
  const minutes = Math.max(1, Math.round((new Date(end) - new Date(start)) / 60000));
  app.state.spaces.focus.sessions.push({ id: cryptoId(), person: currentPerson(), title, start, end, minutes, source, note });
}
function startFocusTicker() {
  clearInterval(app.focusTick);
  app.focusTick = setInterval(() => {
    const active = app.state?.spaces?.focus?.active;
    const node = $('#focusTime');
    if (active && node) node.textContent = formatSeconds(Math.floor((Date.now() - new Date(active.startedAt).getTime()) / 1000));
  }, 1000);
}

function renderTimeline(planning) {
  if (planning.view === 'day') planning.view = 'week';
  const range = timelineRange(planning.view, planning.anchorDate);
  const days = enumerateDays(range.start, range.days);
  const rows = planning.projects.concat([{ id: '', title: '临时任务', color: '#9b5de5', owner: '共同' }]);
  const compactTimeline = window.matchMedia('(max-width: 760px)').matches;
  const labelWidth = compactTimeline ? 86 : 180;
  const dayWidth = planning.view === 'month' ? (compactTimeline ? 48 : 72) : (compactTimeline ? 78 : 112);
  const daysWidth = days.length * dayWidth;
  const width = labelWidth + daysWidth;
  const gridTemplate = `${labelWidth}px repeat(${days.length}, ${dayWidth}px)`;
  return `
    <div class="timeline-scroll" style="--label-width:${labelWidth}px;--day-width:${dayWidth}px;--days-width:${daysWidth}px;--timeline-days:${days.length}">
      <div class="timeline-head" style="width:${width}px;grid-template-columns:${gridTemplate}">
        <div class="timeline-head-spacer">${timelineRangeLabel(planning.view, range.start, range.days)}</div>
        ${days.map((day) => `<div class="timeline-day-head">${formatDayLabel(day, planning.view)}</div>`).join('')}
      </div>
      <div class="timeline-body" style="width:${width}px">
        ${rows.map((row) => {
          const layout = layoutTimelineTasks(planning.tasks.filter((task) => (task.projectId || '') === row.id), range.start, dayWidth, days.length);
          return `
          <div class="timeline-row" style="min-height:${layout.rowHeight}px;width:${width}px;grid-template-columns:${gridTemplate}">
            <div class="timeline-row-label"><span style="background:${escAttr(row.color || '#4d9de0')}"></span>${esc(row.title)}</div>
            <div class="timeline-lane" style="min-height:${layout.rowHeight}px">
              ${layout.items.map((item) => renderTaskBlock(item)).join('')}
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>`;
}

function layoutTimelineTasks(tasks, rangeStart, dayWidth, dayCount) {
  const laneEnds = [];
  const items = tasks
    .slice()
    .sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end))
    .map((task) => {
      const startOffset = clamp(daysBetween(rangeStart, task.start), 0, dayCount - 1);
      const duration = clamp(daysBetween(task.start, task.end) + 1, 1, dayCount);
      const endOffset = startOffset + duration - 1;
      let lane = laneEnds.findIndex((end) => startOffset > end);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(endOffset);
      } else {
        laneEnds[lane] = endOffset;
      }
      return { task, startOffset, duration, lane, dayWidth };
    });
  return { items, rowHeight: Math.max(82, 20 + Math.max(1, laneEnds.length) * 66) };
}

function renderTaskBlock(item) {
  const { task, startOffset, duration, lane } = item;
  const dayWidth = item.dayWidth || 116;
  const left = startOffset * dayWidth + 8;
  const width = Math.max(42, duration * dayWidth - 16);
  const top = 14 + lane * 66;
  const selected = app.state.spaces.planning.selectedTaskId === task.id ? 'selected' : '';
  return `<div class="timeline-task level-${escAttr(task.level || 'P1')} ${task.done ? 'done' : ''} ${selected}" data-select-task="${escAttr(task.id)}" data-drag-task="${escAttr(task.id)}" data-mode="move" style="left:${left}px;top:${top}px;width:${width}px">
    <span class="resize-handle left" data-drag-task="${escAttr(task.id)}" data-mode="resize-left"></span>
    <strong>${esc(task.title)}</strong><small>${esc(task.level || 'P1')} · ${esc(task.start)} → ${esc(task.end)}</small>
    <span class="resize-handle right" data-drag-task="${escAttr(task.id)}" data-mode="resize-right"></span>
  </div>`;
}

content.addEventListener('pointerdown', (event) => {
  const handle = event.target.closest('[data-drag-task]');
  if (!handle) return;
  const task = app.state.spaces.planning.tasks.find((item) => item.id === handle.dataset.dragTask);
  if (!task) return;
  const timeline = event.target.closest('.timeline-scroll');
  const dayWidth = Number(getComputedStyle(timeline).getPropertyValue('--day-width').replace('px', '')) || 100;
  const block = handle.closest('.timeline-task');
  app.drag = {
    taskId: task.id,
    mode: handle.dataset.mode || 'move',
    startX: event.clientX,
    dayWidth,
    originalStart: task.start,
    originalEnd: task.end,
    originalLeft: Number.parseFloat(block.style.left) || 0,
    originalWidth: Number.parseFloat(block.style.width) || block.offsetWidth,
    block,
    moved: false,
    deltaDays: 0
  };
  block.classList.add('dragging');
  handle.setPointerCapture?.(event.pointerId);
});

function handleTimelinePointerMove(event) {
  if (!app.drag) return;
  event.preventDefault();
  const dx = event.clientX - app.drag.startX;
  const delta = Math.round((event.clientX - app.drag.startX) / app.drag.dayWidth);
  if (Math.abs(dx) < 2) return;
  app.drag.moved = true;
  app.drag.deltaDays = delta;
  const block = app.drag.block;
  if (!block) return;
  if (app.drag.mode === 'move') {
    block.style.transform = `translateX(${dx}px)`;
  }
  if (app.drag.mode === 'resize-left') {
    const nextWidth = Math.max(42, app.drag.originalWidth - dx);
    const nextLeft = app.drag.originalLeft + dx;
    block.style.left = `${nextLeft}px`;
    block.style.width = `${nextWidth}px`;
  }
  if (app.drag.mode === 'resize-right') {
    block.style.width = `${Math.max(42, app.drag.originalWidth + dx)}px`;
  }
}
function handleTimelinePointerUp() {
  if (!app.drag) return;
  const drag = app.drag;
  const moved = drag.moved;
  app.drag = null;
  const task = app.state.spaces.planning.tasks.find((item) => item.id === drag.taskId);
  if (task && moved && drag.deltaDays !== 0) {
    if (drag.mode === 'move') {
      task.start = dateAdd(drag.originalStart, drag.deltaDays);
      task.end = dateAdd(drag.originalEnd, drag.deltaDays);
    }
    if (drag.mode === 'resize-left') task.start = minDate(dateAdd(drag.originalStart, drag.deltaDays), task.end);
    if (drag.mode === 'resize-right') task.end = maxDate(dateAdd(drag.originalEnd, drag.deltaDays), task.start);
    app.state.spaces.planning.selectedTaskId = task.id;
    markDirty('时间轴已更新并自动备份。');
  }
  drag.block?.classList.remove('dragging');
  renderActive({ preserveScroll: true, quiet: true });
}

function renderTaskLists(planning) {
  const todayTasks = planning.tasks.filter((task) => dateInRange(today(), task.start, task.end));
  const week = timelineRange('week', today());
  const weekEnd = dateAdd(week.start, week.days - 1);
  const weekTasks = planning.tasks.filter((task) => rangesOverlap(task.start, task.end, week.start, weekEnd));
  return `<h3>今日任务</h3><div class="list compact-list">${todayTasks.map(taskListItem).join('') || '<p class="tiny">今天没有任务。</p>'}</div><h3 class="subhead">本周任务</h3><div class="list compact-list">${weekTasks.map(taskListItem).join('') || '<p class="tiny">本周没有任务。</p>'}</div>`;
}
function taskListItem(task) {
  const selected = app.state.spaces.planning.selectedTaskId === task.id ? 'selected' : '';
  return `<article class="item ${selected}" data-select-task="${escAttr(task.id)}"><div class="item-head"><h3>${esc(task.title)}</h3><span class="chip">${esc(task.level || 'P1')}</span></div><p>${esc(task.start)} → ${esc(task.end)} ${task.done ? '· 已完成' : ''}</p></article>`;
}

function switchTo(key) {
  const module = getModule(key);
  if (module) app.activeArea = module.area || moduleArea(module.key);
  app.active = key;
  renderAreas();
  renderNav();
  renderActive({ preserveScroll: true, quiet: true });
}
function shiftTimeline(direction) {
  const planning = app.state.spaces.planning;
  const days = planning.view === 'month' ? daysInMonth(parseDate(planning.anchorDate || today())) : 7;
  planning.anchorDate = dateAdd(planning.anchorDate || today(), direction * days);
  markDirty(); renderActive({ preserveScroll: true, quiet: true });
}
function updateTask(id, patch) { const task = app.state.spaces.planning.tasks.find((item) => item.id === id); if (task) Object.assign(task, patch); }

async function saveState(immediate = false) {
  if (!app.state) return;
  if (app.saving) {
    app.saveQueued = true;
    return;
  }
  clearTimeout(app.saveTimer);
  const run = async () => {
    app.saving = true;
    app.saveQueued = false;
    try {
      ensurePeople();
      app.state = await api.save(app.state);
      ensurePeople();
          app.dirty = false;
      $('#saveBtn').textContent = api.storage === 'firebase' ? '云端同步已完成' : '自动保存已完成';
    } catch (error) {
      $('#saveBtn').textContent = api.storage === 'firebase' ? '云端同步失败' : '自动保存失败';
      toast(error.message);
    } finally {
      app.saving = false;
      if (app.saveQueued || app.dirty) saveState(true);
    }
  };
  if (immediate) return run();
  app.saveTimer = setTimeout(run, 550);
}
function markDirty(message, immediate = false) {
  app.dirty = true;
  $('#saveBtn').textContent = api.storage === 'firebase' ? '云端同步中…' : '自动保存中…';
  saveState(immediate);
  if (message) toast(message);
}

function focusByPerson() {
  const todayKey = today();
  return (app.state.spaces.focus.sessions || []).reduce((acc, session) => {
    if (session.start?.slice(0, 10) === todayKey) acc[session.person === 'sz' ? 'sz' : 'bw'] += Number(session.minutes || 0);
    return acc;
  }, { bw: 0, sz: 0 });
}

function normalizeCareNotes(notes) {
  return (notes || []).map((note) => {
    if (typeof note === 'string') return { id: cryptoId(), text: note, person: currentPerson() };
    return { id: note.id || cryptoId(), text: note.text || note.note || '', person: note.person || currentPerson() };
  });
}

function ensureHealth() {
  const spaces = app.state.spaces;
  spaces.health = spaces.health || {};
  const health = spaces.health;
  health.habits = Array.isArray(health.habits) ? health.habits : [];
  health.checkins = Array.isArray(health.checkins) ? health.checkins : [];
  health.habitLogs = health.habitLogs && typeof health.habitLogs === 'object' ? health.habitLogs : {};
  health.view = health.view || 'week';
  const todayKey = today();
  health.habitLogs[todayKey] = health.habitLogs[todayKey] || {};
  health.habits.forEach((habit) => {
    habit.id = habit.id || cryptoId();
    habit.title = habit.title || '健康习惯';
    if (!habit.kind) habit.kind = inferHabitKind(habit);
    habit.target = habitTarget(habit);
    if (!health.habitLogs[todayKey][habit.id]) {
      health.habitLogs[todayKey][habit.id] = {
        bw: habit.doneBy?.bw ? habit.target : 0,
        sz: habit.doneBy?.sz ? habit.target : 0
      };
    }
    habit.doneBy = {
      bw: habitValue(habit, 'bw', todayKey) >= habit.target,
      sz: habitValue(habit, 'sz', todayKey) >= habit.target
    };
  });
  return health;
}

function inferHabitKind(habit) {
  if (Number(habit.target || 0) > 1) return 'count';
  if (/饮水|杯|次|护眼|拉伸|番茄/.test(habit.title || '')) return 'count';
  return 'check';
}

function habitTarget(habit) {
  if (habit.kind === 'count') return Math.max(1, Number(habit.target || inferTargetFromTitle(habit.title) || 1));
  return 1;
}

function inferTargetFromTitle(title = '') {
  if (/饮水/.test(title)) return 6;
  if (/护眼|拉伸/.test(title)) return 3;
  const match = String(title).match(/(\d+)/);
  return match ? Number(match[1]) : 1;
}

function healthLog(day, habitId) {
  const health = app.state.spaces.health;
  health.habitLogs = health.habitLogs || {};
  health.habitLogs[day] = health.habitLogs[day] || {};
  health.habitLogs[day][habitId] = health.habitLogs[day][habitId] || { bw: 0, sz: 0 };
  return health.habitLogs[day][habitId];
}

function habitValue(habit, person, day = today()) {
  const log = app.state?.spaces?.health?.habitLogs?.[day]?.[habit.id];
  return Number(log?.[person === 'sz' ? 'sz' : 'bw'] || 0);
}

function setHabitValue(habit, person, value, day = today()) {
  const target = habitTarget(habit);
  const log = healthLog(day, habit.id);
  const key = person === 'sz' ? 'sz' : 'bw';
  log[key] = clamp(Number(value) || 0, 0, habit.kind === 'count' ? Math.max(target, Number(value) || 0) : 1);
  habit.doneBy = habit.doneBy || { bw: false, sz: false };
  habit.doneBy[key] = log[key] >= target;
}

function updateHabitProgress(habitId, action) {
  const health = ensureHealth();
  const habit = health.habits.find((item) => item.id === habitId);
  if (!habit) return;
  const person = currentPerson();
  const current = habitValue(habit, person);
  if (action === 'toggle') setHabitValue(habit, person, current >= habitTarget(habit) ? 0 : habitTarget(habit));
  if (action === 'increment') setHabitValue(habit, person, current + 1);
  if (action === 'decrement') setHabitValue(habit, person, current - 1);
}

function deleteHealthHabit(habitId) {
  const health = ensureHealth();
  health.habits = health.habits.filter((habit) => habit.id !== habitId);
  Object.values(health.habitLogs || {}).forEach((dayLog) => {
    if (dayLog && typeof dayLog === 'object') delete dayLog[habitId];
  });
}

function healthRecordDays(mode) {
  if (mode === 'month') {
    const base = parseDate(today());
    return enumerateDays(firstDayOfMonth(base), daysInMonth(base));
  }
  if (mode === 'week') return enumerateDays(startOfWeek(parseDate(today())), 7);
  return [today()];
}

function healthDaySummary(day) {
  const health = ensureHealth();
  const perPerson = health.habits.length;
  const people = { bw: 0, sz: 0 };
  health.habits.forEach((habit) => {
    for (const person of ['bw', 'sz']) {
      if (habitValue(habit, person, day) >= habitTarget(habit)) people[person] += 1;
    }
  });
  return { people, perPerson, done: people.bw + people.sz, total: perPerson * 2 };
}

function healthDayTitle(day, mode) {
  if (mode === 'month') return String(Number(day.slice(-2)));
  const d = parseDate(day);
  return mode === 'week' ? `${['周一','周二','周三','周四','周五','周六','周日'][(d.getDay() || 7) - 1]} ${day.slice(5)}` : day;
}

function collectMetrics() {
  const focus = app.state.spaces.focus.sessions || [];
  const planning = app.state.spaces.planning;
  const todayKey = today();
  const healthToday = healthDaySummary(todayKey);
  const week = timelineRange('week', todayKey);
  const weekEnd = dateAdd(week.start, week.days - 1);
  return {
    focusToday: focus.filter((s) => s.start.slice(0, 10) === todayKey).reduce((sum, s) => sum + Number(s.minutes || 0), 0),
    focusWeek: focus.filter((s) => dateInRange(s.start.slice(0, 10), week.start, weekEnd)).reduce((sum, s) => sum + Number(s.minutes || 0), 0),
    openTasks: planning.tasks.filter((task) => !task.done).length,
    doneTasks: planning.tasks.filter((task) => task.done).length,
    totalTasks: planning.tasks.length,
    healthDone: healthToday.done,
    healthTotal: healthToday.total,
    mentorOpen: (app.state.spaces.mentor.questions || []).length,
    badges: achievementCatalog().filter((badge) => badge.awarded).length + (app.state.spaces.achievements.items || []).length
  };
}
function focusStats(mode) {
  return focusPeriodStats(mode, today());
}
function focusPeriodStats(mode, anchor) {
  const days = focusPeriodDays(mode, anchor);
  const bars = days.map((day) => {
    const people = focusMinutesByPersonForDate(day);
    const total = people.bw + people.sz;
    return { day, label: focusDayLabel(day, mode), people, total };
  });
  const total = bars.reduce((sum, bar) => sum + bar.total, 0);
  return { bars, total, avg: Math.round(total / Math.max(1, bars.length)), max: Math.max(30, ...bars.map((bar) => bar.total)) };
}
function focusPeriodDays(mode, anchor) {
  const base = parseDate(clampFocusAnchor(mode, anchor || today()));
  if (mode === 'month') return enumerateDays(firstDayOfMonth(base), daysInMonth(base));
  if (mode === 'week') return enumerateDays(startOfWeek(base), 7);
  return [toDateKey(base)];
}
function focusMinutesByPersonForDate(day) {
  return (app.state.spaces.focus.sessions || []).reduce((acc, session) => {
    if (session.start?.slice(0, 10) === day) acc[session.person === 'sz' ? 'sz' : 'bw'] += Number(session.minutes || 0);
    return acc;
  }, { bw: 0, sz: 0 });
}
function renderFocusChart(mode, anchor, stats = focusPeriodStats(mode, anchor)) {
  const safeAnchor = clampFocusAnchor(mode, anchor || today());
  const nextDisabled = !canShiftFocusPeriod(mode, safeAnchor, 1);
  return `
    <div class="focus-chart" data-swipe-period="focus">
      <div class="focus-chart-top">
        <div class="segmented">
          ${['day','week','month'].map((item) => `<button class="${mode === item ? 'active' : ''}" data-focus-mode="${item}">${modeLabel(item)}</button>`).join('')}
        </div>
        <div class="focus-period-nav">
          <button class="mini-button" data-action="focus-prev" aria-label="上一段">←</button>
          <strong>${focusPeriodLabel(mode, safeAnchor)}</strong>
          <button class="mini-button" data-action="focus-next" ${nextDisabled ? 'disabled' : ''} aria-label="下一段">→</button>
        </div>
      </div>
      ${focusLegend()}
      ${mode === 'month' ? renderFocusMonth(stats.bars, safeAnchor, stats.max) : mode === 'week' ? renderFocusWeek(stats.bars, stats.max) : renderFocusDay(stats.bars[0], stats.max)}
    </div>`;
}
function renderFocusDay(bar, max) {
  const total = bar?.total || 0;
  return `
    <div class="focus-day-view">
      <div class="focus-day-stack" aria-label="${escAttr(bar?.label || '')} 专注 ${total} 分钟">${focusStackSegments(bar?.people || { bw: 0, sz: 0 }, max, 'width')}</div>
      <div class="focus-day-meta"><b>${total}</b><span>分钟 · ${esc(bar?.label || '')}</span></div>
    </div>`;
}
function renderFocusWeek(bars, max) {
  return `<div class="focus-week-chart">${bars.map((bar) => `
    <div class="focus-week-item">
      <div class="focus-week-track">${focusStackSegments(bar.people, max, 'height')}</div>
      <b>${bar.total}</b><small>${esc(bar.label)}</small>
    </div>`).join('')}</div>`;
}
function renderFocusMonth(bars, anchor, max) {
  const first = parseDate(firstDayOfMonth(parseDate(anchor)));
  const leading = (first.getDay() || 7) - 1;
  return `<div class="focus-month-wrap">
    <div class="focus-month-grid">
      ${['一','二','三','四','五','六','日'].map((label) => `<div class="focus-month-weekday">${label}</div>`).join('')}
      ${Array.from({ length: leading }, () => '<div class="focus-month-cell empty"></div>').join('')}
      ${bars.map((bar) => `
        <div class="focus-month-cell ${bar.day === today() ? 'today' : ''}">
          <div class="focus-month-date"><span>${Number(bar.day.slice(-2))}</span>${bar.total ? `<b>${bar.total}</b>` : ''}</div>
          <div class="focus-month-stack">${focusStackSegments(bar.people, max, 'width')}</div>
        </div>`).join('')}
    </div>
  </div>`;
}
function focusStackSegments(people, max, axis) {
  const safeMax = Math.max(1, max);
  return ['bw', 'sz'].map((person) => {
    const value = Number(people?.[person] || 0);
    const size = value ? Math.max(4, Math.round((value / safeMax) * 100)) : 0;
    const prop = axis === 'width' ? 'width' : 'height';
    return `<span data-person="${escAttr(person)}" title="${escAttr(personName(person))}: ${value} 分钟" style="${prop}:${size}%"></span>`;
  }).join('');
}
function focusLegend() {
  return `<div class="focus-legend">${['bw','sz'].map((person) => `<span><i data-person="${escAttr(person)}"></i>${esc(personName(person))}</span>`).join('')}</div>`;
}
function shiftFocusPeriod(direction) {
  const focus = app.state.spaces.focus;
  const mode = focus.chartMode || 'week';
  if (direction > 0 && !canShiftFocusPeriod(mode, focus.chartAnchor || today(), direction)) return;
  focus.chartAnchor = clampFocusAnchor(mode, focusShiftedAnchor(mode, focus.chartAnchor || today(), direction));
  markDirty();
  renderActive({ preserveScroll: true, quiet: true });
}

function handleSwipePointerDown(event) {
  const scope = event.target.closest('[data-swipe-period]');
  if (!scope || event.target.closest('button, input, select, textarea, a')) return;
  app.swipe = { scope: scope.dataset.swipePeriod, startX: event.clientX, startY: event.clientY };
}

function handleSwipePointerUp(event) {
  if (!app.swipe) return;
  const swipe = app.swipe;
  app.swipe = null;
  const dx = event.clientX - swipe.startX;
  const dy = event.clientY - swipe.startY;
  if (Math.abs(dx) < 56 || Math.abs(dx) < Math.abs(dy) * 1.25) return;
  if (swipe.scope === 'focus') shiftFocusPeriod(dx < 0 ? 1 : -1);
}

function canShiftFocusPeriod(mode, anchor, direction) {
  if (direction <= 0) return true;
  const next = focusShiftedAnchor(mode, anchor || today(), direction);
  return focusPeriodStart(mode, next) <= focusPeriodStart(mode, today());
}
function focusShiftedAnchor(mode, anchor, direction) {
  const base = parseDate(anchor || today());
  if (mode === 'month') return toDateKey(new Date(base.getFullYear(), base.getMonth() + direction, 1));
  return dateAdd(toDateKey(base), direction * (mode === 'week' ? 7 : 1));
}
function clampFocusAnchor(mode, anchor) {
  const value = anchor || today();
  return focusPeriodStart(mode, value) > focusPeriodStart(mode, today()) ? today() : value;
}
function focusPeriodStart(mode, anchor) {
  const base = parseDate(anchor || today());
  if (mode === 'month') return firstDayOfMonth(base);
  if (mode === 'week') return startOfWeek(base);
  return toDateKey(base);
}
function focusPeriodLabel(mode, anchor) {
  const days = focusPeriodDays(mode, anchor);
  if (mode === 'month') return days[0].slice(0, 7);
  if (mode === 'week') return `${days[0].slice(5)} - ${days.at(-1).slice(5)}`;
  return days[0];
}
function focusDayLabel(day, mode) {
  const d = parseDate(day);
  if (mode === 'week') return ['周一','周二','周三','周四','周五','周六','周日'][(d.getDay() || 7) - 1];
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
function renderBars(bars, max) { return `<div class="bar-chart">${bars.map((bar) => { const value = bar.value ?? bar.total ?? 0; return `<div class="bar-item"><div class="bar-track"><span style="height:${Math.round((value / max) * 100)}%"></span></div><b>${value}</b><small>${esc(bar.label)}</small></div>`; }).join('')}</div>`; }
function peakHour(sessions) {
  const hours = Array.from({ length: 24 }, () => 0);
  sessions.forEach((session) => { hours[new Date(session.start).getHours()] += Number(session.minutes || 0); });
  const max = Math.max(...hours);
  const hour = hours.indexOf(max);
  return max ? `${String(hour).padStart(2, '0')}:00-${String(hour + 1).padStart(2, '0')}:00` : '暂无';
}

function achievementCatalog() {
  const metrics = collectMetricsRaw();
  return [
    { key: 'focus-120', icon: '🔥', title: '深度启动', desc: '单日专注超过 120 分钟', target: 120, progress: Math.min(120, metrics.focusToday), awarded: metrics.focusToday >= 120 },
    { key: 'task-10', icon: '🚀', title: '推进机器', desc: '累计完成 10 个任务', target: 10, progress: Math.min(10, metrics.doneTasks), awarded: metrics.doneTasks >= 10 },
    { key: 'health-full', icon: '🌿', title: '身体优先', desc: '完成全部健康打卡', target: metrics.healthTotal, progress: metrics.healthDone, awarded: metrics.healthTotal > 0 && metrics.healthDone === metrics.healthTotal },
    { key: 'mentor-ready', icon: '🎓', title: '导师会不慌', desc: '记录 3 个导师问题', target: 3, progress: Math.min(3, metrics.mentorQuestions), awarded: metrics.mentorQuestions >= 3 }
  ];
}
function collectMetricsRaw() {
  const focusToday = (app.state.spaces.focus.sessions || []).filter((s) => s.start.slice(0, 10) === today()).reduce((sum, s) => sum + Number(s.minutes || 0), 0);
  const tasks = app.state.spaces.planning.tasks || [];
  const healthToday = healthDaySummary(today());
  return { focusToday, doneTasks: tasks.filter((task) => task.done).length, healthDone: healthToday.done, healthTotal: healthToday.total, mentorQuestions: (app.state.spaces.mentor.questions || []).length };
}
function autoAwardBadges() {
  const achievements = app.state.spaces.achievements;
  achievements.items = achievements.items || [];
  for (const badge of achievementCatalog()) {
    if (badge.awarded && !achievements.items.some((item) => item.autoKey === badge.key)) {
      achievements.items.unshift({ id: cryptoId(), autoKey: badge.key, title: badge.title, date: today(), detail: badge.desc, level: 'auto' });
      markDirty();
    }
  }
}

function areaList() {
  return [
    { key: 'research', title: '科研区', icon: 'R', accent: '#4d9de0' },
    { key: 'life', title: '生活区', icon: 'L', accent: '#ff8c42' }
  ];
}

function ensureModuleAreas() {
  app.state.modules = Array.isArray(app.state.modules) ? app.state.modules.filter((module) => module.key !== 'settings') : [];
  for (const module of defaultModules()) {
    if (!app.state.modules.some((item) => item.key === module.key)) app.state.modules.push({ ...module });
  }
  app.state.modules.forEach((module) => {
    module.area = moduleArea(module.key);
  });
}

function defaultModules() {
  return [
    { key: 'home', area: 'research', title: '科研总览', icon: '⌂', accent: '#ff8c42', description: '' },
    { key: 'focus', area: 'research', title: '专注定时', icon: '◴', accent: '#ff6b8b', description: '' },
    { key: 'planning', area: 'research', title: '项目与日程', icon: '▦', accent: '#4d9de0', description: '' },
    { key: 'submissions', area: 'research', title: '投稿管理', icon: '✉', accent: '#9b5de5', description: '' },
    { key: 'mentor', area: 'research', title: '向上管理导师', icon: '☉', accent: '#6878c8', description: '' },
    { key: 'dashboard', area: 'research', title: '数据看板', icon: '▧', accent: '#3e8795', description: '' },
    { key: 'achievements', area: 'research', title: '成就殿堂', icon: '★', accent: '#f9c74f', description: '' },
    { key: 'life', area: 'life', title: '生活待办', icon: '✓', accent: '#a7c957', description: '' },
    { key: 'health', area: 'life', title: '健康管理', icon: '♥', accent: '#43aa8b', description: '' },
    { key: 'care', area: 'life', title: '心灵关怀', icon: '✦', accent: '#f9c74f', description: '' },
    { key: 'memories', area: 'life', title: '我们的记忆', icon: '♡', accent: '#ff6b8b', description: '' }
  ];
}

function modulesForArea(area) {
  ensureModuleAreas();
  return app.state.modules.filter((module) => module.area === area);
}

function moduleArea(key) {
  if (['life', 'health', 'care', 'memories'].includes(key)) return 'life';
  return 'research';
}


function ensurePeople() {
  app.state.people = app.state.people || {};
  app.state.people.bw = { id: 'bw', name: 'BW', color: '#ff8c42', avatar: DOG_AVATAR, ...(app.state.people.bw || {}) };
  app.state.people.sz = { id: 'sz', name: 'SZ', color: '#4d9de0', avatar: DOG_AVATAR, ...(app.state.people.sz || {}) };
  app.state.people.bw.avatar = normalizeAssetPath(app.state.people.bw.avatar);
  app.state.people.sz.avatar = normalizeAssetPath(app.state.people.sz.avatar);
}


function currentPerson() {
  const value = String(app.user?.person || app.user?.username || '').toLowerCase();
  return value === 'sz' ? 'sz' : 'bw';
}

function personConfig(person) {
  ensurePeople();
  return app.state.people[person === 'sz' ? 'sz' : 'bw'];
}

function personName(person) {
  return personConfig(person).name;
}

function personAvatar(person) {
  return normalizeAssetPath(personConfig(person).avatar || DOG_AVATAR);
}

function personBadge(person) {
  const key = person === 'sz' ? 'sz' : 'bw';
  return `<span class="person-badge" data-person="${escAttr(key)}">${esc(personName(key))}</span>`;
}

function personMini(person, done) {
  const key = person === 'sz' ? 'sz' : 'bw';
  return `<span class="person-mini ${done ? 'done' : ''}" data-person="${escAttr(key)}">${esc(personName(key))}${done ? '✓' : ''}</span>`;
}



function updateIdentityChrome() {
  if (!app.state) return;
  ensurePeople();
  const avatar = document.querySelector('.profile-avatar');
  if (avatar) avatar.src = personAvatar(currentPerson());
  const subtitle = document.querySelector('.side-head span');
  if (subtitle) subtitle.textContent = `当前身份：${personName(currentPerson())}`;
}

function personalProjects() {
  return (app.state.spaces.planning.projects || []).filter((item) => (item.owner || 'bw') === currentPerson());
}

function personalTasks() {
  return (app.state.spaces.planning.tasks || []).filter((item) => (item.owner || 'bw') === currentPerson());
}

function personalPapers() {
  return (app.state.spaces.submissions.papers || []).filter((item) => (item.owner || 'bw') === currentPerson());
}

function personalMentor() {
  const mentor = app.state.spaces.mentor;
  return {
    meetings: (mentor.meetings || []).filter((item) => (item.owner || 'bw') === currentPerson()),
    questions: (mentor.questions || []).filter((item) => (item.owner || 'bw') === currentPerson()),
    followups: (mentor.followups || []).filter((item) => (item.owner || 'bw') === currentPerson())
  };
}

function timelineRange(view, anchor) {
  const base = parseDate(anchor || today());
  if (view === 'month') return { start: firstDayOfMonth(base), days: daysInMonth(base) };
  return { start: dateAdd(toDateKey(base), -3), days: 7 };
}
function enumerateDays(start, count) { return Array.from({ length: count }, (_, index) => dateAdd(start, index)); }
function daysBetween(start, end) { return Math.round((parseDate(end) - parseDate(start)) / 86400000); }
function dateAdd(date, delta) { const d = parseDate(date); d.setDate(d.getDate() + Number(delta)); return toDateKey(d); }
function parseDate(value) { const [y, m, d] = String(value || today()).slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); }
function toDateKey(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
function dateInRange(date, start, end) { return date >= start && date <= end; }
function rangesOverlap(aStart, aEnd, bStart, bEnd) { return aStart <= bEnd && aEnd >= bStart; }
function ensureEnd(start, end) { return maxDate(end || start || today(), start || today()); }
function minDate(a, b) { return a <= b ? a : b; }
function maxDate(a, b) { return a >= b ? a : b; }
function formatDayLabel(day, view) { const d = parseDate(day); return view === 'month' ? `${d.getMonth() + 1}/${d.getDate()}` : new Intl.DateTimeFormat('zh-CN', { weekday: 'short', month: 'numeric', day: 'numeric' }).format(d); }
function timelineRangeLabel(view, start, days) {
  const end = dateAdd(start, days - 1);
  if (view === 'week') return `${start.slice(5)} - ${end.slice(5)}`;
  return `${start.slice(0, 7)}`;
}
function startOfWeek(date) { const d = new Date(date); const day = d.getDay() || 7; d.setDate(d.getDate() - day + 1); return toDateKey(d); }
function firstDayOfMonth(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-01`; }
function daysInMonth(date) { return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate(); }
function formatMemoryDay(day) { const d = parseDate(day); return `${d.getMonth() + 1}/${d.getDate()}`; }
function modeLabel(mode) { return ({ day: '日', week: '周', month: '月' })[mode] || mode; }
function formatSeconds(seconds) { const h = Math.floor(seconds / 3600); const m = Math.floor((seconds % 3600) / 60); const s = seconds % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`; }
function formatDateTime(value) { return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value)); }
function formatTime(value) { return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(value)); }
function today() { return toDateKey(new Date()); }
function pickColor(index) { return ['#ff8c42', '#4d9de0', '#43aa8b', '#ff6b8b', '#9b5de5', '#f9c74f'][index % 6]; }
function normalizeAssetPath(value) { return String(value || DOG_AVATAR).replace(/^\/assets\//, './assets/'); }
function splitTags(value) { return String(value || '').split(/[,，]/).map((tag) => tag.trim()).filter(Boolean); }
function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
function getModule(key) { return app.state.modules.find((module) => module.key === key); }
function setDeep(target, path, value) { const parts = path.split('.'); let cursor = target; for (let i = 0; i < parts.length - 1; i += 1) cursor = cursor[parts[i]]; cursor[parts.at(-1)] = value; }
function cryptoId() { return window.crypto?.randomUUID ? window.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function tickClock() { const now = new Date(); $('#todayText').textContent = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'full' }).format(now); $('#timeText').textContent = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(now); }
function toast(message) { document.querySelectorAll('.toast').forEach((node) => node.remove()); const node = document.createElement('div'); node.className = 'toast'; node.textContent = message; document.body.appendChild(node); setTimeout(() => node.remove(), 2600); }
function esc(value) { return String(value ?? '').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char])); }
function escAttr(value) { return esc(value).replace(/'/g, '&#39;'); }
