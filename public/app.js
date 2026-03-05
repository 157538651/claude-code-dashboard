let currentProject = null;
let currentSessionId = null;
let ws = null;
let term = null;
let fitAddon = null;
let lastCols = 0;
let lastRows = 0;
let projectsCache = [];
let sessionsCache = [];
let pendingAction = null;
let authToken = localStorage.getItem('authToken') || '';
let currentUser = localStorage.getItem('currentUser') || '';

// ---- 认证 ----

function authHeaders() {
    return authToken ? { 'Authorization': `Bearer ${authToken}` } : {};
}

async function authFetch(url, opts = {}) {
    opts.headers = { ...opts.headers, ...authHeaders() };
    const res = await fetch(url, opts);
    if (res.status === 401) {
        authToken = '';
        localStorage.removeItem('authToken');
        localStorage.removeItem('currentUser');
        showLogin();
        throw new Error('未登录');
    }
    return res;
}

async function checkAuth() {
    try {
        const res = await fetch('/api/auth/status', { headers: authHeaders() });
        const data = await res.json();
        if (data.loggedIn) {
            currentUser = data.username;
            showApp();
        } else {
            showLogin(data.hasUsers);
        }
    } catch {
        showLogin(false);
    }
}

function showLogin(hasUsers) {
    document.getElementById('loginOverlay').style.display = 'flex';
    document.getElementById('appMain').style.display = 'none';
    const title = document.getElementById('loginTitle');
    const submitBtn = document.getElementById('loginSubmit');
    if (!hasUsers) {
        title.textContent = '创建账户';
        submitBtn.textContent = '注册';
        submitBtn.onclick = () => doAuth('/api/register');
    } else {
        title.textContent = '登录';
        submitBtn.textContent = '登录';
        submitBtn.onclick = () => doAuth('/api/login');
    }
    document.getElementById('loginError').textContent = '';
}

function showApp() {
    document.getElementById('loginOverlay').style.display = 'none';
    document.getElementById('appMain').style.display = 'flex';
    document.getElementById('currentUserName').textContent = currentUser;
    initApp();
}

async function doAuth(endpoint) {
    const username = document.getElementById('loginUsername').value.trim();
    const password = document.getElementById('loginPassword').value;
    const errorEl = document.getElementById('loginError');
    if (!username || !password) { errorEl.textContent = '请填写用户名和密码'; return; }
    try {
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (res.ok) {
            authToken = data.token;
            currentUser = data.username;
            localStorage.setItem('authToken', authToken);
            localStorage.setItem('currentUser', currentUser);
            showApp();
        } else {
            errorEl.textContent = data.error;
        }
    } catch (e) {
        errorEl.textContent = e.message;
    }
}

function logout() {
    if (!confirm('确定退出登录？')) return;
    authToken = '';
    currentUser = '';
    localStorage.removeItem('authToken');
    localStorage.removeItem('currentUser');
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (ws) {
        ws.onclose = null; // 阻止触发自动重连
        ws.close();
        ws = null;
    }
    appInitialized = false;
    showLogin(true);
}

// ---- UI 辅助 ----

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function showSessionActions() {
    document.getElementById('sessionActions').style.display = 'flex';
}

function hideSessionActions() {
    document.getElementById('sessionActions').style.display = 'none';
}

function formatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

// ---- Toast 通知 ----

function showToast(message) {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
        toast.classList.add('fade-out');
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// ---- 终端 ----

function initTerminal() {
    term = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: 'Monaco, Menlo, "Courier New", monospace',
        theme: {
            background: '#1a1a1a',
            foreground: '#e0e0e0',
            cursor: '#e0e0e0',
            selectionBackground: '#3a5a8a'
        },
        allowProposedApi: true
    });

    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);

    term.open(document.getElementById('terminal'));

    term.onData((data) => {
        wsSend({ type: 'input', data });
    });

    window.addEventListener('resize', doFit);
}

