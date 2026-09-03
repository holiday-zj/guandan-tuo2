// 网络层：REST 登录 + WebSocket 对战（含心跳与等待助手）
const BASE = 'http://127.0.0.1:8080'; // TODO: 上线改为备案域名 + HTTPS
const WS = 'ws://127.0.0.1:8080';      // TODO: 上线改为 WSS

export const net = {
  token: null,
  profile: null,
  ws: null,
  handlers: {},
  waiters: [],
  connected: false,

  async request(path, data) {
    return new Promise((resolve, reject) => {
      wx.request({
        url: BASE + path,
        method: data ? 'POST' : 'GET',
        data: data || {},
        success: res => resolve(res.data),
        fail: reject,
      });
    });
  },

  async register(name, password) {
    const r = await this.request('/api/register', { name, password });
    if (!r.ok) throw new Error(r.error);
    this.token = r.token;
    this.profile = r.profile;
    wx.setStorageSync('gd_token', r.token);
    wx.setStorageSync('gd_name', name);
    return r.profile;
  },

  async login(name, password) {
    const r = await this.request('/api/login', { name, password });
    if (!r.ok) throw new Error(r.error);
    this.token = r.token;
    this.profile = r.profile;
    wx.setStorageSync('gd_token', r.token);
    wx.setStorageSync('gd_name', name);
    return r.profile;
  },

  // 刷新个人资料（余额等）
  async refreshProfile() {
    const name = wx.getStorageSync('gd_name');
    if (!name) return;
    // 用 token 无法直接查资料，重登一次拿最新
  },

  on(type, fn) {
    (this.handlers[type] = this.handlers[type] || []).push(fn);
  },

  // 等待某个服务端消息（超时抛错）
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
    (this.handlers[data.type] || []).forEach(fn => fn(data));
  },

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = wx.connectSocket({ url: `${WS}/?token=${this.token}` });
      this.ws.onOpen(() => {
        this.connected = true;
        resolve();
        this.startHeartbeat();
      });
      this.ws.onError(e => { this.connected = false; reject(e); });
      this.ws.onClose(() => {
        this.connected = false;
        this.stopHeartbeat();
        (this.handlers.__disconnect || []).forEach(fn => fn());
      });
      this.ws.onMessage(msg => {
        try { this.dispatch(JSON.parse(msg.data)); } catch (e) { /* 忽略 */ }
      });
    });
  },

  startHeartbeat() {
    this.stopHeartbeat();
    this._hb = setInterval(() => {
      if (this.connected) this.send({ type: 'ping' });
    }, 20000);
  },
  stopHeartbeat() { if (this._hb) { clearInterval(this._hb); this._hb = null; } },

  send(obj) {
    if (this.ws && this.connected) this.ws.send({ data: JSON.stringify(obj) });
  },
};
