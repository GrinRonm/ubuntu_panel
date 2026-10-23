// ServerDeck Client-Side Engine v1.1.0 - High Performance
const app = {
  activeTab: 'dashboard',
  statsWs: null,
  termWs: null,
  term: null,
  fitAddon: null,
  
  // File Manager State
  currentFilePath: '/',
  currentEditingFile: null,
  fileItems: [],
  fileSortKey: 'name',
  fileSortAsc: true,
  fileFilter: '',
  
  // Services State
  allServices: [],
  serviceFilterType: 'all', // 'all', 'active', 'fav'
  serviceSearchQuery: '',
  favoriteServices: JSON.parse(localStorage.getItem('serverdeck_fav_services') || '["nginx.service", "beget-ddns.service", "docker.service", "ssh.service"]'),
  
  // Processes State
  procSortBy: 'cpu',
  
  // History Chart State
  historyRange: '1h',
  historyData: null,
  historyTimer: null,
  
  // Nginx State
  currentEditingNginx: null,
  
  // Logs State
  currentLogType: 'access',
  
  // User Management State
  currentEditingUser: null,

  // SSL State
  sslCerts: [],
  sslFilter: '',

  // Network & UFW State
  netOverview: null,
  netSubTab: 'ports',
  netPortsFilter: '',

  // SMART Disks State
  smartDisks: [],

  // Cron State
  cronUser: 'grinronn',
  cronJobs: [],
  cronSearchQuery: '',
  cronEditingId: null,
  
  // Initialize
  async init() {
    this.bindEvents();
    const authenticated = await this.checkAuth();
    if (authenticated) {
      this.showApp();
    } else {
      this.showLogin();
    }
  },

  // Auth checking
  async checkAuth() {
    try {
      const res = await fetch('/api/auth/me');
      if (res.ok) {
        const data = await res.json();
        document.getElementById('display-username').innerText = data.username;
        document.getElementById('user-avatar').innerText = data.username[0].toUpperCase();
        return true;
      }
      return false;
    } catch {
      return false;
    }
  },

  showLogin() {
    document.getElementById('login-screen').style.display = 'flex';
    document.getElementById('app').style.display = 'none';
  },

  showApp() {
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    this.switchTab('dashboard');
    this.connectStatsWs();
    this.fetchMetricsHistory();
    this.checkInitialSoftware();
  },

  // Bind UI Events
  bindEvents() {
    // Login form
    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const u = document.getElementById('login-username').value;
      const p = document.getElementById('login-password').value;
      const errEl = document.getElementById('login-error');
      errEl.style.display = 'none';
      
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: u, password: p })
        });
        const data = await res.json();
        if (res.ok && data.status) {
          this.showApp();
        } else {
          errEl.innerText = data.detail || 'Ошибка авторизации';
          errEl.style.display = 'block';
        }
      } catch (err) {
        errEl.innerText = 'Сервер недоступен: ' + err.message;
        errEl.style.display = 'block';
      }
    });

    // Logout
    document.getElementById('btn-logout').addEventListener('click', async () => {
      await fetch('/api/auth/logout', { method: 'POST' });
      if (this.statsWs) this.statsWs.close();
      if (this.termWs) this.termWs.close();
      if (this.historyTimer) clearInterval(this.historyTimer);
      this.showLogin();
    });

    // Navigation tabs
    document.querySelectorAll('.nav-item').forEach(item => {
      item.addEventListener('click', () => {
        const tab = item.getAttribute('data-tab');
        this.switchTab(tab);
      });
    });

    // Top action buttons
    document.getElementById('btn-quick-test-nginx').addEventListener('click', () => this.testNginx());
    document.getElementById('btn-quick-reload-nginx').addEventListener('click', () => this.reloadNginx());

    // New Site wizard
    document.getElementById('new-site-type').addEventListener('change', (e) => {
      const isProxy = e.target.value === 'proxy';
      document.getElementById('group-proxy-target').style.display = isProxy ? 'block' : 'none';
      document.getElementById('group-root-path').style.display = isProxy ? 'none' : 'block';
    });
    document.getElementById('btn-open-new-site-modal').addEventListener('click', () => this.openModal('modal-new-site'));
    document.getElementById('btn-submit-new-site').addEventListener('click', () => this.submitNewSite());
    document.getElementById('btn-save-nginx').addEventListener('click', () => this.saveNginxSite());

    // File manager actions & live search
    document.getElementById('btn-create-file').addEventListener('click', () => this.promptCreateItem(false));
    document.getElementById('btn-create-folder').addEventListener('click', () => this.promptCreateItem(true));
    document.getElementById('file-upload-input').addEventListener('change', (e) => this.handleFileUpload(e));
    document.getElementById('btn-save-file').addEventListener('click', () => this.saveFile());
    document.getElementById('file-search-input').addEventListener('input', (e) => {
      this.fileFilter = e.target.value.toLowerCase().trim();
      this.renderFiles();
    });

    // Services live search
    document.getElementById('service-search-input').addEventListener('input', (e) => {
      this.serviceSearchQuery = e.target.value.toLowerCase().trim();
      this.renderServices();
    });

    // Users actions
    document.getElementById('btn-open-new-user-modal').addEventListener('click', () => this.openModal('modal-new-user'));
    document.getElementById('btn-submit-new-user').addEventListener('click', () => this.submitNewUser());
    document.getElementById('btn-submit-change-pass').addEventListener('click', () => this.submitChangePassword());

    // SSL actions
    document.getElementById('ssl-search-input').addEventListener('input', (e) => {
      this.sslFilter = e.target.value.toLowerCase().trim();
      this.renderSslCerts();
    });
    document.getElementById('btn-renew-all-ssl').addEventListener('click', () => this.renewSsl());
    document.getElementById('btn-open-issue-ssl').addEventListener('click', () => this.openModal('modal-issue-ssl'));
    document.getElementById('btn-submit-issue-ssl').addEventListener('click', () => this.submitIssueSsl());

    // Network & UFW actions
    document.getElementById('btn-refresh-network').addEventListener('click', () => this.loadNetworkOverview());
    document.getElementById('btn-toggle-ufw').addEventListener('click', () => this.toggleUfw());
    document.getElementById('btn-open-add-ufw').addEventListener('click', () => this.openModal('modal-add-ufw'));
    document.getElementById('btn-submit-add-ufw').addEventListener('click', () => this.submitAddUfwRule());
    document.getElementById('ports-filter-input').addEventListener('input', (e) => {
      this.netPortsFilter = e.target.value.toLowerCase().trim();
      this.renderListeningPorts();
    });

    // SMART actions
    document.getElementById('btn-refresh-smart').addEventListener('click', () => this.loadSmartDisks());

    // Cron actions
    document.getElementById('cron-user-select').addEventListener('change', (e) => {
      this.cronUser = e.target.value;
      this.loadCronJobs();
    });
    document.getElementById('cron-search-input').addEventListener('input', (e) => {
      this.cronSearchQuery = e.target.value.toLowerCase().trim();
      this.renderCronJobs();
    });
    document.getElementById('btn-open-add-cron').addEventListener('click', () => {
      this.cronEditingId = null;
      document.getElementById('cron-expr-input').value = '*/5 * * * *';
      document.getElementById('cron-cmd-input').value = '';
      document.getElementById('cron-comment-input').value = '';
      document.getElementById('cron-preset-select').value = '*/5 * * * *';
      this.updateCronPreview();
      this.openModal('modal-edit-cron');
    });
    document.getElementById('btn-refresh-cron').addEventListener('click', () => this.loadCronJobs());
    document.getElementById('cron-preset-select').addEventListener('change', (e) => {
      if (e.target.value) {
        document.getElementById('cron-expr-input').value = e.target.value;
        this.updateCronPreview();
      }
    });
    document.getElementById('cron-expr-input').addEventListener('input', () => this.updateCronPreview());
    document.getElementById('btn-submit-cron').addEventListener('click', () => this.submitCronJob());

    // Logs actions
    document.getElementById('btn-refresh-logs').addEventListener('click', () => this.fetchLogs());
    document.getElementById('log-filter-input').addEventListener('input', () => this.fetchLogs());

    // Terminal reconnect
    document.getElementById('btn-reconnect-terminal').addEventListener('click', () => this.initTerminal());

    // Samba actions
    const btnNewSambaShare = document.getElementById('btn-open-new-samba-share');
    if (btnNewSambaShare) btnNewSambaShare.addEventListener('click', () => this.openSambaShareModal());
    const btnNewSambaUser = document.getElementById('btn-open-new-samba-user');
    if (btnNewSambaUser) btnNewSambaUser.addEventListener('click', () => this.openSambaUserModal());
    const btnSubmitSambaShare = document.getElementById('btn-submit-samba-share');
    if (btnSubmitSambaShare) btnSubmitSambaShare.addEventListener('click', () => this.submitSambaShare());
    const btnSubmitSambaUser = document.getElementById('btn-submit-samba-user');
    if (btnSubmitSambaUser) btnSubmitSambaUser.addEventListener('click', () => this.submitSambaUser());
    const btnRestartSamba = document.getElementById('btn-restart-samba');
    if (btnRestartSamba) btnRestartSamba.addEventListener('click', () => this.restartSamba());
    const btnTestparmSamba = document.getElementById('btn-testparm-samba');
    if (btnTestparmSamba) btnTestparmSamba.addEventListener('click', () => this.testparmSamba());
    const btnEditSambaConfig = document.getElementById('btn-edit-samba-config');
    if (btnEditSambaConfig) btnEditSambaConfig.addEventListener('click', () => this.openSambaConfigModal());
    const btnSaveSambaConfig = document.getElementById('btn-save-samba-config');
    if (btnSaveSambaConfig) btnSaveSambaConfig.addEventListener('click', () => this.saveSambaConfig());

    // FTP actions
    const btnNewFtpUser = document.getElementById('btn-open-new-ftp-user');
    if (btnNewFtpUser) btnNewFtpUser.addEventListener('click', () => this.openFtpUserModal());
    const btnSubmitFtpUser = document.getElementById('btn-submit-ftp-user');
    if (btnSubmitFtpUser) btnSubmitFtpUser.addEventListener('click', () => this.submitFtpUser());
    const btnRestartFtp = document.getElementById('btn-restart-ftp');
    if (btnRestartFtp) btnRestartFtp.addEventListener('click', () => this.restartFtp());
    const btnTestFtpConn = document.getElementById('btn-test-ftp-conn');
    if (btnTestFtpConn) btnTestFtpConn.addEventListener('click', () => this.runFtpTest());
    const btnRunFtpTest = document.getElementById('btn-run-ftp-test');
    if (btnRunFtpTest) btnRunFtpTest.addEventListener('click', () => this.runFtpTest());
    const btnEditFtpConfig = document.getElementById('btn-edit-ftp-config');
    if (btnEditFtpConfig) btnEditFtpConfig.addEventListener('click', () => this.openFtpConfigModal());
    const btnSaveFtpConfig = document.getElementById('btn-save-ftp-config');
    if (btnSaveFtpConfig) btnSaveFtpConfig.addEventListener('click', () => this.saveFtpConfig());
    const ftpSettingsForm = document.getElementById('ftp-settings-form');
    if (ftpSettingsForm) ftpSettingsForm.addEventListener('submit', (e) => { e.preventDefault(); this.submitFtpSettings(); });


    // Periodic history chart update (every 20s)
    this.historyTimer = setInterval(() => {
      if (this.activeTab === 'dashboard') {
        this.fetchMetricsHistory(false);
      }
    }, 20000);
  },

  // Switch Active Tab
  switchTab(tabName) {
    this.activeTab = tabName;
    document.querySelectorAll('.nav-item').forEach(el => {
      el.classList.toggle('active', el.getAttribute('data-tab') === tabName);
    });

    document.querySelectorAll('.tab-view').forEach(el => {
      el.style.display = 'none';
    });

    const activeView = document.getElementById(`view-${tabName}`);
    if (activeView) activeView.style.display = 'block';

    const titles = {
      dashboard: 'Дашборд сервера',
      nginx: 'Nginx Сайты & Прокси',
      ssl: 'SSL / Let\'s Encrypt сертификаты',
      network: 'Сеть & Фаервол UFW',
      smart: 'S.M.A.R.T. Здоровье дисков',
      cron: 'Планировщик задач (Cron)',
      samba: 'Сетевые папки Samba (SMB / CIFS)',
      ftp: 'FTP Сервер (vsftpd)',
      services: 'Службы & Docker',
      processes: 'Процессы (htop)',
      files: 'Файловый менеджер',
      users: 'Пользователи сервера',
      logs: 'Системные логи & Журнал',
      terminal: 'Интерактивная консоль'
    };
    document.getElementById('page-heading').innerText = titles[tabName] || tabName;

    // Trigger tab specific loads
    if (tabName === 'dashboard') this.fetchMetricsHistory();
    this.checkInitialSoftware();
    if (tabName === 'nginx') this.loadNginxSites();
    if (tabName === 'ssl') this.loadSslCerts();
    if (tabName === 'network') this.loadNetworkOverview();
    if (tabName === 'smart') this.loadSmartDisks();
    if (tabName === 'cron') this.loadCronJobs();
    if (tabName === 'samba') this.loadSambaOverview();
    if (tabName === 'ftp') this.loadFtpOverview();
    if (tabName === 'services') this.loadServices();
    if (tabName === 'processes') this.loadProcesses();
    if (tabName === 'files') this.loadFiles(this.currentFilePath);
    if (tabName === 'users') this.loadUsers();
    if (tabName === 'logs') this.fetchLogs();
    if (tabName === 'terminal') {
      setTimeout(() => {
        if (!this.term) this.initTerminal();
        if (this.fitAddon) this.fitAddon.fit();
      }, 50);
    }
  },

  // WebSocket for Live System Stats (Optimized DOM updates, zero lag)
  connectStatsWs() {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${window.location.host}/ws/system/stats`;
    this.statsWs = new WebSocket(wsUrl);

    this.statsWs.onmessage = (event) => {
      try {
        const stats = JSON.parse(event.data);
        this.renderStats(stats);
      } catch (err) {
        console.error('Stats parse error:', err);
      }
    };

    this.statsWs.onclose = () => {
      setTimeout(() => {
        if (document.getElementById('app').style.display !== 'none') {
          this.connectStatsWs();
        }
      }, 3000);
    };
  },

  renderStats(s) {
    // Only update text values and styles directly, avoiding layout thrashing
    document.getElementById('cpu-val').innerText = s.cpu.overall;
    document.getElementById('cpu-bar').style.width = `${Math.min(s.cpu.overall, 100)}%`;
    document.getElementById('cpu-cores-text').innerText = `Ядер: ${s.cpu.count}`;
    document.getElementById('load-avg-text').innerText = `Загрузка: ${s.load.join(', ')}`;

    document.getElementById('ram-val').innerText = s.memory.percent;
    document.getElementById('ram-bar').style.width = `${Math.min(s.memory.percent, 100)}%`;
    document.getElementById('ram-used-text').innerText = `${this.formatBytes(s.memory.used)} из ${this.formatBytes(s.memory.total)}`;
    document.getElementById('ram-free-text').innerText = `Свободно: ${this.formatBytes(s.memory.free)}`;

    const rootDisk = s.disks.find(d => d.mount === '/') || s.disks[0];
    if (rootDisk) {
      document.getElementById('disk-val').innerText = rootDisk.percent;
      document.getElementById('disk-bar').style.width = `${Math.min(rootDisk.percent, 100)}%`;
      document.getElementById('disk-used-text').innerText = `${this.formatBytes(rootDisk.used)} из ${this.formatBytes(rootDisk.total)}`;
      document.getElementById('disk-free-text').innerText = `Свободно: ${this.formatBytes(rootDisk.free)}`;
    }

    const rxKb = (s.network.rx_sec / 1024).toFixed(1);
    const txKb = (s.network.tx_sec / 1024).toFixed(1);
    const totalSpeed = (parseFloat(rxKb) + parseFloat(txKb)).toFixed(1);
    document.getElementById('net-speed-val').innerText = totalSpeed;
    document.getElementById('net-rx-text').innerText = `↓ ${rxKb} KB/s`;
    document.getElementById('net-tx-text').innerText = `↑ ${txKb} KB/s`;

    // Only render disks table if count changed or empty
    const diskTbody = document.getElementById('disks-table-body');
    if (diskTbody.children.length !== s.disks.length) {
      diskTbody.innerHTML = s.disks.map(d => `
        <tr>
          <td style="font-weight: 600; font-family: monospace;">${d.mount}</td>
          <td><span class="badge badge-ssl">${d.fstype}</span></td>
          <td>${this.formatBytes(d.used)} (${d.percent}%)</td>
          <td>${this.formatBytes(d.total)}</td>
          <td>
            <div class="progress-track" style="width: 100px; height: 6px;">
              <div class="progress-fill fill-disk" style="width: ${d.percent}%;"></div>
            </div>
          </td>
        </tr>
      `).join('');
    }

    document.getElementById('info-hostname').innerText = s.hostname;
    document.getElementById('info-kernel').innerText = s.kernel;
    document.getElementById('info-uptime').innerText = this.formatUptime(s.uptime);
    
    const begetBadge = document.getElementById('beget-badge');
    if (s.beget_ddns_active) {
      begetBadge.className = 'badge badge-active';
      begetBadge.innerHTML = '<span class="badge-dot"></span> Beget DDNS: активен';
    } else {
      begetBadge.className = 'badge badge-inactive';
      begetBadge.innerHTML = '<span class="badge-dot"></span> Beget DDNS: не активен';
    }
  },

  // --- Metrics History Chart Module ---
  setHistoryRange(range) {
    this.historyRange = range;
    document.querySelectorAll('.chart-tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-range') === range);
    });
    this.fetchMetricsHistory();
    this.checkInitialSoftware();
  },

  async fetchMetricsHistory(showToast = false) {
    try {
      const res = await fetch(`/api/system/history?range=${this.historyRange}`);
      if (res.ok) {
        const data = await res.json();
        this.historyData = data.points;
        this.renderHistoryChart();
      }
    } catch (err) {
      console.error('History fetch error:', err);
    }
  },

  renderHistoryChart() {
    const canvas = document.getElementById('metrics-canvas');
    if (!canvas || !this.historyData || this.historyData.length === 0) return;

    // HiDPI support
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;
    const padding = { top: 12, right: 16, bottom: 24, left: 36 };
    const chartW = w - padding.left - padding.right;
    const chartH = h - padding.top - padding.bottom;

    ctx.clearRect(0, 0, w, h);

    // Draw Gridlines (0%, 25%, 50%, 75%, 100%)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.fillStyle = 'rgba(148, 163, 184, 0.6)';
    ctx.font = '10px Inter, sans-serif';
    ctx.textAlign = 'right';

    [0, 25, 50, 75, 100].forEach(p => {
      const y = padding.top + chartH - (p / 100) * chartH;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(w - padding.right, y);
      ctx.stroke();
      ctx.fillText(`${p}%`, padding.left - 6, y + 3);
    });

    const pts = this.historyData;
    const n = pts.length;
    if (n < 2) return;

    // Helper to get coords
    const getX = (i) => padding.left + (i / (n - 1)) * chartW;
    const getY = (val) => padding.top + chartH - (Math.min(Math.max(val, 0), 100) / 100) * chartH;

    // 1. Draw RAM Area & Line
    ctx.beginPath();
    ctx.moveTo(getX(0), getY(pts[0].ram));
    for (let i = 1; i < n; i++) {
      ctx.lineTo(getX(i), getY(pts[i].ram));
    }
    ctx.strokeStyle = '#06b6d4';
    ctx.lineWidth = 2;
    ctx.stroke();

    // RAM Gradient Fill
    ctx.lineTo(getX(n - 1), padding.top + chartH);
    ctx.lineTo(getX(0), padding.top + chartH);
    ctx.closePath();
    const ramGrad = ctx.createLinearGradient(0, padding.top, 0, padding.top + chartH);
    ramGrad.addColorStop(0, 'rgba(6, 182, 212, 0.25)');
    ramGrad.addColorStop(1, 'rgba(6, 182, 212, 0.0)');
    ctx.fillStyle = ramGrad;
    ctx.fill();

    // 2. Draw CPU Line
    ctx.beginPath();
    ctx.moveTo(getX(0), getY(pts[0].cpu));
    for (let i = 1; i < n; i++) {
      ctx.lineTo(getX(i), getY(pts[i].cpu));
    }
    ctx.strokeStyle = '#6366f1';
    ctx.lineWidth = 2;
    ctx.stroke();

    // CPU Gradient Fill
    ctx.lineTo(getX(n - 1), padding.top + chartH);
    ctx.lineTo(getX(0), padding.top + chartH);
    ctx.closePath();
    const cpuGrad = ctx.createLinearGradient(0, padding.top, 0, padding.top + chartH);
    cpuGrad.addColorStop(0, 'rgba(99, 102, 241, 0.2)');
    cpuGrad.addColorStop(1, 'rgba(99, 102, 241, 0.0)');
    ctx.fillStyle = cpuGrad;
    ctx.fill();

    // 3. Draw Network Line (scaled to max 100 or peak)
    const maxNet = Math.max(...pts.map(p => p.rx_kb + p.tx_kb), 50);
    const getNetY = (kb) => padding.top + chartH - (Math.min(kb / maxNet, 1)) * chartH;

    ctx.beginPath();
    ctx.moveTo(getX(0), getNetY(pts[0].rx_kb + pts[0].tx_kb));
    for (let i = 1; i < n; i++) {
      ctx.lineTo(getX(i), getNetY(pts[i].rx_kb + pts[i].tx_kb));
    }
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Draw Time Labels (Start, Mid, End)
    ctx.fillStyle = 'rgba(148, 163, 184, 0.7)';
    ctx.textAlign = 'left';
    ctx.fillText(new Date(pts[0].t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), padding.left, h - 6);
    ctx.textAlign = 'center';
    ctx.fillText(new Date(pts[Math.floor(n / 2)].t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), padding.left + chartW / 2, h - 6);
    ctx.textAlign = 'right';
    ctx.fillText(new Date(pts[n - 1].t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), w - padding.right, h - 6);
  },

  // --- Top Processes Module ---
  setProcSort(by) {
    this.procSortBy = by;
    document.getElementById('btn-proc-sort-cpu').classList.toggle('active', by === 'cpu');
    document.getElementById('btn-proc-sort-ram').classList.toggle('active', by === 'ram');
    this.loadProcesses();
  },

  async loadProcesses() {
    const tbody = document.getElementById('processes-table-body');
    tbody.innerHTML = '<tr><td colspan="8">Загрузка процессов...</td></tr>';

    try {
      const res = await fetch(`/api/processes?sort_by=${this.procSortBy}&limit=35`);
      const procs = await res.json();
      tbody.innerHTML = procs.map(p => `
        <tr>
          <td><code>${p.pid}</code></td>
          <td style="font-weight: 600; font-family: monospace;">${p.name}</td>
          <td><span class="badge badge-ssl">${p.user}</span></td>
          <td style="font-weight: 700; color: ${p.cpu > 20 ? 'var(--accent-rose)' : 'var(--text-main)'};">${p.cpu}%</td>
          <td style="font-weight: 700; color: ${p.ram > 20 ? 'var(--accent-amber)' : 'var(--text-main)'};">${p.ram}%</td>
          <td style="color: var(--text-muted); font-size: 0.82rem;">${this.formatBytes(p.rss)}</td>
          <td><span style="font-size: 0.78rem; color: var(--text-dim);">${p.status}</span></td>
          <td style="text-align: right;">
            <button class="btn btn-danger btn-sm" onclick="app.killProcess(${p.pid}, '${p.name}')">Завершить</button>
          </td>
        </tr>
      `).join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="8" style="color: var(--accent-rose);">${err.message}</td></tr>`;
    }
  },

  async killProcess(pid, name) {
    if (!confirm(`Принудительно завершить процесс ${name} (PID ${pid})?`)) return;
    try {
      const res = await fetch(`/api/processes/${pid}/kill`, { method: 'POST' });
      const data = await res.json();
      if (data.status) {
        this.showToast(data.message, 'success');
        this.loadProcesses();
      } else {
        alert(data.detail || 'Ошибка');
      }
    } catch (err) {
      this.showToast(err.message, 'error');
    }
  },

  
  // ==========================================
  // --- Service Missing & Component Hub ---
  // ==========================================
  componentsStatus: null,

  async loadSoftwareStatus(force = false) {
    if (this.componentsStatus && !force) return this.componentsStatus;
    try {
      const res = await fetch('/api/components/status');
      if (res.ok) {
        this.componentsStatus = await res.json();
        return this.componentsStatus;
      }
    } catch (err) {
      console.error('Error fetching components status:', err);
    }
    return null;
  },

  renderMissingServiceCard(serviceKey, title, desc, icon) {
    return `
      <div class="service-missing-card">
        <div class="service-missing-icon-wrap">
          <div class="service-missing-icon">${icon}</div>
        </div>
        <h3 class="service-missing-title">${title}</h3>
        <p class="service-missing-desc">${desc}</p>
        <div class="service-missing-pills">
          <div class="service-feature-pill">⚡ Быстрая установка через официальный APT</div>
          <div class="service-feature-pill">🔒 Безопасная стандартная конфигурация</div>
          <div class="service-feature-pill">🚀 Автоматический запуск службы</div>
        </div>
        <button class="btn btn-primary btn-lg" onclick="app.installComponent('${serviceKey}', this)" style="padding: 12px 28px; font-size: 1rem; border-radius: var(--radius-sm);">
          <span>🚀 Установить ${serviceKey.toUpperCase()} в 1 клик</span>
        </button>
      </div>
    `;
  },

  showMissingService(tabKey, serviceKey, title, desc, icon) {
    const placeholder = document.getElementById(`${tabKey}-missing-placeholder`);
    const contentWrap = document.getElementById(`${tabKey}-content-wrap`);
    if (placeholder) {
      placeholder.innerHTML = this.renderMissingServiceCard(serviceKey, title, desc, icon);
      placeholder.style.display = 'block';
    }
    if (contentWrap) contentWrap.style.display = 'none';
  },

  hideMissingService(tabKey) {
    const placeholder = document.getElementById(`${tabKey}-missing-placeholder`);
    const contentWrap = document.getElementById(`${tabKey}-content-wrap`);
    if (placeholder) placeholder.style.display = 'none';
    if (contentWrap) contentWrap.style.display = 'block';
  },

  async checkInitialSoftware() {
    const status = await this.loadSoftwareStatus(true);
    if (!status) return;

    const missing = Object.values(status).filter(c => !c.installed);
    const dismissed = localStorage.getItem('serverdeck_software_banner_dismissed') === '1';

    if (missing.length > 0 && !dismissed) {
      this.renderDashboardSoftwareBanner(status);
    }

    // On initial run, show modal if core services missing
    if (!localStorage.getItem('serverdeck_first_run_seen')) {
      localStorage.setItem('serverdeck_first_run_seen', '1');
      if (missing.length > 0) {
        setTimeout(() => this.openSoftwareHub(), 600);
      }
    }
  },

  renderDashboardSoftwareBanner(status) {
    const banner = document.getElementById('dashboard-software-banner');
    const grid = document.getElementById('dashboard-software-grid');
    if (!banner || !grid) return;

    const comps = status || this.componentsStatus;
    if (!comps) return;

    const list = Object.values(comps);
    list.sort((a, b) => {
      if (a.installed === b.installed) return 0;
      return a.installed ? 1 : -1;
    });

    const displayList = list.slice(0, 4);
    grid.innerHTML = displayList.map(c => `
      <div class="software-card" style="padding: 14px 16px;">
        <div class="software-card-top">
          <div class="software-card-icon">${c.icon}</div>
          <div class="software-card-info">
            <div class="software-card-name">
              ${c.name}
              ${c.installed 
                ? (c.active ? '<span class="badge badge-emerald" style="font-size: 0.65rem;">Активен</span>' : '<span class="badge badge-amber" style="font-size: 0.65rem;">Остановлен</span>')
                : '<span class="badge badge-inactive" style="font-size: 0.65rem;">Не установлен</span>'}
            </div>
            <div class="software-card-desc">${c.desc}</div>
          </div>
        </div>
        <div class="software-card-bottom">
          <span style="font-size: 0.75rem; color: var(--text-dim);">${c.version || c.category}</span>
          ${c.installed 
            ? `<button class="btn btn-secondary btn-sm" onclick="app.switchTab('${c.tab}')">Открыть ➔</button>`
            : `<button class="btn btn-primary btn-sm" onclick="app.installComponent('${c.key}', this)">Установить в 1 клик</button>`}
        </div>
      </div>
    `).join('');

    banner.style.display = 'block';
  },

  dismissSoftwareBanner() {
    const banner = document.getElementById('dashboard-software-banner');
    if (banner) banner.style.display = 'none';
    localStorage.setItem('serverdeck_software_banner_dismissed', '1');
  },

  async openSoftwareHub() {
    this.openModal('modal-software-hub');
    const grid = document.getElementById('software-hub-cards-grid');
    if (!grid) return;
    grid.innerHTML = '<div style="grid-column: 1 / -1; text-align: center; color: var(--text-muted); padding: 40px;">Загрузка списка компонентов сервера...</div>';

    const status = await this.loadSoftwareStatus(true);
    if (!status) {
      grid.innerHTML = '<div style="grid-column: 1 / -1; color: var(--accent-rose); padding: 20px;">Ошибка проверки компонентов</div>';
      return;
    }

    grid.innerHTML = Object.values(status).map(c => `
      <div class="software-card">
        <div class="software-card-top">
          <div class="software-card-icon">${c.icon}</div>
          <div class="software-card-info">
            <div class="software-card-name">
              <span>${c.name}</span>
              ${c.installed 
                ? (c.active ? '<span class="badge badge-emerald">Активен</span>' : '<span class="badge badge-amber">Остановлен</span>')
                : '<span class="badge badge-inactive">Не установлен</span>'}
            </div>
            <div class="software-card-desc">${c.desc}</div>
          </div>
        </div>
        <div class="software-card-bottom">
          <span style="font-size: 0.78rem; color: var(--text-dim);">${c.version || c.category}</span>
          ${c.installed 
            ? `<button class="btn btn-secondary btn-sm" onclick="app.closeModal('modal-software-hub'); app.switchTab('${c.tab}');">Перейти во вкладку ➔</button>`
            : `<button class="btn btn-primary btn-sm" onclick="app.installComponent('${c.key}', this)">🚀 Установить в 1 клик</button>`}
        </div>
      </div>
    `).join('');
  },

  async installComponent(key, btn) {
    if (btn) {
      btn.classList.add('btn-install-loading');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Установка (10-30 сек)...';
    }
    this.showToast(`Запущена установка ${key.toUpperCase()}... Пожалуйста, подождите.`, 'info');

    try {
      const res = await fetch('/api/components/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ component: key })
      });
      const data = await res.json();
      if (data.status) {
        this.showToast(data.message, 'success');
        // Reload software cache
        await this.loadSoftwareStatus(true);

        // If modal open, refresh it
        const hubModal = document.getElementById('modal-software-hub');
        if (hubModal && hubModal.style.display !== 'none') {
          this.openSoftwareHub();
        }

        // Re-render dashboard banner if present
        this.renderDashboardSoftwareBanner();

        // Reload current tab
        if (this.activeTab === 'nginx') this.loadNginxSites();
        else if (this.activeTab === 'samba') this.loadSambaOverview();
        else if (this.activeTab === 'ftp') this.loadFtpOverview();
        else if (this.activeTab === 'ssl') this.loadSslCerts();
        else if (this.activeTab === 'smart') this.loadSmartDisks();
        else if (this.activeTab === 'network') this.loadNetworkOverview();
      } else {
        this.showToast(data.detail || 'Ошибка установки', 'error');
        if (btn) {
          btn.classList.remove('btn-install-loading');
          btn.disabled = false;
          btn.innerHTML = 'Повторить установку';
        }
      }
    } catch (err) {
      this.showToast(err.message, 'error');
      if (btn) {
        btn.classList.remove('btn-install-loading');
        btn.disabled = false;
        btn.innerHTML = 'Повторить установку';
      }
    }
  },

  // --- Nginx Sites Module ---
  async loadNginxSites() {
    const tbody = document.getElementById('nginx-sites-table-body');
    if (tbody) tbody.innerHTML = '<tr><td colspan="7">Загрузка сайтов...</td></tr>';

    try {
      const res = await fetch('/api/nginx/sites');
      const data = await res.json();

      if (data && data.installed === false) {
        this.showMissingService('nginx', 'nginx', 'Веб-сервер Nginx не установлен на сервере', 'Установите Nginx для создания сайтов, настройки обратного прокси (Reverse Proxy), привязки доменов и SSL.', '🌐');
        return;
      }
      this.hideMissingService('nginx');

      const sites = Array.isArray(data) ? data : (data.sites || []);
      if (!sites || sites.length === 0) {
        if (tbody) tbody.innerHTML = '<tr><td colspan="7">Нет сайтов в /etc/nginx/sites-available</td></tr>';
        return;
      }

      tbody.innerHTML = sites.map(s => {
        const domains = (s.domains && s.domains.length) ? s.domains.map(d => `<a href="https://${d}" target="_blank" style="color: var(--accent-cyan); text-decoration: none; font-weight: 500;">${d}</a>`).join(', ') : '—';
        const ports = (s.ports && s.ports.length) ? s.ports.join(', ') : '80';
        const target = (s.proxy_targets && s.proxy_targets.length) ? s.proxy_targets[0] : (s.roots && s.roots.length ? `root: ${s.roots[0]}` : '—');
        const sslBadge = s.has_ssl ? '<span class="badge badge-ssl">SSL (443)</span>' : '<span style="color: var(--text-dim); font-size: 0.78rem;">Нет</span>';
        const statusBadge = s.enabled ? 
          '<span class="badge badge-active"><span class="badge-dot"></span> Включен</span>' : 
          '<span class="badge badge-inactive"><span class="badge-dot"></span> Выключен</span>';
        const toggleBtnText = s.enabled ? 'Отключить' : 'Включить';
        const toggleBtnClass = s.enabled ? 'btn-danger' : 'btn-success';

        return `
          <tr>
            <td style="font-family: monospace; font-weight: 600;">${s.filename}</td>
            <td>${domains}</td>
            <td><code>${ports}</code></td>
            <td style="font-family: monospace; font-size: 0.82rem; color: #cbd5e1;">${target}</td>
            <td>${sslBadge}</td>
            <td>${statusBadge}</td>
            <td style="text-align: right; white-space: nowrap;">
              <button class="btn btn-secondary btn-sm" onclick="app.editNginxSite('${s.filename}')">Изменить</button>
              <button class="btn ${toggleBtnClass} btn-sm" onclick="app.toggleNginxSite('${s.filename}')">${toggleBtnText}</button>
              <button class="btn btn-danger btn-sm" onclick="app.deleteNginxSite('${s.filename}')" title="Удалить">✕</button>
            </td>
          </tr>
        `;
      }).join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="7" style="color: var(--accent-rose);">${err.message}</td></tr>`;
    }
  },

  async toggleNginxSite(filename) {
    try {
      const res = await fetch(`/api/nginx/sites/${filename}/toggle`, { method: 'POST' });
      const data = await res.json();
      if (data.status) {
        this.showToast(data.message, 'success');
        this.loadNginxSites();
      } else {
        this.showToast(data.detail || 'Ошибка', 'error');
      }
    } catch (err) {
      this.showToast(err.message, 'error');
    }
  },

  async editNginxSite(filename) {
    this.currentEditingNginx = filename;
    document.getElementById('edit-nginx-title').innerText = `Конфиг: ${filename}`;
    try {
      const res = await fetch(`/api/nginx/sites/${filename}`);
      const data = await res.json();
      document.getElementById('nginx-editor-area').value = data.content;
      this.openModal('modal-edit-nginx');
    } catch (err) {
      this.showToast(err.message, 'error');
    }
  },

  async saveNginxSite() {
    if (!this.currentEditingNginx) return;
    const content = document.getElementById('nginx-editor-area').value;
    try {
      const res = await fetch(`/api/nginx/sites/${this.currentEditingNginx}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content })
      });
      const data = await res.json();
      if (data.status) {
        this.showToast('Файл сохранен! Проверяем конфигурацию...', 'info');
        this.closeModal('modal-edit-nginx');
        this.reloadNginx();
        this.loadNginxSites();
      }
    } catch (err) {
      this.showToast(err.message, 'error');
    }
  },

  async deleteNginxSite(filename) {
    if (!confirm(`Удалить конфигурацию ${filename}?`)) return;
    try {
      const res = await fetch(`/api/nginx/sites/${filename}`, { method: 'DELETE' });
      const data = await res.json();
      this.showToast(data.message, 'info');
      this.loadNginxSites();
    } catch (err) {
      this.showToast(err.message, 'error');
    }
  },

  async testNginx() {
    this.showToast('Тестирование nginx -t ...', 'info');
    try {
      const res = await fetch('/api/nginx/test', { method: 'POST' });
      const data = await res.json();
      if (data.status) {
        this.showToast('✓ Синтаксис Nginx корректен!', 'success');
      } else {
        alert("Ошибка в конфигурации Nginx:\n\n" + data.output);
        this.showToast('Ошибка синтаксиса Nginx', 'error');
      }
    } catch (err) {
      this.showToast(err.message, 'error');
    }
  },

  async reloadNginx() {
    this.showToast('Перезагрузка Nginx...', 'info');
    try {
      const res = await fetch('/api/nginx/reload', { method: 'POST' });
      const data = await res.json();
      if (data.status) {
        this.showToast('✓ ' + data.output, 'success');
      } else {
        alert("Не удалось перезагрузить Nginx:\n\n" + data.output);
        this.showToast('Ошибка перезагрузки Nginx', 'error');
      }
    } catch (err) {
      this.showToast(err.message, 'error');
    }
  },

  async submitNewSite() {
    const domain = document.getElementById('new-site-domain').value.trim();
    const type = document.getElementById('new-site-type').value;
    const proxy_target = document.getElementById('new-site-target').value.trim();
    const root_path = document.getElementById('new-site-root').value.trim();
    const enable_ssl = document.getElementById('new-site-ssl').checked;

    if (!domain) {
      alert('Укажите домен сайта!');
      return;
    }

    try {
      const res = await fetch('/api/nginx/sites/new', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain, type, proxy_target, root_path, enable_ssl })
      });
      const data = await res.json();
      if (data.status) {
        this.showToast(data.message, 'success');
        this.closeModal('modal-new-site');
        document.getElementById('new-site-domain').value = '';
        this.loadNginxSites();
      } else {
        alert(data.message + "\n\n" + (data.error || ''));
      }
    } catch (err) {
      this.showToast(err.message, 'error');
    }
  },

  // --- Services & Docker Module with Favorites & Search ---
  setServiceFilter(type) {
    this.serviceFilterType = type;
    document.querySelectorAll('#view-services .chart-tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.id === `svc-filter-${type}`);
    });
    this.renderServices();
  },

  toggleFavoriteService(name) {
    const idx = this.favoriteServices.indexOf(name);
    if (idx >= 0) {
      this.favoriteServices.splice(idx, 1);
    } else {
      this.favoriteServices.push(name);
    }
    localStorage.setItem('serverdeck_fav_services', JSON.stringify(this.favoriteServices));
    this.renderServices();
  },

  async loadServices() {
    const sysTbody = document.getElementById('systemd-table-body');
    sysTbody.innerHTML = '<tr><td colspan="6">Загрузка служб...</td></tr>';
    try {
      const res = await fetch('/api/services/systemd');
      this.allServices = await res.json();
      this.renderServices();
    } catch (err) {
      sysTbody.innerHTML = `<tr><td colspan="6" style="color: var(--accent-rose);">${err.message}</td></tr>`;
    }

    // Docker
    const dockTbody = document.getElementById('docker-table-body');
    dockTbody.innerHTML = '<tr><td colspan="5">Загрузка контейнеров...</td></tr>';
    try {
      const res = await fetch('/api/services/docker');
      const containers = await res.json();
      if (!containers || containers.length === 0) {
        dockTbody.innerHTML = '<tr><td colspan="5">Нет запущенных контейнеров Docker</td></tr>';
        return;
      }
      dockTbody.innerHTML = containers.map(c => {
        const isRunning = c.status.toLowerCase().includes('up');
        const badge = isRunning ? 
          '<span class="badge badge-active"><span class="badge-dot"></span> ' + c.status + '</span>' : 
          '<span class="badge badge-inactive"><span class="badge-dot"></span> ' + c.status + '</span>';
        const toggleBtn = isRunning ? 
          `<button class="btn btn-danger btn-sm" onclick="app.dockerAction('${c.name}', 'stop')">Остановить</button>` :
          `<button class="btn btn-success btn-sm" onclick="app.dockerAction('${c.name}', 'start')">Запустить</button>`;
        return `
          <tr>
            <td style="font-weight: 600;">${c.name}</td>
            <td style="font-size: 0.8rem; color: var(--text-muted); font-family: monospace;">${c.image}</td>
            <td style="font-size: 0.78rem;">${c.ports || '—'}</td>
            <td>${badge}</td>
            <td style="text-align: right;">
              ${toggleBtn}
              <button class="btn btn-secondary btn-sm" onclick="app.dockerAction('${c.name}', 'restart')">⟳ Рестарт</button>
            </td>
          </tr>
        `;
      }).join('');
    } catch (err) {
      dockTbody.innerHTML = `<tr><td colspan="5" style="color: var(--accent-rose);">${err.message}</td></tr>`;
    }
  },

  renderServices() {
    const sysTbody = document.getElementById('systemd-table-body');
    let list = this.allServices || [];

    // Filter by type
    if (this.serviceFilterType === 'active') {
      list = list.filter(s => s.active);
    } else if (this.serviceFilterType === 'enabled') {
      list = list.filter(s => s.enabled || s.unit_file_state === 'enabled');
    } else if (this.serviceFilterType === 'fav') {
      list = list.filter(s => this.favoriteServices.includes(s.name));
    }

    // Filter by query
    if (this.serviceSearchQuery) {
      list = list.filter(s => s.name.toLowerCase().includes(this.serviceSearchQuery) || (s.description && s.description.toLowerCase().includes(this.serviceSearchQuery)));
    }

    // Sort: Favorites first, then active, then alphabetical
    list.sort((a, b) => {
      const aFav = this.favoriteServices.includes(a.name);
      const bFav = this.favoriteServices.includes(b.name);
      if (aFav && !bFav) return -1;
      if (!aFav && bFav) return 1;
      if (a.active && !b.active) return -1;
      if (!a.active && b.active) return 1;
      return a.name.localeCompare(b.name);
    });

    if (list.length === 0) {
      sysTbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">Службы не найдены</td></tr>';
      return;
    }

    sysTbody.innerHTML = list.map(s => {
      const isFav = this.favoriteServices.includes(s.name);
      const starClass = isFav ? 'star-btn active' : 'star-btn';
      const badge = s.active ? 
        '<span class="badge badge-active"><span class="badge-dot"></span> Active</span>' : 
        '<span class="badge badge-inactive"><span class="badge-dot"></span> Inactive</span>';
      const startStopBtn = s.active ?
        `<button class="btn btn-danger btn-sm" onclick="app.systemdAction('${s.name}', 'stop')">Остановить</button>` :
        `<button class="btn btn-success btn-sm" onclick="app.systemdAction('${s.name}', 'start')">Запустить</button>`;
      return `
        <tr>
          <td>
            <button class="${starClass}" onclick="app.toggleFavoriteService('${s.name}')" title="${isFav ? 'В избранном' : 'Добавить в избранное'}">★</button>
          </td>
          <td style="font-weight: 600; font-family: monospace;">${s.name}</td>
          <td>
            ${s.enabled ? 
              `<button class="badge badge-emerald" style="cursor: pointer; border: none; padding: 4px 8px; font-weight: 600;" onclick="app.toggleServiceAutostart('${s.name}', false)" title="Автозапуск включен. Нажмите, чтобы отключить при загрузке системы">✓ Включен</button>` :
              (s.unit_file_state === 'disabled' ? 
                `<button class="badge badge-inactive" style="cursor: pointer; border: none; padding: 4px 8px;" onclick="app.toggleServiceAutostart('${s.name}', true)" title="Автозапуск отключен. Нажмите, чтобы включить при загрузке системы">○ Отключен</button>` :
                `<span class="badge badge-purple" title="Состояние unit файла: ${s.unit_file_state}">${s.unit_file_state || 'static'}</span>`
              )
            }
          </td>
          <td>${badge}</td>
          <td style="font-size: 0.8rem; color: var(--text-dim); max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${s.description || '—'}</td>
          <td style="text-align: right; white-space: nowrap;">
            ${startStopBtn}
            <button class="btn btn-secondary btn-sm" onclick="app.systemdAction('${s.name}', 'restart')">Перезапустить</button>
            <button class="btn btn-secondary btn-sm" onclick="app.viewServiceLogs('${s.name}')">Логи</button>
          </td>
        </tr>
      `;
    }).join('');
  },

  async systemdAction(name, action) {
    this.showToast(`${action} ${name}...`, 'info');
    try {
      const res = await fetch(`/api/services/systemd/${name}/${action}`, { method: 'POST' });
      const data = await res.json();
      if (data.status) {
        this.showToast(`Служба ${name}: успешно выполнено ${action}`, 'success');
        this.loadServices();
      } else {
        alert(data.output || 'Ошибка выполнения действия');
      }
    } catch (err) {
      this.showToast(err.message, 'error');
    }
  },

  async viewServiceLogs(name) {
    document.getElementById('service-log-title').innerText = `Журнал службы: ${name}`;
    const pre = document.getElementById('service-log-content');
    pre.innerText = 'Загрузка логов...';
    this.openModal('modal-service-log');
    try {
      const res = await fetch(`/api/services/systemd/${name}/logs?lines=120`);
      const data = await res.json();
      pre.innerText = (data.lines && data.lines.length) ? data.lines.join('\n') : 'Логов нет';
      pre.scrollTop = pre.scrollHeight;
    } catch (err) {
      pre.innerText = 'Ошибка получения логов: ' + err.message;
    }
  },

  async dockerAction(name, action) {
    this.showToast(`${action} контейнер ${name}...`, 'info');
    try {
      const res = await fetch(`/api/services/docker/${name}/${action}`, { method: 'POST' });
      const data = await res.json();
      if (data.status) {
        this.showToast(`Контейнер ${name}: ${action}ed`, 'success');
        this.loadServices();
      }
    } catch (err) {
      this.showToast(err.message, 'error');
    }
  },

  // --- Users Management Module ---
  async loadUsers() {
    const tbody = document.getElementById('users-table-body');
    tbody.innerHTML = '<tr><td colspan="7">Загрузка пользователей...</td></tr>';
    try {
      const res = await fetch('/api/users');
      const users = await res.json();
      tbody.innerHTML = users.map(u => {
        const sudoBadge = u.is_sudo ? '<span class="badge badge-sudo">Sudo (Root)</span>' : '<span style="color: var(--text-dim); font-size: 0.8rem;">Нет</span>';
        const typeBadge = u.is_system ? '<span style="color: var(--text-dim); font-size: 0.78rem;">Системный</span>' : '<span class="badge badge-active">Пользователь</span>';
        const canDelete = !['root', 'grinronn'].includes(u.username);
        return `
          <tr>
            <td style="font-weight: 700; font-family: monospace;">${u.username}</td>
            <td><code>${u.uid}</code></td>
            <td style="font-family: monospace; font-size: 0.82rem; color: #cbd5e1;">${u.home}</td>
            <td style="font-family: monospace; font-size: 0.82rem; color: var(--text-muted);">${u.shell}</td>
            <td>${sudoBadge}</td>
            <td>${typeBadge}</td>
            <td style="text-align: right; white-space: nowrap;">
              <button class="btn btn-secondary btn-sm" onclick="app.openChangePasswordModal('${u.username}')">Пароль</button>
              <button class="btn btn-secondary btn-sm" onclick="app.toggleUserSudo('${u.username}')">${u.is_sudo ? 'Забрать sudo' : 'Дать sudo'}</button>
              ${canDelete ? `<button class="btn btn-danger btn-sm" onclick="app.deleteUser('${u.username}')">✕</button>` : ''}
            </td>
          </tr>
        `;
      }).join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="7" style="color: var(--accent-rose);">${err.message}</td></tr>`;
    }
  },

  async submitNewUser() {
    const username = document.getElementById('new-user-name').value.trim();
    const password = document.getElementById('new-user-pass').value.trim();
    const shell = document.getElementById('new-user-shell').value;
    const is_sudo = document.getElementById('new-user-sudo').checked;

    if (!username || !password) {
      alert('Заполните имя пользователя и пароль!');
      return;
    }

    try {
      const res = await fetch('/api/users/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, shell, is_sudo })
      });
      const data = await res.json();
      if (data.status) {
        this.showToast(data.message, 'success');
        this.closeModal('modal-new-user');
        document.getElementById('new-user-name').value = '';
        document.getElementById('new-user-pass').value = '';
        this.loadUsers();
      } else {
        alert(data.detail || 'Ошибка создания пользователя');
      }
    } catch (err) {
      this.showToast(err.message, 'error');
    }
  },

  openChangePasswordModal(username) {
    this.currentEditingUser = username;
    document.getElementById('change-pass-title').innerText = `Смена пароля: ${username}`;
    document.getElementById('change-pass-input').value = '';
    this.openModal('modal-change-pass');
  },

  async submitChangePassword() {
    if (!this.currentEditingUser) return;
    const password = document.getElementById('change-pass-input').value.trim();
    if (!password) {
      alert('Введите новый пароль!');
      return;
    }
    try {
      const res = await fetch(`/api/users/${this.currentEditingUser}/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });
      const data = await res.json();
      if (data.status) {
        this.showToast(data.message, 'success');
        this.closeModal('modal-change-pass');
      } else {
        alert(data.detail || 'Ошибка смены пароля');
      }
    } catch (err) {
      this.showToast(err.message, 'error');
    }
  },

  async toggleUserSudo(username) {
    try {
      const res = await fetch(`/api/users/${username}/toggle-sudo`, { method: 'POST' });
      const data = await res.json();
      if (data.status) {
        this.showToast(data.message, 'info');
        this.loadUsers();
      }
    } catch (err) {
      this.showToast(err.message, 'error');
    }
  },

  async deleteUser(username) {
    if (!confirm(`Вы действительно хотите удалить пользователя ${username} и его файлы?`)) return;
    try {
      const res = await fetch(`/api/users/${username}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.status) {
        this.showToast(data.message, 'info');
        this.loadUsers();
      } else {
        alert(data.detail || 'Ошибка');
      }
    } catch (err) {
      this.showToast(err.message, 'error');
    }
  },

  // --- File Manager Module with Sorting & Filtering ---
  toggleFileSort(key) {
    if (this.fileSortKey === key) {
      this.fileSortAsc = !this.fileSortAsc;
    } else {
      this.fileSortKey = key;
      this.fileSortAsc = true;
    }
    ['name', 'size', 'mtime'].forEach(k => {
      const el = document.getElementById(`th-file-${k}`);
      if (el) {
        el.className = 'sortable';
        if (k === this.fileSortKey) {
          el.className = `sortable ${this.fileSortAsc ? 'sorted-asc' : 'sorted-desc'}`;
        }
      }
    });
    this.renderFiles();
  },

  async loadFiles(dirPath) {
    this.currentFilePath = dirPath;
    document.getElementById('current-file-path').innerText = dirPath;
    const tbody = document.getElementById('files-table-body');
    tbody.innerHTML = '<tr><td colspan="5">Загрузка каталога...</td></tr>';

    try {
      const res = await fetch(`/api/files/list?path=${encodeURIComponent(dirPath)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail);

      this.fileParentPath = data.parent_path;
      this.fileItems = data.items || [];
      this.renderFiles();
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="5" style="color: var(--accent-rose);">${err.message}</td></tr>`;
    }
  },

  renderFiles() {
    const tbody = document.getElementById('files-table-body');
    let items = [...(this.fileItems || [])];

    // Filter
    if (this.fileFilter) {
      items = items.filter(it => it.name.toLowerCase().includes(this.fileFilter));
    }

    // Sort: folders always first, then by selected key
    items.sort((a, b) => {
      if (a.is_dir && !b.is_dir) return -1;
      if (!a.is_dir && b.is_dir) return 1;

      let cmp = 0;
      if (this.fileSortKey === 'size') {
        cmp = a.size - b.size;
      } else if (this.fileSortKey === 'mtime') {
        cmp = a.mtime - b.mtime;
      } else {
        cmp = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      }
      return this.fileSortAsc ? cmp : -cmp;
    });

    let rows = '';
    if (this.currentFilePath !== '/') {
      rows += `
        <tr style="cursor: pointer;" onclick="app.loadFiles('${this.fileParentPath || '/'}')">
          <td colspan="5" style="color: var(--accent-cyan); font-weight: 600;">📁 .. (Наверх)</td>
        </tr>
      `;
    }

    rows += items.map(item => {
      const icon = item.is_dir ? '📁' : '📄';
      const nameAction = item.is_dir ? 
        `onclick="app.loadFiles('${item.path}')"` : 
        `onclick="app.openFile('${item.path}')"`;
      const sizeText = item.is_dir ? '—' : this.formatBytes(item.size);
      const dateText = new Date(item.mtime * 1000).toLocaleString();

      return `
        <tr>
          <td style="cursor: pointer; font-weight: 500;" ${nameAction}>
            ${icon} ${item.name}
          </td>
          <td>${sizeText}</td>
          <td><code>${item.mode}</code></td>
          <td style="font-size: 0.8rem; color: var(--text-dim);">${dateText}</td>
          <td style="text-align: right;">
            ${!item.is_dir ? `<button class="btn btn-secondary btn-sm" onclick="app.openFile('${item.path}')">Редактировать</button>` : ''}
            <button class="btn btn-danger btn-sm" onclick="app.deleteFile('${item.path}')">✕</button>
          </td>
        </tr>
      `;
    }).join('');

    tbody.innerHTML = rows || '<tr><td colspan="5" style="text-align: center; color: var(--text-dim);">Папка пуста</td></tr>';
  },

  async openFile(path) {
    this.currentEditingFile = path;
    document.getElementById('edit-file-title').innerText = `Файл: ${path}`;
    try {
      const res = await fetch(`/api/files/read?path=${encodeURIComponent(path)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail);
      document.getElementById('file-editor-area').value = data.content;
      this.openModal('modal-edit-file');
    } catch (err) {
      this.showToast(err.message, 'error');
    }
  },

  async saveFile() {
    if (!this.currentEditingFile) return;
    const content = document.getElementById('file-editor-area').value;
    try {
      const res = await fetch('/api/files/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: this.currentEditingFile, content })
      });
      const data = await res.json();
      if (data.status) {
        this.showToast('Файл успешно сохранён!', 'success');
        this.closeModal('modal-edit-file');
      }
    } catch (err) {
      this.showToast(err.message, 'error');
    }
  },

  async deleteFile(path) {
    if (!confirm(`Удалить ${path}?`)) return;
    try {
      const res = await fetch(`/api/files/delete?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
      const data = await res.json();
      this.showToast(data.message, 'info');
      this.loadFiles(this.currentFilePath);
    } catch (err) {
      this.showToast(err.message, 'error');
    }
  },

  async promptCreateItem(isDir) {
    const name = prompt(isDir ? "Имя новой папки:" : "Имя нового файла:");
    if (!name) return;
    const fullPath = (this.currentFilePath === '/' ? '/' : this.currentFilePath + '/') + name.trim();
    try {
      const res = await fetch('/api/files/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: fullPath, is_dir: isDir })
      });
      const data = await res.json();
      this.showToast(data.message, 'success');
      this.loadFiles(this.currentFilePath);
    } catch (err) {
      this.showToast(err.message, 'error');
    }
  },

  async handleFileUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('path', this.currentFilePath);
    formData.append('file', file);

    this.showToast(`Загрузка ${file.name}...`, 'info');
    try {
      const res = await fetch('/api/files/upload', {
        method: 'POST',
        body: formData
      });
      const data = await res.json();
      this.showToast(data.message, 'success');
      this.loadFiles(this.currentFilePath);
    } catch (err) {
      this.showToast(err.message, 'error');
    }
  },

  // --- Logs Module ---
  switchLogType(type) {
    this.currentLogType = type;
    document.querySelectorAll('#view-logs button.btn-secondary').forEach(b => b.classList.remove('active'));
    const btn = document.getElementById(`btn-log-${type}`);
    if (btn) btn.classList.add('active');
    this.fetchLogs();
  },

  async fetchLogs() {
    const viewer = document.getElementById('log-viewer');
    const filter = document.getElementById('log-filter-input').value;
    viewer.innerText = 'Загрузка логов...';

    try {
      let url = '';
      if (this.currentLogType === 'access' || this.currentLogType === 'error') {
        url = `/api/logs/nginx?log_type=${this.currentLogType}&lines=150&filter_term=${encodeURIComponent(filter)}`;
      } else if (this.currentLogType === 'journal') {
        url = `/api/logs/journal?lines=150`;
      } else if (this.currentLogType === 'beget') {
        url = `/api/logs/journal?unit=beget-ddns&lines=100`;
      }

      const res = await fetch(url);
      const data = await res.json();
      viewer.innerText = (data.lines && data.lines.length) ? data.lines.join('\n') : 'Логи пусты';
      viewer.scrollTop = viewer.scrollHeight;
    } catch (err) {
      viewer.innerText = 'Ошибка получения логов: ' + err.message;
    }
  },

  // --- Web Terminal Module ---
  initTerminal() {
    const container = document.getElementById('terminal-container');
    container.innerHTML = '';

    this.term = new Terminal({
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", monospace',
      fontSize: 14,
      theme: {
        background: '#070a10',
        foreground: '#e2e8f0',
        cursor: '#06b6d4',
        selectionBackground: 'rgba(6, 182, 212, 0.3)',
        black: '#0f172a',
        red: '#f43f5e',
        green: '#10b981',
        yellow: '#f59e0b',
        blue: '#3b82f6',
        magenta: '#8b5cf6',
        cyan: '#06b6d4',
        white: '#f8fafc'
      }
    });

    this.fitAddon = new FitAddon.FitAddon();
    this.term.loadAddon(this.fitAddon);
    this.term.open(container);
    this.fitAddon.fit();

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${window.location.host}/ws/terminal`;
    this.termWs = new WebSocket(wsUrl);

    this.termWs.onopen = () => {
      this.term.write('\r\n\x1b[32mПодключение к хост-терминалу установлено!\x1b[0m\r\n\r\n');
      this.sendTermResize();
    };

    this.termWs.onmessage = (e) => {
      this.term.write(e.data);
    };

    this.termWs.onclose = () => {
      this.term.write('\r\n\x1b[31mСессия терминала закрыта.\x1b[0m\r\n');
    };

    this.term.onData((data) => {
      if (this.termWs && this.termWs.readyState === WebSocket.OPEN) {
        this.termWs.send(data);
      }
    });

    window.addEventListener('resize', () => {
      if (this.activeTab === 'terminal' && this.fitAddon) {
        this.fitAddon.fit();
        this.sendTermResize();
      }
    });
  },

  sendTermResize() {
    if (this.term && this.termWs && this.termWs.readyState === WebSocket.OPEN) {
      this.termWs.send(JSON.stringify({
        type: 'resize',
        cols: this.term.cols,
        rows: this.term.rows
      }));
    }
  },

  // --- SSL Certificates Module ---
  async loadSslCerts() {
    const tbody = document.getElementById('ssl-table-body');
    if (tbody) tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 20px;">Загрузка сертификатов...</td></tr>';
    try {
      const res = await fetch('/api/ssl/certificates');
      if (res.ok) {
        const data = await res.json();
        if (data && data.installed === false) {
          this.showMissingService('ssl', 'certbot', 'Certbot (Let\'s Encrypt) не установлен на сервере', 'Установите Certbot для автоматического выпуска и продления бесплатных доверенных SSL-сертификатов HTTPS.', '🔒');
          return;
        }
        this.hideMissingService('ssl');
        this.sslCerts = data.certificates || [];
        this.renderSslCerts();
      } else {
        if (tbody) tbody.innerHTML = '<tr><td colspan="6" style="color: var(--accent-rose); padding: 16px;">Ошибка загрузки сертификатов</td></tr>';
      }
    } catch (err) {
      if (tbody) tbody.innerHTML = `<tr><td colspan="6" style="color: var(--accent-rose); padding: 16px;">${err.message}</td></tr>`;
    }
  },

  renderSslCerts() {
    const tbody = document.getElementById('ssl-table-body');
    let certs = this.sslCerts;

    const total = certs.length;
    const valid = certs.filter(c => c.status === 'valid').length;
    const expiring = certs.filter(c => c.status === 'expiring').length;
    const expired = certs.filter(c => c.status === 'expired').length;

    document.getElementById('ssl-stat-total').innerText = total;
    document.getElementById('ssl-stat-valid').innerText = valid;
    document.getElementById('ssl-stat-expiring').innerText = expiring;
    document.getElementById('ssl-stat-expired').innerText = expired;

    if (this.sslFilter) {
      certs = certs.filter(c => 
        c.name.toLowerCase().includes(this.sslFilter) ||
        (c.domains && c.domains.some(d => d.toLowerCase().includes(this.sslFilter)))
      );
    }

    if (certs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 24px;">Сертификаты не найдены</td></tr>';
      return;
    }

    tbody.innerHTML = certs.map(c => {
      let badgeClass = 'badge-pass';
      let statusLabel = 'Активен';
      if (c.status === 'expiring') {
        badgeClass = 'badge-warn';
        statusLabel = `Истекает через ${c.days_remaining} дн.`;
      } else if (c.status === 'expired') {
        badgeClass = 'badge-fail';
        statusLabel = 'Истёк';
      }

      const domainBadges = (c.domains || []).map(d => `<span class="badge" style="background: rgba(255,255,255,0.06); font-family: monospace;">${d}</span>`).join(' ');

      return `
        <tr>
          <td style="font-weight: 700; font-family: monospace; color: var(--accent-indigo);">${c.name}</td>
          <td>${domainBadges}</td>
          <td style="color: var(--text-muted); font-size: 0.85rem;">${c.expiry_date}</td>
          <td style="font-weight: 700; color: ${c.days_remaining <= 10 ? 'var(--accent-rose)' : (c.days_remaining <= 30 ? 'var(--accent-amber)' : 'var(--accent-emerald)')};">
            ${c.days_remaining > 0 ? c.days_remaining + ' дн.' : '0 дн.'}
          </td>
          <td><span class="badge ${badgeClass}">${statusLabel}</span></td>
          <td style="text-align: right;">
            <div style="display: flex; gap: 8px; justify-content: flex-end;">
              <button class="btn btn-secondary btn-sm" onclick="app.renewSsl('${c.name}')" title="Продлить через certbot">⟳ Продлить</button>
              <button class="btn btn-danger btn-sm" onclick="app.deleteSsl('${c.name}')" title="Удалить сертификат">✕</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  },

  async renewSsl(certName = null) {
    const msg = certName ? `Запущено продление сертификата ${certName}...` : 'Запущено продление всех сертификатов (certbot renew)...';
    this.showToast(msg, 'info');
    try {
      const res = await fetch('/api/ssl/renew', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cert_name: certName })
      });
      const data = await res.json();
      if (data.status) {
        this.showToast(data.message, 'success');
      } else {
        this.showToast(`Внимание: ${data.output || 'ошибка обновления'}`, 'error');
      }
      this.loadSslCerts();
    } catch (err) {
      this.showToast('Ошибка: ' + err.message, 'error');
    }
  },

  async submitIssueSsl() {
    const domain = document.getElementById('ssl-issue-domain').value.trim();
    const email = document.getElementById('ssl-issue-email').value.trim();
    if (!domain) {
      this.showToast('Укажите доменное имя', 'error');
      return;
    }
    this.closeModal('modal-issue-ssl');
    this.showToast(`Запрос выпуска сертификата для ${domain}...`, 'info');
    try {
      const res = await fetch('/api/ssl/issue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain, email })
      });
      const data = await res.json();
      if (res.ok && data.status) {
        this.showToast(data.message, 'success');
        this.loadSslCerts();
      } else {
        this.showToast(data.detail || 'Ошибка при выпуске сертификата', 'error');
      }
    } catch (err) {
      this.showToast('Ошибка сети: ' + err.message, 'error');
    }
  },

  async deleteSsl(certName) {
    if (!confirm(`Удалить SSL сертификат ${certName}? Nginx сайты, использующие его, могут перестать открываться по HTTPS!`)) return;
    try {
      const res = await fetch(`/api/ssl/certificates/${encodeURIComponent(certName)}`, { method: 'DELETE' });
      const data = await res.json();
      if (res.ok && data.status) {
        this.showToast(data.message, 'success');
        this.loadSslCerts();
      } else {
        this.showToast(data.detail || 'Ошибка удаления', 'error');
      }
    } catch (err) {
      this.showToast('Ошибка: ' + err.message, 'error');
    }
  },

  // --- Network & UFW Firewall Module ---
  async loadNetworkOverview() {
    try {
      const res = await fetch('/api/network/overview');
      if (res.ok) {
        this.netOverview = await res.json();
        this.renderNetworkOverview();
      }
    } catch (err) {
      console.error('Network overview error:', err);
    }
  },

  switchNetSubTab(sub) {
    this.netSubTab = sub;
    document.getElementById('tab-btn-ports').classList.toggle('active', sub === 'ports');
    document.getElementById('tab-btn-rules').classList.toggle('active', sub === 'rules');
    document.getElementById('net-subtab-ports').style.display = sub === 'ports' ? 'block' : 'none';
    document.getElementById('net-subtab-rules').style.display = sub === 'rules' ? 'block' : 'none';
  },

  renderNetworkOverview() {
    if (!this.netOverview) return;
    const ufw = this.netOverview.ufw;

    const badge = document.getElementById('ufw-status-badge');
    const toggleBtn = document.getElementById('btn-toggle-ufw');
    if (ufw.active) {
      badge.className = 'badge badge-pass';
      badge.innerText = 'Активен (Active)';
      toggleBtn.innerText = 'Отключить UFW';
      toggleBtn.className = 'btn btn-danger btn-sm';
    } else {
      badge.className = 'badge badge-fail';
      badge.innerText = 'Отключен (Inactive)';
      toggleBtn.innerText = 'Включить UFW';
      toggleBtn.className = 'btn btn-primary btn-sm';
    }

    this.renderListeningPorts();
    this.renderUfwRules();
  },

  renderListeningPorts() {
    const tbody = document.getElementById('ports-table-body');
    if (!this.netOverview) return;
    let ports = this.netOverview.listening_ports || [];

    if (this.netPortsFilter) {
      ports = ports.filter(p => 
        String(p.port).includes(this.netPortsFilter) ||
        p.proto.toLowerCase().includes(this.netPortsFilter) ||
        (p.process && p.process.toLowerCase().includes(this.netPortsFilter))
      );
    }

    if (ports.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 24px;">Порты не найдены</td></tr>';
      return;
    }

    tbody.innerHTML = ports.map(p => {
      let ufwBadge = '<span class="badge" style="background: rgba(255,255,255,0.06); color: var(--text-muted);">По умолчанию</span>';
      if (p.ufw_state === 'allowed') {
        ufwBadge = '<span class="badge badge-pass">ALLOW IN</span>';
      } else if (p.ufw_state === 'denied') {
        ufwBadge = '<span class="badge badge-fail">DENY IN</span>';
      }

      const isExternalBadge = p.is_external 
        ? '<span class="badge" style="background: rgba(6, 182, 212, 0.15); color: var(--accent-cyan);">Внешний (0.0.0.0/::)</span>' 
        : '<span class="badge" style="background: rgba(255,255,255,0.05); color: var(--text-dim);">Локальный</span>';

      return `
        <tr>
          <td><code style="font-weight: 700; font-size: 0.95rem; color: var(--accent-cyan);">${p.port}</code> <span style="font-size: 0.75rem; color: var(--text-muted);">/${p.proto}</span></td>
          <td style="font-weight: 600;">${p.process}</td>
          <td style="color: var(--text-dim); font-size: 0.82rem;">${p.pid || '—'}</td>
          <td style="font-family: monospace; font-size: 0.82rem; color: var(--text-muted);">${p.ip}</td>
          <td>${isExternalBadge}</td>
          <td>${ufwBadge}</td>
          <td style="text-align: right;">
            ${p.ufw_state !== 'allowed' ? `<button class="btn btn-secondary btn-sm" onclick="app.openUfwForPort('${p.port}', '${p.proto.toLowerCase()}')" title="Разрешить в UFW">+ Открыть в UFW</button>` : `<span style="font-size: 0.8rem; color: var(--accent-emerald);">✓ Открыт</span>`}
          </td>
        </tr>
      `;
    }).join('');
  },

  renderUfwRules() {
    const tbody = document.getElementById('ufw-rules-table-body');
    if (!this.netOverview) return;
    const rules = this.netOverview.ufw.rules || [];

    if (rules.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 24px;">Правил фаервола пока нет</td></tr>';
      return;
    }

    tbody.innerHTML = rules.map(r => {
      const isAllow = r.action.includes('ALLOW');
      const actionBadge = isAllow 
        ? '<span class="badge badge-pass">ALLOW IN</span>' 
        : '<span class="badge badge-fail">DENY IN</span>';

      return `
        <tr>
          <td><code>[${r.id}]</code></td>
          <td style="font-weight: 600; font-family: monospace; color: var(--accent-indigo);">${r.to}</td>
          <td>${actionBadge}</td>
          <td style="color: var(--text-muted); font-size: 0.85rem;">${r.from}</td>
          <td><span class="badge" style="background: rgba(255,255,255,0.06); font-size: 0.75rem;">${r.is_v6 ? 'IPv6' : 'IPv4'}</span></td>
          <td style="text-align: right;">
            <button class="btn btn-danger btn-sm" onclick="app.deleteUfwRule(${r.id})" title="Удалить правило">Удалить</button>
          </td>
        </tr>
      `;
    }).join('');
  },

  async toggleUfw() {
    if (!this.netOverview) return;
    const current = this.netOverview.ufw.active;
    const actionStr = current ? 'отключить' : 'включить';
    if (!confirm(`Вы действительно хотите ${actionStr} фаервол UFW?`)) return;

    try {
      const res = await fetch('/api/network/ufw/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enable: !current })
      });
      const data = await res.json();
      this.showToast(data.message, data.status ? 'success' : 'error');
      this.loadNetworkOverview();
    } catch (err) {
      this.showToast('Ошибка: ' + err.message, 'error');
    }
  },

  async openUfwForPort(port, proto) {
    try {
      const res = await fetch('/api/network/ufw/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port, proto, action: 'allow', from_ip: 'Anywhere' })
      });
      const data = await res.json();
      if (res.ok && data.status) {
        this.showToast(data.message, 'success');
        this.loadNetworkOverview();
      } else {
        this.showToast(data.detail || 'Ошибка добавления правила', 'error');
      }
    } catch (err) {
      this.showToast('Ошибка: ' + err.message, 'error');
    }
  },

  async submitAddUfwRule() {
    const port = document.getElementById('ufw-rule-port').value.trim();
    const action = document.getElementById('ufw-rule-action').value;
    const proto = document.getElementById('ufw-rule-proto').value;
    const from_ip = document.getElementById('ufw-rule-from').value.trim();

    if (!port) {
      this.showToast('Укажите порт', 'error');
      return;
    }

    try {
      const res = await fetch('/api/network/ufw/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port, action, proto, from_ip })
      });
      const data = await res.json();
      if (res.ok && data.status) {
        this.closeModal('modal-add-ufw');
        this.showToast(data.message, 'success');
        this.loadNetworkOverview();
      } else {
        this.showToast(data.detail || 'Ошибка добавления правила', 'error');
      }
    } catch (err) {
      this.showToast('Ошибка: ' + err.message, 'error');
    }
  },

  async deleteUfwRule(ruleId) {
    if (!confirm(`Удалить правило фаервола #${ruleId}?`)) return;
    try {
      const res = await fetch(`/api/network/ufw/rules/${ruleId}`, { method: 'DELETE' });
      const data = await res.json();
      if (res.ok && data.status) {
        this.showToast(data.message, 'success');
        this.loadNetworkOverview();
      } else {
        this.showToast(data.detail || 'Ошибка удаления', 'error');
      }
    } catch (err) {
      this.showToast('Ошибка: ' + err.message, 'error');
    }
  },

  // --- S.M.A.R.T. Disks Module ---
  async loadSmartDisks() {
    const container = document.getElementById('smart-disks-container');
    container.innerHTML = '<div class="card" style="text-align: center; color: var(--text-muted); padding: 32px;">Опрос накопителей через smartctl...</div>';
    try {
      const res = await fetch('/api/smart/disks');
      if (res.ok) {
        const data = await res.json();
        this.smartDisks = data.disks || [];
        this.renderSmartDisks();
      } else {
        container.innerHTML = '<div class="card" style="color: var(--accent-rose); padding: 24px;">Не удалось получить данные S.M.A.R.T.</div>';
      }
    } catch (err) {
      container.innerHTML = `<div class="card" style="color: var(--accent-rose); padding: 24px;">${err.message}</div>`;
    }
  },

  renderSmartDisks() {
    const container = document.getElementById('smart-disks-container');
    if (!this.smartDisks || this.smartDisks.length === 0) {
      container.innerHTML = '<div class="card" style="text-align: center; color: var(--text-muted); padding: 32px;">Физические накопители не обнаружены</div>';
      return;
    }

    container.innerHTML = this.smartDisks.map(d => {
      let tempHtml = '<span class="temp-pill temp-good">Н/Д</span>';
      if (d.temperature !== null && d.temperature !== undefined) {
        let tClass = 'temp-good';
        if (d.temperature >= 55) tClass = 'temp-hot';
        else if (d.temperature >= 45) tClass = 'temp-warm';
        tempHtml = `<span class="temp-pill ${tClass}">🌡️ ${d.temperature}°C</span>`;
      }

      const healthBadge = d.health_passed 
        ? '<span class="badge badge-pass">✓ PASSED (Здоров)</span>' 
        : '<span class="badge badge-fail">⚠️ FAILED (Внимание)</span>';

      const typeBadge = d.is_ssd 
        ? '<span class="badge" style="background: rgba(6, 182, 212, 0.15); color: var(--accent-cyan); font-weight: 700;">SSD</span>' 
        : '<span class="badge" style="background: rgba(139, 92, 246, 0.15); color: var(--accent-purple); font-weight: 700;">HDD 3.5"</span>';

      const hoursStr = d.power_hours ? `${d.power_hours.toLocaleString()} ч. (~${(d.power_hours / 8760).toFixed(1)} г.)` : '—';

      const partsHtml = (d.partitions || []).map(p => {
        return `
          <div style="display: flex; align-items: center; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.04); font-size: 0.85rem;">
            <div style="display: flex; gap: 10px; align-items: center;">
              <code style="font-weight: 600;">${p.name}</code>
              <span class="badge badge-ssl" style="font-size: 0.72rem;">${p.fstype || 'raw'}</span>
              <span style="color: var(--text-dim);">${p.mount ? 'Точка монтирования: ' + p.mount : 'Не смонтирован'}</span>
            </div>
            <div style="font-weight: 600; color: var(--text-muted);">${this.formatBytes(p.size)}</div>
          </div>
        `;
      }).join('');

      return `
        <div class="disk-smart-card">
          <div class="disk-header-row">
            <div class="disk-title-group">
              <div class="disk-icon-box">${d.is_ssd ? '⚡' : '💽'}</div>
              <div>
                <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
                  <h3 style="font-size: 1.15rem; font-weight: 700;">${d.model}</h3>
                  ${typeBadge}
                  ${healthBadge}
                </div>
                <div style="font-size: 0.82rem; color: var(--text-muted); margin-top: 4px;">
                  Устройство: <code>${d.path}</code> • Серийный номер: <code>${d.serial}</code> • Объём: <strong>${this.formatBytes(d.size)}</strong>
                </div>
              </div>
            </div>
            <div style="display: flex; gap: 10px; align-items: center;">
              <button class="btn btn-secondary btn-sm" onclick="app.openSmartAttrsModal('${d.name}')">🔍 Все атрибуты S.M.A.R.T.</button>
              <button class="btn btn-primary btn-sm" onclick="app.runSmartTest('${d.name}')">⚡ Быстрый тест</button>
            </div>
          </div>

          <div class="disk-metrics-grid">
            <div class="disk-metric-item">
              <div class="disk-metric-title">Температура</div>
              <div class="disk-metric-val">${tempHtml}</div>
            </div>
            <div class="disk-metric-item">
              <div class="disk-metric-title">Время наработки</div>
              <div class="disk-metric-val" style="font-size: 0.95rem;">${hoursStr}</div>
            </div>
            <div class="disk-metric-item">
              <div class="disk-metric-title">Включений (Power Cycles)</div>
              <div class="disk-metric-val">${d.power_cycles !== null && d.power_cycles !== undefined ? d.power_cycles : '—'}</div>
            </div>
            <div class="disk-metric-item">
              <div class="disk-metric-title">Сбойные сектора (Reallocated)</div>
              <div class="disk-metric-val" style="color: ${d.reallocated_sectors > 0 ? 'var(--accent-rose)' : 'var(--accent-emerald)'};">
                ${d.reallocated_sectors}
              </div>
            </div>
            <div class="disk-metric-item">
              <div class="disk-metric-title">Ожидающие (Pending)</div>
              <div class="disk-metric-val" style="color: ${d.pending_sectors > 0 ? 'var(--accent-amber)' : 'var(--text-main)'};">
                ${d.pending_sectors}
              </div>
            </div>
            ${d.ssd_life !== null ? `
              <div class="disk-metric-item">
                <div class="disk-metric-title">Ресурс SSD (Health)</div>
                <div class="disk-metric-val" style="color: var(--accent-emerald);">${d.ssd_life}%</div>
              </div>
            ` : ''}
          </div>

          ${d.partitions && d.partitions.length > 0 ? `
            <div style="background: rgba(10, 15, 26, 0.4); border-radius: var(--radius-sm); padding: 12px 16px;">
              <div style="font-size: 0.75rem; text-transform: uppercase; color: var(--text-dim); margin-bottom: 8px; font-weight: 600;">Разделы на диске:</div>
              ${partsHtml}
            </div>
          ` : ''}
        </div>
      `;
    }).join('');
  },

  openSmartAttrsModal(devName) {
    const disk = this.smartDisks.find(d => d.name === devName);
    if (!disk) return;

    document.getElementById('smart-attrs-title').innerText = `S.M.A.R.T. атрибуты: ${disk.model} (${disk.path})`;
    const tbody = document.getElementById('smart-attrs-table-body');

    if (!disk.attributes || disk.attributes.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 20px;">Подробная таблица атрибутов для этого накопителя недоступна через sat/scsi интерфейс</td></tr>';
    } else {
      tbody.innerHTML = disk.attributes.map(a => `
        <tr>
          <td><code>${a.id}</code></td>
          <td style="font-weight: 600; font-family: monospace;">${a.name}</td>
          <td>${a.value}</td>
          <td style="color: var(--text-dim);">${a.worst}</td>
          <td style="color: var(--text-dim);">${a.thresh}</td>
          <td style="font-family: monospace; font-weight: 600; color: var(--accent-indigo);">${a.raw}</td>
          <td>
            ${a.failed ? '<span class="badge badge-fail">ПРЕВЫШЕН</span>' : '<span class="badge badge-pass">OK</span>'}
          </td>
        </tr>
      `).join('');
    }

    this.openModal('modal-smart-attrs');
  },

  async runSmartTest(devName) {
    this.showToast(`Запуск короткого теста S.M.A.R.T. для /dev/${devName}...`, 'info');
    try {
      const res = await fetch('/api/smart/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device: devName, type: 'short' })
      });
      const data = await res.json();
      this.showToast(data.message, data.status ? 'success' : 'error');
    } catch (err) {
      this.showToast('Ошибка запуска теста: ' + err.message, 'error');
    }
  },

  // --- Cron Scheduler Module ---
  async loadCronJobs() {
    const tbody = document.getElementById('cron-table-body');
    tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">Загрузка расписания cron...</td></tr>';
    try {
      const res = await fetch(`/api/cron?user_name=${this.cronUser}`);
      if (res.ok) {
        const data = await res.json();
        this.cronJobs = data.jobs || [];
        this.renderCronJobs();
      } else {
        tbody.innerHTML = '<tr><td colspan="5" style="color: var(--accent-rose);">Не удалось загрузить задачи cron</td></tr>';
      }
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="5" style="color: var(--accent-rose);">${err.message}</td></tr>`;
    }
  },

  renderCronJobs() {
    const tbody = document.getElementById('cron-table-body');
    let jobs = this.cronJobs;

    if (this.cronSearchQuery) {
      jobs = jobs.filter(j => 
        j.command.toLowerCase().includes(this.cronSearchQuery) ||
        j.expression.includes(this.cronSearchQuery) ||
        (j.human && j.human.toLowerCase().includes(this.cronSearchQuery))
      );
    }

    if (jobs.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 32px;">У пользователя <strong>${this.cronUser}</strong> нет активных задач cron</td></tr>`;
      return;
    }

    tbody.innerHTML = jobs.map(j => {
      return `
        <tr style="${!j.enabled ? 'opacity: 0.55;' : ''}">
          <td>
            <label class="switch">
              <input type="checkbox" ${j.enabled ? 'checked' : ''} onchange="app.toggleCronJob(${j.id})">
              <span class="slider"></span>
            </label>
          </td>
          <td>
            <span class="badge" style="background: rgba(99, 102, 241, 0.15); color: var(--accent-indigo); font-weight: 600;">
              ${j.human}
            </span>
          </td>
          <td><code style="font-family: 'JetBrains Mono', monospace; font-size: 0.88rem; color: var(--accent-cyan);">${j.expression}</code></td>
          <td>
            <div style="font-family: 'JetBrains Mono', monospace; font-size: 0.84rem; max-width: 450px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${j.command}">
              ${j.command}
            </div>
          </td>
          <td style="text-align: right;">
            <div style="display: flex; gap: 8px; justify-content: flex-end;">
              <button class="btn btn-secondary btn-sm" onclick="app.runCronJobNow('${encodeURIComponent(j.command)}')" title="Выполнить команду сейчас">▶ Запустить</button>
              <button class="btn btn-secondary btn-sm" onclick="app.editCronJob(${j.id})" title="Редактировать">✏</button>
              <button class="btn btn-danger btn-sm" onclick="app.deleteCronJob(${j.id})" title="Удалить задачу">🗑</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  },

  updateCronPreview() {
    const expr = document.getElementById('cron-expr-input').value.trim();
    const previewEl = document.getElementById('cron-preview-text');
    if (!expr) {
      previewEl.innerText = '';
      return;
    }
    const parts = expr.split(/\s+/);
    if (parts.length !== 5) {
      previewEl.innerText = '⚠️ В выражении cron должно быть ровно 5 полей через пробел';
      previewEl.style.color = 'var(--accent-amber)';
      return;
    }
    previewEl.style.color = 'var(--accent-cyan)';
    if (expr === '* * * * *') previewEl.innerText = '✓ Выполняется каждую минуту';
    else if (parts[0].startsWith('*/')) previewEl.innerText = `✓ Выполняется каждые ${parts[0].substring(2)} мин.`;
    else if (parts[1].startsWith('*/')) previewEl.innerText = `✓ Выполняется каждые ${parts[1].substring(2)} ч.`;
    else if (parts[2] === '*' && parts[3] === '*' && parts[4] === '*') previewEl.innerText = `✓ Ежедневно в ${parts[1].padStart(2, '0')}:${parts[0].padStart(2, '0')}`;
    else previewEl.innerText = `✓ Расписание: ${expr}`;
  },

  async toggleCronJob(jobId) {
    try {
      const res = await fetch('/api/cron/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: this.cronUser, id: jobId })
      });
      const data = await res.json();
      if (res.ok && data.status) {
        this.showToast(data.message, 'success');
        this.loadCronJobs();
      } else {
        this.showToast(data.detail || 'Ошибка переключения', 'error');
      }
    } catch (err) {
      this.showToast('Ошибка: ' + err.message, 'error');
    }
  },

  editCronJob(jobId) {
    const job = this.cronJobs.find(j => j.id === jobId);
    if (!job) return;
    this.cronEditingId = jobId;
    document.getElementById('cron-expr-input').value = job.expression;
    document.getElementById('cron-cmd-input').value = job.command;
    document.getElementById('cron-comment-input').value = '';
    this.updateCronPreview();
    this.openModal('modal-edit-cron');
  },

  async submitCronJob() {
    const expr = document.getElementById('cron-expr-input').value.trim();
    const cmd = document.getElementById('cron-cmd-input').value.trim();
    const comment = document.getElementById('cron-comment-input').value.trim();

    if (!expr || !cmd) {
      this.showToast('Заполните выражение расписания и команду', 'error');
      return;
    }

    try {
      if (this.cronEditingId !== null) {
        await fetch(`/api/cron?user_name=${this.cronUser}&job_id=${this.cronEditingId}`, { method: 'DELETE' });
      }

      const res = await fetch('/api/cron', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user: this.cronUser,
          expression: expr,
          command: cmd,
          comment: comment
        })
      });

      const data = await res.json();
      if (res.ok && data.status) {
        this.closeModal('modal-edit-cron');
        this.showToast(data.message, 'success');
        this.loadCronJobs();
      } else {
        this.showToast(data.detail || 'Ошибка сохранения задачи', 'error');
      }
    } catch (err) {
      this.showToast('Ошибка: ' + err.message, 'error');
    }
  },

  async deleteCronJob(jobId) {
    if (!confirm('Вы действительно хотите удалить эту задачу из расписания cron?')) return;
    try {
      const res = await fetch(`/api/cron?user_name=${this.cronUser}&job_id=${jobId}`, { method: 'DELETE' });
      const data = await res.json();
      if (res.ok && data.status) {
        this.showToast(data.message, 'success');
        this.loadCronJobs();
      } else {
        this.showToast(data.detail || 'Ошибка удаления', 'error');
      }
    } catch (err) {
      this.showToast('Ошибка: ' + err.message, 'error');
    }
  },

  async runCronJobNow(encodedCmd) {
    const cmd = decodeURIComponent(encodedCmd);
    this.showToast(`Выполняется: ${cmd.substring(0, 40)}...`, 'info');
    
    document.getElementById('cron-run-status-badge').className = 'badge badge-ssl';
    document.getElementById('cron-run-status-badge').innerText = 'Выполняется...';
    document.getElementById('cron-run-duration').innerText = '—';
    document.getElementById('cron-run-content').innerText = 'Команда запущена, ожидание вывода...';
    this.openModal('modal-cron-run-output');

    try {
      const res = await fetch('/api/cron/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd })
      });
      const data = await res.json();

      document.getElementById('cron-run-duration').innerText = `${data.duration_ms} мс`;
      if (data.code === 0) {
        document.getElementById('cron-run-status-badge').className = 'badge badge-pass';
        document.getElementById('cron-run-status-badge').innerText = 'Успешно (код 0)';
      } else {
        document.getElementById('cron-run-status-badge').className = 'badge badge-fail';
        document.getElementById('cron-run-status-badge').innerText = `Код ошибки ${data.code}`;
      }

      const out = (data.stdout + '\n' + data.stderr).trim() || '(Команда завершилась без вывода в stdout/stderr)';
      document.getElementById('cron-run-content').innerText = out;
    } catch (err) {
      document.getElementById('cron-run-status-badge').className = 'badge badge-fail';
      document.getElementById('cron-run-status-badge').innerText = 'Сбой сети';
      document.getElementById('cron-run-content').innerText = err.message;
    }
  },

  
  // ==========================================
  // --- Samba (SMB) Module ---
  // ==========================================
  sambaShares: [],

  async loadSambaOverview() {
    try {
      const res = await fetch('/api/samba/overview');
      if (!res.ok) throw new Error('Ошибка получения данных Samba');
      const data = await res.json();

      if (data && data.installed === false) {
        this.showMissingService('samba', 'samba', 'Samba (SMB) не установлена на сервере', 'Установите Samba для создания общих сетевых папок, доступных напрямую в проводнике Windows и macOS.', '📁');
        return;
      }
      this.hideMissingService('samba');

      // Status badges
      const statusBadge = document.getElementById('samba-status-badge');
      if (statusBadge) {
        statusBadge.innerHTML = data.smbd_active 
          ? '<span class="badge badge-emerald">smbd: Активна</span>' 
          : '<span class="badge badge-rose">smbd: Остановлена</span>';
      }

      const versionText = document.getElementById('samba-version-text');
      if (versionText) versionText.innerText = data.version || 'Samba 4.x';

      const port139 = document.getElementById('samba-port-139');
      if (port139) port139.className = data.ports['139'] ? 'badge badge-emerald' : 'badge badge-rose';
      const port445 = document.getElementById('samba-port-445');
      if (port445) port445.className = data.ports['445'] ? 'badge badge-emerald' : 'badge badge-rose';

      // Counts
      this.sambaShares = data.shares || [];
      const sharesCount = document.getElementById('samba-shares-count');
      if (sharesCount) sharesCount.innerText = this.sambaShares.length;

      const sessionsCount = document.getElementById('samba-sessions-count');
      if (sessionsCount) sessionsCount.innerText = (data.sessions || []).length;

      const usersText = document.getElementById('samba-users-count-text');
      if (usersText) usersText.innerText = `Пользователей SMB: ${(data.users || []).length}`;

      // Render Shares Table
      const sharesTbody = document.getElementById('samba-shares-tbody');
      if (sharesTbody) {
        if (this.sambaShares.length === 0) {
          sharesTbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 24px;">Нет настроенных сетевых папок. Нажмите "+ Создать сетевую папку"</td></tr>';
        } else {
          sharesTbody.innerHTML = this.sambaShares.map(s => {
            const pathWarning = !s.path_exists ? ' <span title="Каталог не найден на сервере" style="color: var(--accent-rose); cursor: help;">⚠️</span>' : '';
            const unc = `\\\\${data.server_ip}\\${s.name}`;
            return `
              <tr>
                <td>
                  <div style="font-weight: 700; color: #f8fafc; display: flex; align-items: center; gap: 6px;">
                    📁 [${s.name}]
                  </div>
                  <div style="font-size: 0.75rem; color: var(--text-muted);">${s.comment || 'Без описания'}</div>
                </td>
                <td>
                  <code style="font-size: 0.8rem; background: rgba(0,0,0,0.3); padding: 2px 6px; border-radius: 4px;">${s.path}</code>${pathWarning}
                </td>
                <td>
                  <div style="display: flex; align-items: center; gap: 6px;">
                    <code style="font-size: 0.78rem; color: var(--accent-cyan);">${unc}</code>
                    <button class="btn btn-secondary btn-sm" style="padding: 2px 6px; font-size: 0.7rem;" title="Копировать путь для Windows" onclick="app.copyToClipboard('${unc.replace(/\\/g, '\\\\')}')">📋</button>
                  </div>
                </td>
                <td>
                  ${s.read_only ? '<span class="badge badge-amber">Только чтение</span>' : '<span class="badge badge-emerald">Чтение и запись</span>'}
                </td>
                <td>
                  ${s.guest_ok ? '<span class="badge badge-cyan">Гостевой (без пароля)</span>' : '<span class="badge badge-purple">Пароль SMB</span>'}
                </td>
                <td>
                  <span style="font-size: 0.8rem; color: ${s.valid_users ? '#94a3b8' : 'var(--text-muted)'};">
                    ${s.valid_users || 'Все авторизованные'}
                  </span>
                </td>
                <td style="text-align: right;">
                  <button class="btn btn-secondary btn-sm" onclick="app.editSambaShare('${s.name}')" title="Редактировать">✏️</button>
                  <button class="btn btn-danger btn-sm" onclick="app.deleteSambaShare('${s.name}')" title="Удалить">🗑️</button>
                </td>
              </tr>
            `;
          }).join('');
        }
      }

      // Render Samba Users
      const usersBadge = document.getElementById('samba-users-badge');
      if (usersBadge) usersBadge.innerText = `${(data.users || []).length} пользователей`;
      const usersTbody = document.getElementById('samba-users-tbody');
      if (usersTbody) {
        if (!data.users || data.users.length === 0) {
          usersTbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 16px;">Пользователи Samba не найдены</td></tr>';
        } else {
          usersTbody.innerHTML = data.users.map(u => `
            <tr>
              <td><strong>${u.username}</strong></td>
              <td><code>${u.uid || '-'}</code></td>
              <td>${u.fullname || 'SMB Account'}</td>
              <td style="text-align: right;">
                <button class="btn btn-secondary btn-sm" onclick="app.openSambaPasswordModal('${u.username}')" title="Сменить пароль SMB">🔑</button>
                <button class="btn btn-danger btn-sm" onclick="app.deleteSambaUser('${u.username}')" title="Удалить из Samba">🗑️</button>
              </td>
            </tr>
          `).join('');
        }
      }

      // Render Active Sessions
      const sessionsBadge = document.getElementById('samba-sessions-badge');
      if (sessionsBadge) sessionsBadge.innerText = `${(data.sessions || []).length} клиентов`;
      const sessionsTbody = document.getElementById('samba-sessions-tbody');
      if (sessionsTbody) {
        if (!data.sessions || data.sessions.length === 0) {
          sessionsTbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 16px;">Нет активных подключений в данный момент</td></tr>';
        } else {
          sessionsTbody.innerHTML = data.sessions.map(s => `
            <tr>
              <td><strong>${s.username}</strong></td>
              <td><code>${s.machine}</code></td>
              <td><span class="badge badge-emerald">${s.protocol}</span></td>
              <td><code>${s.pid}</code></td>
            </tr>
          `).join('');
        }
      }

    } catch (err) {
      this.showToast('Ошибка загрузки Samba: ' + err.message, 'error');
    }
  },

  openSambaShareModal(share = null) {
    document.getElementById('samba-share-modal-title').innerText = share ? `Редактирование [${share.name}]` : 'Новая сетевая папка Samba';
    document.getElementById('samba-share-old-name').value = share ? share.name : '';
    document.getElementById('samba-share-name').value = share ? share.name : '';
    document.getElementById('samba-share-path').value = share ? share.path : '/var/www/';
    document.getElementById('samba-share-comment').value = share ? share.comment : '';
    document.getElementById('samba-share-readonly').checked = share ? share.read_only : false;
    document.getElementById('samba-share-guest').checked = share ? share.guest_ok : false;
    document.getElementById('samba-share-browseable').checked = share ? share.browseable : true;
    document.getElementById('samba-share-valid-users').value = share ? share.valid_users : '';
    document.getElementById('samba-share-create-mask').value = share ? share.create_mask : '0775';
    document.getElementById('samba-share-dir-mask').value = share ? share.directory_mask : '0775';
    this.openModal('modal-samba-share');
  },

  editSambaShare(shareName) {
    const s = this.sambaShares.find(item => item.name === shareName);
    if (s) this.openSambaShareModal(s);
  },

  async submitSambaShare() {
    const name = document.getElementById('samba-share-name').value.trim();
    const oldName = document.getElementById('samba-share-old-name').value.trim();
    const path = document.getElementById('samba-share-path').value.trim();
    const comment = document.getElementById('samba-share-comment').value.trim();
    const readOnly = document.getElementById('samba-share-readonly').checked;
    const guestOk = document.getElementById('samba-share-guest').checked;
    const browseable = document.getElementById('samba-share-browseable').checked;
    const validUsers = document.getElementById('samba-share-valid-users').value.trim();
    const createMask = document.getElementById('samba-share-create-mask').value.trim();
    const dirMask = document.getElementById('samba-share-dir-mask').value.trim();

    if (!name || !path) {
      alert('Укажите имя папки и путь');
      return;
    }

    try {
      const res = await fetch('/api/samba/shares', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name,
          old_name: oldName,
          path: path,
          comment: comment,
          read_only: readOnly,
          guest_ok: guestOk,
          browseable: browseable,
          valid_users: validUsers,
          create_mask: createMask,
          directory_mask: dirMask
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Ошибка сохранения');
      this.closeModal('modal-samba-share');
      this.showToast(data.message || 'Сетевая папка сохранена!', 'success');
      this.loadSambaOverview();
    } catch (err) {
      this.showToast(err.message, 'error');
    }
  },

  async deleteSambaShare(shareName) {
    if (!confirm(`Вы действительно хотите удалить сетевую папку [${shareName}] из smb.conf? Сами файлы на диске останутся нетронутыми.`)) return;
    try {
      const res = await fetch(`/api/samba/shares/${encodeURIComponent(shareName)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Ошибка удаления');
      this.showToast(data.message || 'Папка удалена из Samba', 'success');
      this.loadSambaOverview();
    } catch (err) {
      this.showToast(err.message, 'error');
    }
  },

  openSambaUserModal() {
    document.getElementById('samba-user-name').value = '';
    document.getElementById('samba-user-pass').value = '';
    this.openModal('modal-samba-user');
  },

  openSambaPasswordModal(username) {
    document.getElementById('samba-user-name').value = username;
    document.getElementById('samba-user-pass').value = '';
    this.openModal('modal-samba-user');
  },

  async submitSambaUser() {
    const u = document.getElementById('samba-user-name').value.trim();
    const p = document.getElementById('samba-user-pass').value.trim();
    const createSys = document.getElementById('samba-user-create-sys').checked;
    if (!u || !p) {
      alert('Укажите логин и пароль');
      return;
    }

    try {
      const res = await fetch('/api/samba/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u, password: p, create_system_user: createSys })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Ошибка добавления пользователя');
      this.closeModal('modal-samba-user');
      this.showToast(data.message || 'Пользователь Samba сохранен', 'success');
      this.loadSambaOverview();
    } catch (err) {
      this.showToast(err.message, 'error');
    }
  },

  async deleteSambaUser(username) {
    if (!confirm(`Удалить пользователя ${username} из Samba?`)) return;
    try {
      const res = await fetch(`/api/samba/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Ошибка');
      this.showToast(data.message || 'Пользователь удален из Samba', 'success');
      this.loadSambaOverview();
    } catch (err) {
      this.showToast(err.message, 'error');
    }
  },

  async restartSamba() {
    try {
      this.showToast('Перезапуск Samba...', 'info');
      const res = await fetch('/api/samba/service', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'restart' })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Ошибка перезапуска');
      this.showToast(data.message || 'Samba перезапущена!', 'success');
      this.loadSambaOverview();
    } catch (err) {
      this.showToast(err.message, 'error');
    }
  },

  async testparmSamba() {
    try {
      const res = await fetch('/api/samba/testparm', { method: 'POST' });
      const data = await res.json();
      alert(`[testparm результат]:

${data.output}`);
    } catch (err) {
      this.showToast('Ошибка testparm: ' + err.message, 'error');
    }
  },

  async openSambaConfigModal() {
    try {
      const res = await fetch('/api/samba/config');
      const data = await res.json();
      document.getElementById('samba-config-editor-area').value = data.content || '';
      this.openModal('modal-samba-config');
    } catch (err) {
      this.showToast('Ошибка загрузки smb.conf: ' + err.message, 'error');
    }
  },

  async saveSambaConfig() {
    const content = document.getElementById('samba-config-editor-area').value;
    try {
      const res = await fetch('/api/samba/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: content })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Ошибка сохранения');
      this.closeModal('modal-samba-config');
      this.showToast(data.message || 'smb.conf успешно сохранен!', 'success');
      this.loadSambaOverview();
    } catch (err) {
      alert(`Ошибка валидации или сохранения:
${err.message}`);
    }
  },


  // ==========================================
  // --- FTP Server (vsftpd) Module ---
  // ==========================================
  async loadFtpOverview() {
    try {
      const res = await fetch('/api/ftp/overview');
      if (!res.ok) throw new Error('Ошибка получения статуса FTP');
      const data = await res.json();

      if (data && data.installed === false) {
        this.showMissingService('ftp', 'ftp', 'FTP-сервер (vsftpd) не установлен на сервере', 'Установите vsftpd для быстрой и защищенной передачи файлов по протоколу FTP с изоляцией пользователей.', '📡');
        return;
      }
      this.hideMissingService('ftp');

      // Badges
      const statusBadge = document.getElementById('ftp-status-badge');
      if (statusBadge) {
        statusBadge.innerHTML = data.active
          ? '<span class="badge badge-emerald">vsftpd: Запущена</span>'
          : '<span class="badge badge-rose">vsftpd: Остановлена</span>';
      }

      const pasvBadge = document.getElementById('ftp-pasv-range-badge');
      if (pasvBadge && data.settings) {
        pasvBadge.innerText = `${data.settings.pasv_min_port} — ${data.settings.pasv_max_port}`;
      }

      const connectUrl = document.getElementById('ftp-connect-url');
      if (connectUrl) connectUrl.innerText = data.url || `ftp://${data.server_ip}:21`;

      const usersCount = document.getElementById('ftp-users-count');
      if (usersCount) usersCount.innerText = (data.users || []).length;

      const connsCount = document.getElementById('ftp-conns-count');
      if (connsCount) connsCount.innerText = data.connections_count || 0;

      // Settings form fields
      if (data.settings) {
        const optWrite = document.getElementById('ftp-opt-write-enable');
        if (optWrite) optWrite.checked = data.settings.write_enable;
        const optChroot = document.getElementById('ftp-opt-chroot');
        if (optChroot) optChroot.checked = data.settings.chroot_local_user;
        const optAnon = document.getElementById('ftp-opt-anonymous');
        if (optAnon) optAnon.checked = data.settings.anonymous_enable;
        const optMin = document.getElementById('ftp-opt-pasv-min');
        if (optMin) optMin.value = data.settings.pasv_min_port;
        const optMax = document.getElementById('ftp-opt-pasv-max');
        if (optMax) optMax.value = data.settings.pasv_max_port;
      }

      // Render FTP Users
      const usersTbody = document.getElementById('ftp-users-tbody');
      if (usersTbody) {
        if (!data.users || data.users.length === 0) {
          usersTbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 20px;">Нет пользователей</td></tr>';
        } else {
          usersTbody.innerHTML = data.users.map(u => `
            <tr>
              <td><strong style="color: #f8fafc;">${u.username}</strong></td>
              <td><code>${u.uid}</code></td>
              <td><code style="font-size: 0.8rem; background: rgba(0,0,0,0.3); padding: 2px 6px; border-radius: 4px;">${u.home}</code></td>
              <td><span style="font-size: 0.78rem; color: var(--text-muted);">${u.shell}</span></td>
              <td style="text-align: right;">
                <button class="btn btn-secondary btn-sm" onclick="app.openChangePasswordModal('${u.username}')" title="Сменить пароль">🔑 Пароль</button>
              </td>
            </tr>
          `).join('');
        }
      }

    } catch (err) {
      this.showToast('Ошибка загрузки FTP: ' + err.message, 'error');
    }
  },

  async submitFtpSettings() {
    const writeEnable = document.getElementById('ftp-opt-write-enable').checked;
    const chroot = document.getElementById('ftp-opt-chroot').checked;
    const anon = document.getElementById('ftp-opt-anonymous').checked;
    const pasvMin = parseInt(document.getElementById('ftp-opt-pasv-min').value) || 39000;
    const pasvMax = parseInt(document.getElementById('ftp-opt-pasv-max').value) || 40000;

    try {
      this.showToast('Сохранение настроек FTP...', 'info');
      const res = await fetch('/api/ftp/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          write_enable: writeEnable,
          chroot_local_user: chroot,
          anonymous_enable: anon,
          pasv_min_port: pasvMin,
          pasv_max_port: pasvMax
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Ошибка');
      this.showToast(data.message || 'Настройки FTP обновлены!', 'success');
      this.loadFtpOverview();
    } catch (err) {
      this.showToast(err.message, 'error');
    }
  },

  async restartFtp() {
    try {
      this.showToast('Перезапуск vsftpd...', 'info');
      const res = await fetch('/api/ftp/service', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'restart' })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Ошибка');
      this.showToast(data.message || 'FTP перезапущен!', 'success');
      this.loadFtpOverview();
    } catch (err) {
      this.showToast(err.message, 'error');
    }
  },

  async runFtpTest() {
    const u = document.getElementById('ftp-test-username').value.trim();
    const p = document.getElementById('ftp-test-password').value.trim();
    const resultBox = document.getElementById('ftp-test-result-box');
    const statusEl = document.getElementById('ftp-test-result-status');
    const detailsEl = document.getElementById('ftp-test-result-details');

    resultBox.style.display = 'block';
    statusEl.innerHTML = '<span style="color: var(--accent-amber);">Подключение к 127.0.0.1:21...</span>';
    detailsEl.innerHTML = '';

    try {
      const res = await fetch('/api/ftp/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u, password: p })
      });
      const data = await res.json();
      if (data.status) {
        statusEl.innerHTML = `<span style="color: var(--accent-emerald);">✓ Подключение успешно (${data.duration_ms} мс)</span>`;
        detailsEl.innerHTML = `
          <div>Сервер: ${data.banner || 'vsftpd'}</div>
          <div>Ответ входа: ${data.login_res || 'OK'}</div>
          <div>Файлы корня: ${(data.sample_files || []).join(', ') || 'Пусто'}</div>
        `;
      } else {
        statusEl.innerHTML = `<span style="color: var(--accent-rose);">✕ Ошибка подключения (${data.duration_ms} мс)</span>`;
        detailsEl.innerHTML = `<div>${data.message || data.error}</div>`;
      }
    } catch (err) {
      statusEl.innerHTML = `<span style="color: var(--accent-rose);">✕ Ошибка сети: ${err.message}</span>`;
    }
  },

  openFtpUserModal() {
    document.getElementById('ftp-user-name').value = '';
    document.getElementById('ftp-user-pass').value = '';
    document.getElementById('ftp-user-home').value = '/var/www';
    this.openModal('modal-ftp-user');
  },

  async submitFtpUser() {
    const u = document.getElementById('ftp-user-name').value.trim();
    const p = document.getElementById('ftp-user-pass').value.trim();
    const home = document.getElementById('ftp-user-home').value.trim();
    const shell = document.getElementById('ftp-user-shell').value;

    if (!u || !p || !home) {
      alert('Заполните все поля');
      return;
    }

    try {
      const res = await fetch('/api/users/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u, password: p, shell: shell, is_sudo: false })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Ошибка создания пользователя');
      this.closeModal('modal-ftp-user');
      this.showToast(data.message || `Пользователь ${u} создан!`, 'success');
      this.loadFtpOverview();
    } catch (err) {
      this.showToast(err.message, 'error');
    }
  },

  async openFtpConfigModal() {
    try {
      const res = await fetch('/api/ftp/config');
      const data = await res.json();
      document.getElementById('ftp-config-editor-area').value = data.content || '';
      this.openModal('modal-ftp-config');
    } catch (err) {
      this.showToast('Ошибка загрузки vsftpd.conf: ' + err.message, 'error');
    }
  },

  async saveFtpConfig() {
    const content = document.getElementById('ftp-config-editor-area').value;
    try {
      const res = await fetch('/api/ftp/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: content })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Ошибка сохранения');
      this.closeModal('modal-ftp-config');
      this.showToast(data.message || 'vsftpd.conf сохранен и перезапущен!', 'success');
      this.loadFtpOverview();
    } catch (err) {
      this.showToast(err.message, 'error');
    }
  },

  copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        this.showToast(`Скопировано: ${text}`, 'success');
      }).catch(() => {
        prompt('Скопируйте вручную:', text);
      });
    } else {
      prompt('Скопируйте вручную:', text);
    }
  },

// --- Modals & Toasts ---
  openModal(id) {
    document.getElementById(id).classList.add('open');
  },

  closeModal(id) {
    document.getElementById(id).classList.remove('open');
  },

  showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerText = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(100%)';
      toast.style.transition = 'all 0.25s ease';
      setTimeout(() => toast.remove(), 250);
    }, 4000);
  },

  // Helpers
  formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  },

  formatUptime(sec) {
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    let res = '';
    if (d > 0) res += `${d}д `;
    if (h > 0) res += `${h}ч `;
    res += `${m}м`;
    return res;
  }
};

window.addEventListener('DOMContentLoaded', () => {
  app.init();
});
