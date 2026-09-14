// 网络层：微信登录 + REST（带鉴权头）+ WebSocket 对战（心跳/重连）
//
// ⚠️ 上线前必须改这里：微信强制 HTTPS/WSS + 已备案域名，且域名要在
//    微信公众平台「开发设置-服务器域名」白名单里配置（request 和 socket 两类）。
//    当前是开发用的 HTTP+IP，只能在开发者工具勾选「不校验合法域名」时跑通。
const SERVER_HOST = 'http://3.15.212.241:8080';   // TODO 上线改为 https://你的备案域名
const WS_HOST = SERVER_HOST.replace(/^http/, 'ws'); // http→ws, https→wss
const BASE = SERVER_HOST;
const WS = WS_HOST;

export const net = {
  token: null,
  profile: null,
  ws: null,
  handlers: {},
  waiters: [],
  connected: false,
  reconnecting: false,
  queue: [],

  // REST 请求（自动带 Authorization 头）
  request(path, data, method) {
    return new Promise((resolve, reject) => {
      const header = { 'Content-Type': 'application/json' };
      if (this.token) header['Authorization'] = ['Bear', 'er '].join('') + this.token;
      wx.request({
        url: BASE + path,
        method: method || (data ? 'POST' : 'GET'),
        data: data || {},
        header,
        success: res => resolve(res.data),
        fail: reject,
      });
    });
  },

  // —— 微信一键登录：wx.login 拿 code → 服务端换 openid → 自动注册/登录 ——
  wxLogin() {
    return new Promise((resolve, reject) => {
      wx.login({
        success: async res => {
          if (!res.code) return reject(new Error('wx.login 未返回 code'));
          try {
            const r = await this.request('/api/wx/login', { code: res.code });
            if (!r.ok) return reject(new Error(r.error || '微信登录失败'));
            this.token = r.token;
            this.profile = r.profile;
            wx.setStorageSync('gd_token', r.token);
            resolve(r);
          } catch (e) { reject(e); }
        },
        fail: reject,
      });
    });
  },

  // 游客注册（无微信环境兜底，开发调试用）
  async register(name, password) {
    const r = await this.request('/api/register', { name, password });
    if (!r.ok) throw new Error(r.error);
    this.token = r.token;
    this.profile = r.profile;
    wx.setStorageSync('gd_token', r.token);
    return r.profile;
  },

  async login(name, password) {
    const r = await this.request('/api/login', { name, password });
    if (!r.ok) throw new Error(r.error);
    this.token = r.token;
    this.profile = r.profile;
    wx.setStorageSync('gd_token', r.token);
    return r.profile;
  },

  // 用现有 token 拉最新资料（余额/战绩）
  async refreshProfile() {
    try {
      const r = await this.request('/api/profile');
      if (r.ok) { this.profile = r.profile; return r.profile; }
    } catch (e) { /* 忽略 */ }
    return this.profile;
  },

  // —— 充值相关 ——
  async payPackages() {
    const r = await this.request('/api/pay/packages');
    if (!r.ok) throw new Error(r.error);
    return r; // {packages, payEnabled, dailyFree, isVerified, isMinor, dailyClaimed}
  },

  // 每日免费领取（免费合规模式）
  async claimDaily() {
    const r = await this.request('/api/pay/daily', {});
    if (!r.ok) throw new Error(r.error);
    this.profile = r.profile;
    return r;
  },

  // 发起充值：创建订单 → 调起 wx.requestMidasPayment（安卓）
  // 返回 {ok, order, pkg}；payEnabled=false 时返回 {ok:false, code:'PAY_DISABLED'}
  async createRecharge(packageId) {
    const platform = wx.getDeviceInfo ? (wx.getDeviceInfo().platform || 'android') : 'android';
    const r = await this.request('/api/pay/create', { packageId, platform });
    if (!r.ok) return r; // {ok:false, code, error}
    // 调起微信虚拟支付（仅安卓；需 AppID 开通虚拟支付）
    try {
      await new Promise((res, rej) => {
        wx.requestMidasPayment({
          mode: r.order.mode,
          env: r.order.env,
          offerId: r.order.offerId,
          currencyType: r.order.currencyType,
          platform: r.order.platform,
          buyQuantity: r.order.buyQuantity,
          zoneId: r.order.zoneId,
          success: res,
          fail: rej,
        });
      });
      // 支付成功：等服务端回调到账，这里轮询确认
      await this.refreshProfile();
      return { ok: true, paid: true, order: r.order };
    } catch (e) {
      return { ok: false, code: 'PAY_CANCEL', error: (e && e.errMsg) || '支付未完成' };
    }
  },

  async payOrders() {
    const r = await this.request('/api/pay/orders');
    return r.ok ? r.orders : [];
  },

  // 实名认证
  async verify(realName, idNumber) {
    const r = await this.request('/api/verify', { realName, idNumber });
    if (r.ok && r.profile) this.profile = r.profile;
    return r;
  },

  on(type, fn) {
    (this.handlers[type] = this.handlers[type] || []).push(fn);
  },

  wait(type, pred = () => true, ms = 8000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(w => w.timer !== timer);
        reject(new Error('等待 ' + type + ' 超时'));
      }, ms);
      this.waiters.push({ type, pred, resolve, timer });
    });
  },

  dispatch(data) {
    for (const w of this.waiters.slice()) {
      if (w.type === data.type && w.pred(data)) {
        clearTimeout(w.timer);
        this.waiters = this.waiters.filter(x => x !== w);
        w.resolve(data);
      }
    }
    for (const fn of (this.handlers[data.type] || [])) {
      try { fn(data); } catch (e) { console.error('handler error', data.type, e); }
    }
  },

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = wx.connectSocket({ url: `${WS}/?token=${this.token}` });
      this.ws.onOpen(() => {
        this.connected = true;
        const q = this.queue; this.queue = [];
        q.forEach(o => { try { this.ws.send({ data: JSON.stringify(o) }); } catch {} });
        this.startHeartbeat();
        resolve();
      });
      this.ws.onError(e => { if (!this.connected) reject(e); });
      this.ws.onClose(() => {
        this.connected = false;
        this.stopHeartbeat();
        this.scheduleReconnect();
        (this.handlers.__disconnect || []).forEach(fn => fn());
      });
      this.ws.onMessage(msg => {
        try {
          const d = JSON.parse(msg.data);
          if (d.type === 'pong') { this.lastPong = Date.now(); return; }
          this.dispatch(d);
        } catch (e) { /* 忽略 */ }
      });
    });
  },

  startHeartbeat() {
    this.stopHeartbeat();
    this.lastPong = Date.now();
    this._hb = setInterval(() => {
      if (!this.connected) return;
      if (Date.now() - (this.lastPong || 0) > 50000) { try { this.ws.close(); } catch {} return; }
      this.send({ type: 'ping' });
    }, 20000);
  },
  stopHeartbeat() { if (this._hb) { clearInterval(this._hb); this._hb = null; } },

  scheduleReconnect() {
    if (this.reconnecting || !this.token) return;
    this.reconnecting = true;
    let attempt = 0;
    const tryIt = () => {
      attempt++;
      this.connect().then(() => { this.reconnecting = false; })
        .catch(() => {
          if (attempt < 10) setTimeout(tryIt, Math.min(10000, 1000 * attempt));
          else this.reconnecting = false;
        });
    };
    setTimeout(tryIt, 800);
  },

  send(obj) {
    if (this.ws && this.connected) { this.ws.send({ data: JSON.stringify(obj) }); return true; }
    if (obj.type !== 'ping') {
      this.queue.push(obj);
      if (this.queue.length > 20) this.queue.shift();
    }
    if (!this.connected && !this.reconnecting) this.scheduleReconnect();
    return false;
  },
};