function doFit() {
    const wrapper = document.getElementById('terminalWrapper');
    if (!wrapper.classList.contains('active')) return;

    const rect = wrapper.getBoundingClientRect();
    const termEl = document.getElementById('terminal');
    termEl.style.width = rect.width + 'px';
    termEl.style.height = rect.height + 'px';

    fitAddon.fit();

    if (term.cols !== lastCols || term.rows !== lastRows) {
        lastCols = term.cols;
        lastRows = term.rows;
        wsSend({ type: 'resize', cols: term.cols, rows: term.rows });
    }
}

// ---- WebSocket ----

let reconnectTimer = null;
let reconnectDelay = 3000;
const RECONNECT_MAX_DELAY = 30000;

function connectWebSocket() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}?token=${encodeURIComponent(authToken)}`);

    ws.onopen = () => {
        reconnectDelay = 3000; // 连接成功，重置退避
        // 执行 pending action（如 reconnect 触发的新建会话）
        if (pendingAction) {
            const action = pendingAction;
            pendingAction = null;
            action();
        } else if (currentSessionId) {
            attachSession(currentSessionId);
        }
    };

    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'output') {
            term.write(msg.data);
        } else if (msg.type === 'replay') {
            term.write(msg.data);
        } else if (msg.type === 'started') {
            currentSessionId = msg.sessionId;
            hideSessionActions();
            document.getElementById('killBtn').style.display = '';
            loadSessions();
        } else if (msg.type === 'attached') {
            currentSessionId = msg.sessionId;
            hideSessionActions();
            document.getElementById('killBtn').style.display = '';
            loadSessions();
        } else if (msg.type === 'detached') {
            term.writeln('\r\n\x1b[33m--- 会话已被其他连接接管 ---\x1b[0m');
        } else if (msg.type === 'exit') {
            term.writeln('\r\n\x1b[90m--- 会话已结束 ---\x1b[0m');
            term.writeln('\x1b[90m点击右上角「恢复对话」继续，或「新对话」重新开始\x1b[0m');
            currentSessionId = null;
            document.getElementById('killBtn').style.display = 'none';
            showSessionActions();
            loadSessions();
        } else if (msg.type === 'notify') {
            showToast(msg.message);
            loadSessions();
        } else if (msg.type === 'error') {
            term.writeln(`\r\n\x1b[31m${msg.data}\x1b[0m`);
        }
    };

    ws.onclose = () => {
        reconnectTimer = setTimeout(connectWebSocket, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_DELAY);
    };
}

function wsSend(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
    }
}

function startNewSession(projectId, resume) {
    term.clear();
    currentSessionId = null;
    hideSessionActions();
    setTimeout(() => {
        doFit();
        wsSend({ type: 'start', projectId, resume: !!resume, cols: term.cols, rows: term.rows });
    }, 50);
}

function attachSession(sessionId) {
    term.clear();
    setTimeout(() => {
        doFit();
        wsSend({ type: 'attach', sessionId });
    }, 50);
}

async function killSession(sessionId) {
    const id = sessionId || currentSessionId;
    if (!id) return;
    try {
        await authFetch(`/api/sessions/${id}`, { method: 'DELETE' });
    } catch {}
    // 主动刷新，不依赖 onExit 推送
    loadSessions();
}

function reconnect(resume) {
    if (!currentProject) return;
    hideSessionActions();
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        pendingAction = () => startNewSession(currentProject.id, resume);
        connectWebSocket();
    } else {
        startNewSession(currentProject.id, resume);
    }
}

// ---- 会话管理 ----

async function loadSessions() {
    try {
        const res = await authFetch('/api/sessions');
        sessionsCache = await res.json();
    } catch {
        sessionsCache = [];
    }
    renderProjects();
    renderSessions();
}

function getProjectSessions(projectId) {
    return sessionsCache.filter(s => s.projectId === projectId);
}

function getLatestSession(sessions) {
    if (sessions.length === 0) return null;
    return [...sessions].sort((a, b) => b.lastActivity - a.lastActivity)[0];
}

function renderSessions() {
    const list = document.getElementById('sessionList');
    if (!list) return;

    if (sessionsCache.length === 0) {
        list.innerHTML = '<div style="color:#555;text-align:center;padding:10px;font-size:11px;">无活跃会话</div>';
        return;
    }

    list.innerHTML = sessionsCache.map(s => {
        const isCurrent = s.id === currentSessionId;
        const project = projectsCache.find(p => p.id === s.projectId);
        const name = escapeHtml(project ? project.name : s.projectId);
        if (s.stale) {
            return `
            <div class="session-item stale" onclick="resumeStaleSession('${escapeHtml(s.id)}', '${escapeHtml(s.projectId)}')">
                <div class="session-info">
                    <span class="session-dot" style="background:#f0ad4e"></span>
                    <span class="session-name">${name}</span>
                    <span class="session-time" style="color:#f0ad4e">重启丢失·点击恢复</span>
                </div>
                <button class="session-close" onclick="event.stopPropagation();killSession('${escapeHtml(s.id)}')" title="清除">&times;</button>
            </div>`;
        }
        return `
        <div class="session-item ${isCurrent ? 'active' : ''}" onclick="switchSession('${escapeHtml(s.id)}', '${escapeHtml(s.projectId)}')">
            <div class="session-info">
                <span class="session-dot"></span>
                <span class="session-name">${name}</span>
                <span class="session-time">${formatTime(s.createdAt)}</span>
            </div>
            <button class="session-close" onclick="event.stopPropagation();killSession('${escapeHtml(s.id)}')" title="关闭">&times;</button>
        </div>`;
    }).join('');
}

async function resumeStaleSession(staleId, projectId) {
    // 清除 stale 记录，然后对该项目发起 claude --resume
    try { await authFetch(`/api/sessions/${staleId}`, { method: 'DELETE' }); } catch {}
    const project = projectsCache.find(p => p.id === projectId);
    if (project) {
        currentProject = project;
        document.getElementById('projectTitle').textContent = project.name;
        document.getElementById('headerProjectPath').textContent = project.path;
    }
    document.getElementById('emptyState').classList.add('hidden');
    document.getElementById('terminalWrapper').classList.add('active');
    closeSidebar();
    if (ws && ws.readyState === WebSocket.OPEN) {
        startNewSession(projectId, true);
    } else {
        pendingAction = () => startNewSession(projectId, true);
        connectWebSocket();
    }
    term.focus();
}

function switchSession(sessionId, projectId) {
    const project = projectsCache.find(p => p.id === projectId);
    if (project) {
        currentProject = project;
        document.getElementById('projectTitle').textContent = project.name;
        document.getElementById('headerProjectPath').textContent = project.path;
    }

    document.getElementById('emptyState').classList.add('hidden');
    document.getElementById('terminalWrapper').classList.add('active');
    hideSessionActions();

    renderProjects();
    closeSidebar();

    if (ws && ws.readyState === WebSocket.OPEN) {
        attachSession(sessionId);
    } else {
        currentSessionId = sessionId;
        connectWebSocket();
    }

    term.focus();
}

// ---- 项目列表 ----

async function loadProjects() {
    const response = await authFetch('/api/projects');
    projectsCache = await response.json();
    await loadSessions();
}

function renderProjects() {
    const list = document.getElementById('projectList');

    if (projectsCache.length === 0) {
        list.innerHTML = '<div style="color:#666;text-align:center;padding:20px;font-size:12px;line-height:1.6;">将项目放在 ~/projects/ 下<br>即可自动发现<br><span style="color:#555;font-size:11px;">或在下方粘贴 git 地址 clone</span></div>';
        return;
    }

    list.innerHTML = projectsCache.map(p => {
        const sessions = getProjectSessions(p.id);
        const isActive = currentProject && currentProject.id === p.id;
        const count = sessions.length;
        const name = escapeHtml(p.name);
        const desc = escapeHtml(p.path);
        return `
        <div class="project-item ${isActive ? 'active' : ''}"
             onclick="selectProject('${escapeHtml(p.id)}')">
            <div class="project-name">
                ${count > 0 ? '<span class="session-dot"></span>' : ''}${name}
                ${count > 1 ? `<span class="session-count">${count}</span>` : ''}
            </div>
            <div class="project-desc">${desc}</div>
        </div>`;
    }).join('');
}

// ---- 项目选择 ----

async function selectProject(projectId) {
    if (projectsCache.length === 0) await loadProjects();
    currentProject = projectsCache.find(p => p.id === projectId);
    if (!currentProject) return;

    document.getElementById('projectTitle').textContent = currentProject.name;
    document.getElementById('headerProjectPath').textContent = currentProject.path;

    document.getElementById('emptyState').classList.add('hidden');
    document.getElementById('terminalWrapper').classList.add('active');
    hideSessionActions();

    renderProjects();
    closeSidebar();

    const liveSessions = getProjectSessions(projectId).filter(s => !s.stale);
    const latest = getLatestSession(liveSessions);

    if (ws && ws.readyState === WebSocket.OPEN) {
        if (latest) {
            attachSession(latest.id);
        } else {
            startNewSession(projectId);
        }
    } else {
        currentSessionId = latest ? latest.id : null;
        connectWebSocket();
    }

    term.focus();
}

// ---- Clone ----

async function cloneRepo() {
    const input = document.getElementById('cloneInput');
    const status = document.getElementById('cloneStatus');
    const url = input.value.trim();
    if (!url) return;

    status.style.color = '#4a90e2';
    status.textContent = 'Cloning...';
    input.disabled = true;

    try {
        const res = await authFetch('/api/clone', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url })
        });
        const data = await res.json();
        if (data.success) {
            status.style.color = '#4caf50';
            status.textContent = 'Done';
            input.value = '';
            loadProjects();
        } else {
            status.style.color = '#ff6b6b';
            status.textContent = data.error;
        }
    } catch (e) {
        status.style.color = '#ff6b6b';
        status.textContent = e.message;
    }
    input.disabled = false;
    setTimeout(() => { status.textContent = ''; }, 5000);
}

// ---- 侧边栏 ----

function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebarOverlay');
    const isOpen = sidebar.classList.toggle('open');
    overlay.classList.toggle('active', isOpen);
    setTimeout(doFit, 300);
}

function closeSidebar() {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebarOverlay').classList.remove('active');
    setTimeout(doFit, 300);
}

// ---- 状态监控 ----

function formatUptime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
}

function toggleHealthPanel(e) {
    if (e) e.stopPropagation();
    document.getElementById('healthPanel').classList.toggle('open');
}

document.addEventListener('click', (e) => {
    const panel = document.getElementById('healthPanel');
    const bar = document.getElementById('statusBar');
    if (panel && !panel.contains(e.target) && !bar.contains(e.target)) {
        panel.classList.remove('open');
    }
});

async function refreshHealth() {
    try {
        const res = await authFetch('/api/health');
        const data = await res.json();
        const el1 = document.getElementById('statusSessions');
        const el2 = document.getElementById('statusMemory');
        if (el1) el1.textContent = `${data.sessions} sessions`;
        if (el2) el2.textContent = `${data.memory.rss}MB`;
        // 健康面板详情
        const u = document.getElementById('healthUptime');
        const s = document.getElementById('healthSessions');
        const c = document.getElementById('healthCpu');
        const r = document.getElementById('healthRss');
        const hp = document.getElementById('healthHeap');
        const dk = document.getElementById('healthDisk');
        if (u) u.textContent = formatUptime(data.uptime);
        if (s) s.textContent = data.sessions;
        if (c && data.cpu) c.textContent = `${data.cpu.load1m} (${data.cpu.cores} cores)`;
        if (r) r.textContent = `${data.memory.rss} MB`;
        if (hp) hp.textContent = `${data.memory.heap} MB`;
        if (dk && data.disk) dk.textContent = `${data.disk.used}/${data.disk.total} GB (${data.disk.percent})`;
    } catch {}
}

// ---- 初始化 ----

let appInitialized = false;

function initApp() {
    if (appInitialized) return;
    appInitialized = true;
    initTerminal();
    loadProjects();
    connectWebSocket();
    refreshHealth();
    setInterval(refreshHealth, 10000);
}

// 启动时检查认证状态
checkAuth();
