// 网络层：REST 登录 + WebSocket 对战
const BASE = 'http://127.0.0.1:8080'; // TODO: 上线改为备案域名 + HTTPS/WSS
const WS = 'ws://127.0.0.1:8080';

export const net = {
  token: null,
  profile: null,
  ws: null,
  handlers: {},

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

  on(type, fn) {
    (this.handlers[type] = this.handlers[type] || []).push(fn);
  },

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = wx.connectSocket({ url: `${WS}/?token=${this.token}` });
      this.ws.onOpen(() => resolve());
      this.ws.onError(reject);
      this.ws.onMessage(msg => {
        try {
          const data = JSON.parse(msg.data);
          (this.handlers[data.type] || []).forEach(fn => fn(data));
        } catch (e) { /* 忽略 */ }
      });
    });
  },

  send(obj) {
    if (this.ws) this.ws.send({ data: JSON.stringify(obj) });
  },
};
