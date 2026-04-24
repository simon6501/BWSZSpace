const api = {
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

const app = {
  user: null,
  state: null,
  activeArea: 'research',
  active: 'home',
  dirty: false,
  saving: false,
  saveTimer: null,
  focusTick: null,
  drag: null
};

const $ = (selector) => document.querySelector(selector);
const content = $('#content');

window.addEventListener('DOMContentLoaded', boot);
document.addEventListener('pointermove', handleTimelinePointerMove);
document.addEventListener('pointerup', handleTimelinePointerUp);

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

  $('#saveBtn').addEventListener('click', () => toast('已开启自动保存：每次修改都会写入 SQLite 并生成最新备份。'));
  $('#exportBtn').addEventListener('click', showBackupInfo);
  content.addEventListener('click', handleContentClick);
  content.addEventListener('submit', handleContentSubmit);
  content.addEventListener('input', handleContentInput);
}

async function enterApp() {
  app.state = await api.state();
  ensureModuleAreas();
  app.activeArea = 'research';
  app.active = 'home';
  $('#loginView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
  $('#logoutBtn').classList.toggle('hidden', Boolean(app.user?.loginDisabled));
  $('#saveBtn').textContent = '自动保存已开启';
  $('#exportBtn').textContent = '备份记录';
  renderAreas();
  renderNav();
  renderActive();
  startFocusTicker();
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
      <i>${esc(mod.icon)}</i><span>${esc(mod.title)}</span>
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

function renderFocus() {
  const focus = app.state.spaces.focus;
  const active = focus.active;
  const elapsed = active ? Math.max(0, Math.floor((Date.now() - new Date(active.startedAt).getTime()) / 1000)) : 0;
  const stats = focusStats(focus.chartMode || 'week');
  const peak = peakHour(focus.sessions || []);

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
    <div class="segmented">
      ${['day','week','month'].map((mode) => `<button class="${focus.chartMode === mode ? 'active' : ''}" data-focus-mode="${mode}">${modeLabel(mode)}</button>`).join('')}
    </div>
    ${renderBars(stats.bars, stats.max)}
    <div class="insight-row">
      <span class="chip">总计 ${stats.total} 分钟</span>
      <span class="chip">平均 ${stats.avg} 分钟</span>
      <span class="chip">更专注时段 ${peak}</span>
    </div>
  `, 'full');

  addCard('最近记录', '自动保存到本地 SQLite。', `
    <div class="list compact-list">
      ${(focus.sessions || []).slice().reverse().slice(0, 8).map((session) => `
        <article class="item"><div class="item-head"><h3>${esc(session.title || '专注')}</h3><span class="chip">${session.minutes} 分钟</span></div><p>${formatDateTime(session.start)} - ${formatTime(session.end)} · ${esc(session.source || 'timer')}</p></article>
      `).join('') || '<p class="tiny">还没有专注记录。</p>'}
    </div>
  `, 'full');
}

function renderPlanning() {
  const planning = app.state.spaces.planning;
  const selected = planning.tasks.find((task) => task.id === planning.selectedTaskId) || planning.tasks[0];
  if (selected && !planning.selectedTaskId) planning.selectedTaskId = selected.id;

  addCard('新增长期项目', '项目是容器，任务才进入时间轴。', `
    <form class="form-grid" data-form="project">
      <label>项目名<input name="title" required placeholder="例如：期刊返修 / 家庭网站 / 实验平台"></label>
      <label>负责人<input name="owner" placeholder="BW / SZ / 共同" value="共同"></label>
      <label>开始日期<input name="start" type="date" value="${today()}"></label>
      <label>结束日期<input name="end" type="date" value="${dateAdd(today(), 14)}"></label>
      <label class="full">备注<textarea name="notes" placeholder="例如：目标、边界、风险"></textarea></label>
      <button class="primary-button full">添加长期项目</button>
    </form>
  `, 'wide');

  addCard('添加任务 / 临时任务', '任务可以归属项目，也可以作为临时任务存在；level 用来表达优先级。', `
    <form class="form-grid" data-form="task">
      <label>任务名<input name="title" required placeholder="例如：补一张消融实验图"></label>
      <label>归属项目<select name="projectId"><option value="">临时任务</option>${planning.projects.map((project) => `<option value="${escAttr(project.id)}">${esc(project.title)}</option>`).join('')}</select></label>
      <label>开始日期<input name="start" type="date" value="${today()}"></label>
      <label>结束日期<input name="end" type="date" value="${dateAdd(today(), 1)}"></label>
      <label>Level<select name="level"><option>P0</option><option selected>P1</option><option>P2</option><option>P3</option></select></label>
      <label>状态<select name="done"><option value="false">未完成</option><option value="true">已完成</option></select></label>
      <label class="full">具体内容<textarea name="notes" placeholder="例如：验收标准、资料链接、上下文"></textarea></label>
      <button class="primary-button full">添加到时间轴</button>
    </form>
  `);

  addCard('Project Timeline', '拖动任务块改变开始时间；拖左右边缘拉长或缩短。', `
    <div class="timeline-toolbar">
      <div class="segmented">${['week','month'].map((mode) => `<button class="${planning.view === mode ? 'active' : ''}" data-planning-view="${mode}">${modeLabel(mode)}</button>`).join('')}</div>
      <div class="action-row"><button class="mini-button" data-action="timeline-prev">←</button><button class="mini-button" data-action="timeline-today">今天</button><button class="mini-button" data-action="timeline-next">→</button></div>
    </div>
    ${renderTimeline(planning)}
  `, 'full');

  addCard('任务详情', '点击任务块或列表后在这里修改。', `<div id="taskDetailSlot">${renderTaskEditor(selected, planning)}</div>`, 'wide');

  addCard('每日 / 每周任务', '同一批任务换一个更轻的列表视角。', renderTaskLists(planning));
}

function renderSubmissions() {
  const papers = app.state.spaces.submissions.papers || [];
  addCard('投稿流水线', '保留轻量投稿管理，后续可接入项目时间轴。', `
    <div class="list">${papers.map((paper) => `<article class="item"><div class="item-head"><h3>${esc(paper.title)}</h3><span class="chip">${esc(paper.stage)}</span></div><p>目标：${esc(paper.venue || 'TBD')} · 截止：${esc(paper.deadline || '未设定')}</p><p>下一步：${esc(paper.next || '待补充')}</p></article>`).join('')}</div>
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
  const health = app.state.spaces.health;
  const habits = health.habits || [];
  addCard('今日健康打卡', '照参考工作站的逻辑：低摩擦、当天可见、不要制造负担。', `<div class="list">${habits.map((habit) => `<button class="habit-button ${habit.done ? 'done' : ''}" data-habit="${escAttr(habit.id)}">${habit.done ? '✓' : '○'} ${esc(habit.title)}</button>`).join('')}</div>`, 'wide');
  addCard('健康记录 / 请假', '可以记录状态，不要求解释原因。', `
    <form class="form-grid" data-form="health-note">
      <label>类别<select name="type"><option>恢复</option><option>病假</option><option>运动</option><option>睡眠</option><option>用眼</option></select></label>
      <label>日期<input name="date" type="date" value="${today()}"></label>
      <label class="full">记录<textarea name="note" placeholder="例如：今天低能量，改成恢复优先。"></textarea></label>
      <button class="primary-button full">记录健康状态</button>
    </form>
  `);
  addCard('最近健康状态', '从工作强度里给身体留出位置。', `<div class="list compact-list">${(health.checkins || []).slice().reverse().slice(0, 8).map((item) => `<article class="item"><div class="item-head"><h3>${esc(item.type)}</h3><span class="chip">${esc(item.date)}</span></div><p>${esc(item.note || '')}</p></article>`).join('') || '<p class="tiny">还没有健康记录。</p>'}</div>`, 'full');
}

function renderCare() {
  const care = app.state.spaces.care;
  addCard('心情温度', '关系不是附属模块，是系统稳定性的核心。', `<label>现在的状态<input data-field="spaces.care.mood" value="${escAttr(care.mood || '')}"></label>`);
  addCard('鼓励与感谢', '保存那些容易被忙碌冲掉的小事。', `<div class="list">${(care.notes || []).map((note) => `<p class="item">${esc(note)}</p>`).join('')}</div><form data-form="care-note" class="action-row"><input name="note" required placeholder="今天想感谢 / 鼓励对方的一句话"><button class="mini-button">添加</button></form>`, 'wide');
}

function renderLife() {
  const life = app.state.spaces.life || { todos: [] };
  const todos = life.todos || [];
  const open = todos.filter((todo) => !todo.done).length;
  addCard('加一个生活待办', '不需要项目、不需要时间轴，就写一句要做什么。', `
    <form class="todo-add" data-form="life-todo">
      <input name="text" required placeholder="例如：取快递 / 买牛奶 / 订周末餐厅">
      <button class="primary-button">添加</button>
    </form>
    <p class="tiny">还剩 ${open} 件小事没做。</p>
  `, 'wide');

  addCard('生活 Todo List', '简单一点：做完点一下就划掉。', `
    <div class="todo-list">
      ${todos.map((todo) => `
        <button class="todo-row ${todo.done ? 'done' : ''}" data-life-todo="${escAttr(todo.id)}">
          <span>${todo.done ? '✓' : ''}</span>
          <strong>${esc(todo.text)}</strong>
        </button>
      `).join('') || '<p class="tiny">还没有生活待办。</p>'}
    </div>
  `, 'full');
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
            <div class="item-head"><h3>${esc(moment.title)}</h3><span class="chip">${esc(moment.type || 'moment')}</span></div>
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
  const mentor = app.state.spaces.mentor;
  addCard('导师会准备', '照参考工作站：议程、材料、问题、follow-up 分开。', `
    <form class="form-grid" data-form="mentor-meeting">
      <label>日期<input name="date" type="date" value="${today()}"></label><label>主题<input name="topic" value="下次导师会" required></label>
      <label class="full">议程 / 材料<textarea name="agenda" placeholder="例如：进度、风险、需要导师拍板的问题"></textarea></label>
      <button class="primary-button full">新增导师会</button>
    </form>
  `, 'wide');
  addCard('问题池', '把不确定性整理成可决策问题。', `<div class="list">${(mentor.questions || []).map((q) => `<p class="item">${esc(q)}</p>`).join('')}</div><form data-form="mentor-question" class="action-row"><input name="question" required placeholder="新增一个需要导师回答的问题"><button class="mini-button">添加</button></form>`);
  addCard('会议与跟进', '每次会后留证据。', `<div class="list compact-list">${(mentor.meetings || []).slice().reverse().map((m) => `<article class="item"><div class="item-head"><h3>${esc(m.topic)}</h3><span class="chip">${esc(m.date || '待定')}</span></div><p>${esc(m.agenda || '')}</p></article>`).join('')}</div>`, 'full');
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
  addCard('本地数据库状态', '数据写入 SQLite；每次修改自动生成 latest 备份。', `<p><code>data/bwsz-space.sqlite</code></p><p><code>data/backups/bwsz-space-latest.sqlite</code></p><p class="tiny">不再需要手动备份按钮，拖拽/编辑后的保存会自动触发。</p>`);
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
  if (slot) slot.innerHTML = renderTaskEditor(task, planning);
}

function addCard(title, description, body, width = '') {
  const article = document.createElement('article');
  article.className = `panel-card ${width}`.trim();
  article.innerHTML = `<div class="panel-title"><div><h2>${esc(title)}</h2><p>${esc(description || '')}</p></div></div>${body}`;
  content.appendChild(article);
}

function handleContentClick(event) {
  const jump = event.target.closest('[data-jump]');
  if (jump) return switchTo(jump.dataset.jump);

  const focusMode = event.target.closest('[data-focus-mode]');
  if (focusMode) { app.state.spaces.focus.chartMode = focusMode.dataset.focusMode; markDirty(); return renderActive({ preserveScroll: true, quiet: true }); }

  const planningView = event.target.closest('[data-planning-view]');
  if (planningView) { app.state.spaces.planning.view = planningView.dataset.planningView; markDirty(); return renderActive({ preserveScroll: true, quiet: true }); }

  const habit = event.target.closest('[data-habit]');
  if (habit) {
    const item = app.state.spaces.health.habits.find((candidate) => candidate.id === habit.dataset.habit);
    if (item) item.done = !item.done;
    habit.classList.toggle('done', Boolean(item?.done));
    habit.textContent = `${item.done ? '✓' : '○'} ${item.title}`;
    markDirty();
    return;
  }

  const taskBlock = event.target.closest('[data-select-task]');
  if (taskBlock && !event.target.closest('.resize-handle')) {
    selectTaskInPlace(taskBlock.dataset.selectTask);
    return;
  }

  const lifeTodo = event.target.closest('[data-life-todo]');
  if (lifeTodo) {
    const todo = app.state.spaces.life.todos.find((item) => item.id === lifeTodo.dataset.lifeTodo);
    if (todo) todo.done = !todo.done;
    lifeTodo.classList.toggle('done', Boolean(todo?.done));
    lifeTodo.querySelector('span').textContent = todo?.done ? '✓' : '';
    markDirty();
    return;
  }

  const action = event.target.closest('[data-action]')?.dataset.action;
  if (!action) return;
  if (action === 'start-focus') return startFocus();
  if (action === 'finish-focus') return finishFocus();
  if (action === 'cancel-focus') return cancelFocus();
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
  if (form.dataset.form === 'project') app.state.spaces.planning.projects.push({ id, title: data.title, owner: data.owner || '共同', status: '进行中', color: pickColor(app.state.spaces.planning.projects.length), start: data.start || today(), end: ensureEnd(data.start, data.end), notes: data.notes || '' });
  if (form.dataset.form === 'task') app.state.spaces.planning.tasks.push({ id, title: data.title, projectId: data.projectId, start: data.start || today(), end: ensureEnd(data.start, data.end), level: data.level || 'P1', done: data.done === 'true', notes: data.notes || '' });
  if (form.dataset.form === 'task-edit') updateTask(form.dataset.taskId, { ...data, done: data.done === 'true', end: ensureEnd(data.start, data.end) });
  if (form.dataset.form === 'paper') app.state.spaces.submissions.papers.unshift({ id, ...data });
  if (form.dataset.form === 'health-note') { app.state.spaces.health.checkins = app.state.spaces.health.checkins || []; app.state.spaces.health.checkins.push({ id, ...data }); }
  if (form.dataset.form === 'care-note') app.state.spaces.care.notes.unshift(data.note);
  if (form.dataset.form === 'life-todo') {
    app.state.spaces.life = app.state.spaces.life || { todos: [] };
    app.state.spaces.life.todos.unshift({ id, text: data.text, done: false });
  }
  if (form.dataset.form === 'memory') {
    app.state.spaces.memories = app.state.spaces.memories || { moments: [] };
    app.state.spaces.memories.moments.unshift({ id, ...data, tags: splitTags(data.tags) });
  }
  if (form.dataset.form === 'mentor-question') app.state.spaces.mentor.questions.unshift(data.question);
  if (form.dataset.form === 'mentor-meeting') app.state.spaces.mentor.meetings.unshift({ id, ...data });
  if (form.dataset.form === 'badge-task') app.state.spaces.achievements.badgeTasks.push({ id, title: data.title, target: Number(data.target || 1), progress: 0, awarded: false });
  if (form.dataset.form === 'achievement') app.state.spaces.achievements.items.unshift({ id, level: 'manual', ...data });

  markDirty('已自动保存到本地数据库。');
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
  app.state.spaces.focus.active = { id: cryptoId(), title, startedAt: new Date().toISOString() };
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
  app.state.spaces.focus.sessions.push({ id: cryptoId(), title, start, end, minutes, source, note });
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
  const labelWidth = 180;
  const dayWidth = planning.view === 'month' ? 72 : planning.view === 'week' ? 112 : 160;
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
  if (!app.state || app.saving) return;
  clearTimeout(app.saveTimer);
  const run = async () => {
    app.saving = true;
    try {
      app.state = await api.save(app.state);
      app.dirty = false;
      $('#saveBtn').textContent = '自动保存已完成';
    } catch (error) {
      $('#saveBtn').textContent = '自动保存失败';
      toast(error.message);
    } finally {
      app.saving = false;
    }
  };
  if (immediate) return run();
  app.saveTimer = setTimeout(run, 550);
}
function markDirty(message) {
  app.dirty = true;
  $('#saveBtn').textContent = '自动保存中…';
  saveState();
  if (message) toast(message);
}
async function showBackupInfo() {
  try {
    const backups = await api.backups();
    toast(`最近备份：${backups[0]?.createdAt ? formatDateTime(backups[0].createdAt) : '尚无记录'}`);
  } catch (error) { toast(error.message); }
}

function collectMetrics() {
  const focus = app.state.spaces.focus.sessions || [];
  const planning = app.state.spaces.planning;
  const habits = app.state.spaces.health.habits || [];
  const todayKey = today();
  const week = timelineRange('week', todayKey);
  const weekEnd = dateAdd(week.start, week.days - 1);
  return {
    focusToday: focus.filter((s) => s.start.slice(0, 10) === todayKey).reduce((sum, s) => sum + Number(s.minutes || 0), 0),
    focusWeek: focus.filter((s) => dateInRange(s.start.slice(0, 10), week.start, weekEnd)).reduce((sum, s) => sum + Number(s.minutes || 0), 0),
    openTasks: planning.tasks.filter((task) => !task.done).length,
    doneTasks: planning.tasks.filter((task) => task.done).length,
    totalTasks: planning.tasks.length,
    healthDone: habits.filter((habit) => habit.done).length,
    healthTotal: habits.length,
    mentorOpen: (app.state.spaces.mentor.questions || []).length,
    badges: achievementCatalog().filter((badge) => badge.awarded).length + (app.state.spaces.achievements.items || []).length
  };
}
function focusStats(mode) {
  const sessions = app.state.spaces.focus.sessions || [];
  const days = mode === 'month' ? 30 : mode === 'week' ? 7 : 1;
  const labels = enumerateDays(dateAdd(today(), -(days - 1)), days);
  const bars = labels.map((day) => ({ label: mode === 'day' ? '今天' : day.slice(5), value: sessions.filter((s) => s.start.slice(0, 10) === day).reduce((sum, s) => sum + Number(s.minutes || 0), 0) }));
  const total = bars.reduce((sum, bar) => sum + bar.value, 0);
  return { bars, total, avg: Math.round(total / Math.max(1, bars.length)), max: Math.max(30, ...bars.map((bar) => bar.value)) };
}
function renderBars(bars, max) { return `<div class="bar-chart">${bars.map((bar) => `<div class="bar-item"><div class="bar-track"><span style="height:${Math.round((bar.value / max) * 100)}%"></span></div><b>${bar.value}</b><small>${esc(bar.label)}</small></div>`).join('')}</div>`; }
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
  const habits = app.state.spaces.health.habits || [];
  return { focusToday, doneTasks: tasks.filter((task) => task.done).length, healthDone: habits.filter((h) => h.done).length, healthTotal: habits.length, mentorQuestions: (app.state.spaces.mentor.questions || []).length };
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
  app.state.modules.forEach((module) => {
    module.area = module.area || moduleArea(module.key);
  });
}

function modulesForArea(area) {
  ensureModuleAreas();
  return app.state.modules.filter((module) => module.area === area);
}

function moduleArea(key) {
  if (['life', 'health', 'care', 'memories'].includes(key)) return 'life';
  return 'research';
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
function today() { return new Date().toISOString().slice(0, 10); }
function pickColor(index) { return ['#ff8c42', '#4d9de0', '#43aa8b', '#ff6b8b', '#9b5de5', '#f9c74f'][index % 6]; }
function splitTags(value) { return String(value || '').split(/[,，]/).map((tag) => tag.trim()).filter(Boolean); }
function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
function getModule(key) { return app.state.modules.find((module) => module.key === key); }
function setDeep(target, path, value) { const parts = path.split('.'); let cursor = target; for (let i = 0; i < parts.length - 1; i += 1) cursor = cursor[parts[i]]; cursor[parts.at(-1)] = value; }
function cryptoId() { return window.crypto?.randomUUID ? window.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function tickClock() { const now = new Date(); $('#todayText').textContent = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'full' }).format(now); $('#timeText').textContent = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(now); }
function toast(message) { document.querySelectorAll('.toast').forEach((node) => node.remove()); const node = document.createElement('div'); node.className = 'toast'; node.textContent = message; document.body.appendChild(node); setTimeout(() => node.remove(), 2600); }
function esc(value) { return String(value ?? '').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char])); }
function escAttr(value) { return esc(value).replace(/'/g, '&#39;'); }
