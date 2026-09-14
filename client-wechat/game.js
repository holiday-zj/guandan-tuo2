// 掼蛋小游戏主入口：登录 → 大厅 → 房间等待 → 对战
// 特性：理牌排序、出牌提示、选牌动画、回合倒计时、断线重连、托管提示
import { net } from './js/net.js';
import { drawCard } from './js/card.js';

// 牌点序（与 engine/cards.js 的 RANK_ORDER 保持一致）
const RANK_ORDER = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, 'T': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14 };

const canvas = wx.createCanvas();
const ctx = canvas.getContext('2d');
const W = canvas.width, H = canvas.height;
const info = wx.getSystemInfoSync();

// —— 全局状态 ——
const ui = {
  scene: 'login',      // login / lobby / room / game / result
  mySeat: null,
  snapshot: null,
  roomId: null,
  roomState: null,
  selected: new Set(),
  buttons: [],
  cardRects: [],
  toast: null,
  turnDeadline: null,   // 回合倒计时
  hintOptions: [],      // 提示候选
  hintIndex: 0,
  lastPlay: null,       // {cards, seat, label} 最近一次出牌动画
  anim: null,           // 出牌飞入动画
  autoPlayed: false,
};

const TURN_LIMIT_MS = 30000;

// —— 理牌：按牌力排序（级牌靠前大位置，从小到大）——
function sortHand(hand, level) {
  const val = c => c.rank === 'BJ' ? 17 : c.rank === 'SJ' ? 16 : c.rank === level ? 15 : RANK_ORDER[c.rank];
  return hand.slice().sort((a, b) => {
    if (val(a) !== val(b)) return val(a) - val(b);
    return a.suit.localeCompare(b.suit);
  });
}

function toast(text, ms = 2000) {
  ui.toast = { text, until: Date.now() + ms };
}

// —— 渲染主循环 ——
let lastRender = 0;
function loop(t) {
  if (t - lastRender > 33) { render(); lastRender = t; }
  canvas.requestAnimationFrame(loop);
}

function render() {
  ctx.clearRect(0, 0, W, H);
  ui.buttons = [];
  switch (ui.scene) {
    case 'login': renderLogin(); break;
    case 'lobby': renderLobby(); break;
    case 'room': renderRoom(); break;
    case 'game': renderGame(); break;
    case 'shop': renderShop(); break;
  }
  // toast
  if (ui.toast && Date.now() < ui.toast.until) {
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    roundRect(W / 2 - 260, 70, 520, 64, 12); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = '28px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(ui.toast.text, W / 2, 112);
  }
}

function button(label, x, y, w, h, action, color = '#2e7d32') {
  ctx.fillStyle = color;
  roundRect(x, y, w, h, 12); ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 30px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(label, x + w / 2, y + h / 2 + 11);
  ui.buttons.push({ x, y, w, h, action });
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// —— 场景：登录 ——
function renderLogin() {
  ctx.fillStyle = '#14432a';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#ffd54f';
  ctx.font = 'bold 72px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('掼蛋 · 拖2', W / 2, H * 0.28);
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = '26px sans-serif';
  ctx.fillText('安徽玩法 · 亮牌定队 · 拖2结算', W / 2, H * 0.28 + 50);
  button('微信一键登录', W / 2 - 190, H * 0.50, 380, 92, () => doWxLogin(), '#07c160');
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.font = '22px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('首次进入自动创建账号 · 无需密码', W / 2, H * 0.50 + 125);
  ctx.fillText('健康游戏忠告：抵制不良游戏，拒绝盗版游戏。注意自我保护，谨防受骗上当。', W / 2, H - 70);
  ctx.fillText('适度游戏益脑，沉迷游戏伤身，合理安排时间，享受健康生活。', W / 2, H - 40);
}

// 微信一键登录（wx.login → 服务端 code2session）；开发工具无微信环境时降级游客登录
async function doWxLogin() {
  try {
    await net.wxLogin();
  } catch (e) {
    // 开发环境兜底：游客账号
    try {
      const name = wx.getStorageSync('gd_name') || '玩家' + Math.floor(Math.random() * 100000);
      try { await net.login(name, 'guest'); }
      catch (e2) { await net.register(name, 'guest'); }
      wx.setStorageSync('gd_name', name);
    } catch (e3) {
      toast('登录失败: ' + (e3.message || e3.errMsg));
      return;
    }
  }
  try {
    await net.connect();
    ui.scene = 'lobby';
  } catch (e) {
    toast('连接失败: ' + (e.message || e.errMsg));
  }
}

// —— 场景：大厅 ——
function renderLobby() {
  ctx.fillStyle = '#14432a';
  ctx.fillRect(0, 0, W, H);
  const p = net.profile;
  ctx.fillStyle = '#fff';
  ctx.font = '30px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`${p ? p.name : ''}`, 40, 56);
  ctx.fillStyle = '#ffd54f';
  ctx.textAlign = 'right';
  ctx.fillText(`游戏币 ${p ? p.coins : 0}`, W - 40, 56);

  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  roundRect(W / 2 - 480, H * 0.25, 960, H * 0.55, 20); ctx.fill();

  button('创建房间', W / 2 - 420, H * 0.42, 260, 100, () => {
    net.send({ type: 'create_room', stake: 1, botFill: false });
    net.wait('room_created').then(d => {
      ui.roomId = d.roomId;
      ui.scene = 'room';
    }).catch(() => toast('建房失败'));
  }, '#1565c0');
  button('快速匹配', W / 2 - 130, H * 0.42, 260, 100, () => {
    net.send({ type: 'quick_match' });
    toast('已进入匹配队列…');
  }, '#2e7d32');
  button('人机练习', W / 2 + 160, H * 0.42, 260, 100, () => {
    net.send({ type: 'create_room', stake: 1, botFill: true });
    net.wait('room_created').then(d => {
      ui.roomId = d.roomId;
      ui.scene = 'room';
      net.send({ type: 'start_game' });
    }).catch(() => toast('建房失败'));
  }, '#6a4c93');
  button('💰 商城充值', W / 2 - 420, H * 0.58, 260, 90, () => openShop(), '#f57f17');

  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = '24px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('战绩：' + (p ? `${p.stats.wins}胜 / ${p.stats.matches}场` : '-'), W / 2, H * 0.72);
}

// —— 场景：商城 ——
async function openShop() {
  try {
    ui.shop = await net.payPackages();
    ui.scene = 'shop';
  } catch (e) {
    toast('商城加载失败: ' + e.message);
  }
}

function renderShop() {
  ctx.fillStyle = '#14432a';
  ctx.fillRect(0, 0, W, H);
  const p = net.profile || {};
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 40px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('游戏币商城', W / 2, 70);
  ctx.fillStyle = '#ffd54f';
  ctx.font = '28px sans-serif';
  ctx.fillText('当前余额：' + (p.coins || 0) + ' 币', W / 2, 115);

  const shop = ui.shop || {};
  // 每日免费领取（合规兜底，始终可用）
  button(shop.dailyClaimed ? '今日已领取' : `🎁 每日免费领 ${shop.dailyFree || 500} 币`,
    W / 2 - 260, 145, 520, 76, async () => {
      if (shop.dailyClaimed) return;
      try {
        const r = await net.claimDaily();
        toast(`领取成功 +${r.coins} 币`);
        ui.shop = await net.payPackages();
      } catch (e) { toast(e.message); }
    }, shop.dailyClaimed ? '#616161' : '#2e7d32');

  // 充值开关状态说明（合规提示）
  if (!shop.payEnabled) {
    ctx.fillStyle = 'rgba(255,224,130,0.85)';
    ctx.font = '22px sans-serif';
    ctx.fillText('充值暂未开放（合规要求：游戏版号+虚拟支付资质审批中）', W / 2, 260);
    ctx.fillText('每日免费金币可正常游戏，敬请期待充值开放', W / 2, 290);
  }

  // 档位卡片
  const pkgs = shop.packages || [];
  const cw = 280, chh = 150;
  pkgs.slice(0, 6).forEach((pkg, i) => {
    const col = i % 3, row = Math.floor(i / 3);
    const x = W / 2 - 3 * (cw + 24) / 2 + col * (cw + 24) + 12;
    const y = 320 + row * (chh + 24);
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    roundRect(x, y, cw, chh, 16); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    roundRect(x, y, cw, chh, 16); ctx.stroke();
    ctx.fillStyle = '#ffd54f';
    ctx.font = 'bold 30px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(pkg.coins + ' 币', x + cw / 2, y + 50);
    ctx.fillStyle = '#fff';
    ctx.font = '26px sans-serif';
    ctx.fillText('¥' + (pkg.amountFen / 100), x + cw / 2, y + 90);
    button('购买', x + cw / 2 - 60, y + chh - 52, 120, 42, () => buyPackage(pkg.id),
      shop.payEnabled ? '#f57f17' : '#757575');
  });

  button('← 返回大厅', W / 2 - 140, H - 90, 280, 70, () => { ui.scene = 'lobby'; net.refreshProfile(); }, '#37474f');
}

async function buyPackage(packageId) {
  const shop = ui.shop || {};
  if (!shop.payEnabled) {
    toast('充值暂未开放，请领取每日免费金币');
    return;
  }
  if (!shop.isVerified) {
    // 未实名：引导实名认证（生产环境应弹微信实名组件）
    toast('充值前需完成实名认证');
    return;
  }
  const r = await net.createRecharge(packageId);
  if (r.ok && r.paid) {
    toast('充值成功！');
    ui.shop = await net.payPackages();
  } else {
    toast(r.error || '支付未完成');
  }
}

// —— 场景：房间等待 ——
function renderRoom() {
  ctx.fillStyle = '#14432a';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 40px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`房间 ${ui.roomId}`, W / 2, 90);

  const rs = ui.roomState;
  const seats = rs ? rs.seats : ['-', '-', '-', '-'];
  const seatPos = [
    { x: W / 2, y: H * 0.62, label: '你（房主）' },
    { x: W * 0.75, y: H * 0.4, label: '' },
    { x: W / 2, y: H * 0.22, label: '' },
    { x: W * 0.25, y: H * 0.4, label: '' },
  ];
  for (let i = 0; i < 4; i++) {
    const { x, y } = seatPos[i];
    const occupied = seats[i] && seats[i] !== '（空位）';
    ctx.fillStyle = occupied ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.25)';
    ctx.beginPath(); ctx.arc(x, y, 46, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = '24px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(occupied ? seats[i] : '等待…', x, y + 80);
  }
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = '24px sans-serif';
  ctx.fillText(`底注：每级 ${rs ? rs.stake : 1} 币`, W / 2, H * 0.8);
  button('开始游戏', W / 2 - 140, H * 0.86, 280, 80, () => {
    net.send({ type: 'start_game' });
  }, '#2e7d32');
}

// —— 场景：对战 ——
function renderGame() {
  // 牌桌
  ctx.fillStyle = '#0d5c33';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#0a4a29';
  roundRect(120, 100, W - 240, H - 320, 40); ctx.fill();

  const snap = ui.snapshot;
  if (!snap) return;

  // 顶部信息栏
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(0, 0, W, 52);
  ctx.fillStyle = '#fff';
  ctx.font = '26px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`第${snap.roundNum}副  打${snap.level}  拖${snap.tug}  亮${snap.flip || ''}`, 24, 36);
  ctx.textAlign = 'right';
  ctx.fillText(`我方${snap.levels[ui.teamIdx] ?? 2}  对方${snap.levels[1 - ui.teamIdx] ?? 2}`, W - 24, 36);

  // 三家对手
  const rel = [1, 2, 3].map(r => (ui.mySeat + r) % 4);
  const pos = [
    { x: W - 130, y: H * 0.38, dy: 0 },
    { x: W / 2, y: 86, dy: 0 },
    { x: 130, y: H * 0.38, dy: 0 },
  ];
  rel.forEach((s, i) => {
    const { x, y } = pos[i];
    const isPartner = snap.teamOf[s] === snap.teamOf[ui.mySeat];
    const finished = snap.finishOrder.includes(s);
    drawCard(ctx, {}, x - 34, y, 68, 94, { faceDown: true });
    ctx.fillStyle = finished ? '#81c784' : (isPartner ? '#ffcf3f' : '#fff');
    ctx.font = '23px sans-serif';
    ctx.textAlign = 'center';
    const name = snap.names[s] + (isPartner ? '(队友)' : '');
    ctx.fillText(finished ? `${name} ✓` : `${name} ${snap.handCounts[s]}张`, x, y + 122);
    if (snap.turn === s && !finished) {
      ctx.fillStyle = '#ffcf3f';
      ctx.fillText('▶ 思考中', x, y + 150);
    }
  });

  // 桌中央：桌面当前最大牌 + 最近动作
  if (snap.best) {
    const labels = snap.best.cards.map(cardLabel).join(' ');
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    roundRect(W / 2 - 260, H * 0.36, 520, 58, 12); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = '30px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${snap.names[snap.best.by]}：${labels}`, W / 2, H * 0.36 + 39);
  }

  // 轮到自己的倒计时条
  if (snap.turn === ui.mySeat && ui.turnDeadline) {
    const remain = Math.max(0, ui.turnDeadline - Date.now());
    const pct = remain / TURN_LIMIT_MS;
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    roundRect(W / 2 - 200, H * 0.52, 400, 18, 9); ctx.fill();
    ctx.fillStyle = pct > 0.3 ? '#66bb6a' : '#ef5350';
    roundRect(W / 2 - 200, H * 0.52, 400 * pct, 18, 9); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = '22px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(Math.ceil(remain / 1000) + '秒', W / 2, H * 0.52 + 50);
  }

  // —— 自己的手牌（理牌后）——
  const hand = sortHand(snap.hand, snap.level);
  const n = hand.length;
  const cw = 88, ch = 124;
  const gap = n > 1 ? Math.min(42, (W - 120 - cw) / (n - 1)) : 0;
  const startX = (W - (cw + gap * (n - 1))) / 2;
  const baseY = H - ch - 24;
  ui.cardRects = [];
  hand.forEach((c, i) => {
    const x = startX + i * gap;
    const sel = ui.selected.has(c.id);
    const wild = c.suit === '♥' && c.rank === snap.level;
    const inHint = ui.hintOptions.length && ui.hintOptions[ui.hintIndex] &&
      ui.hintOptions[ui.hintIndex].some(hc => hc.id === c.id);
    drawCard(ctx, c, x, baseY, cw, ch, { selected: sel, highlight: !!inHint, wild });
    ui.cardRects.push({ x, y: baseY - (sel ? 20 : 0), w: cw, h: ch, id: c.id });
  });

  // 操作按钮
  const myTurn = snap.turn === ui.mySeat && !snap.finishOrder.includes(ui.mySeat);
  if (myTurn) {
    button('提示', W * 0.2 - 90, H * 0.60, 180, 74, () => doHint(), '#455a64');
    button('出牌', W * 0.5 - 90, H * 0.60, 180, 74, () => doPlay());
    if (snap.best) button('过', W * 0.8 - 90, H * 0.60, 180, 74, () => {
      net.send({ type: 'pass' });
      ui.selected.clear(); ui.hintOptions = [];
    }, '#757575');
  } else if (snap.finishOrder.includes(ui.mySeat)) {
    const rank = snap.finishOrder.indexOf(ui.mySeat) + 1;
    ctx.fillStyle = '#ffd54f';
    ctx.font = 'bold 34px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(['头游!', '二游!', '三游', '末游'][rank - 1], W / 2, H * 0.62);
  }
}

function cardLabel(c) {
  if (c.suit === 'X') return c.rank === 'BJ' ? '大王' : '小王';
  const R = { T: '10' };
  return c.suit + (R[c.rank] || c.rank);
}

async function doHint() {
  if (!ui.snapshot) return;
  net.send({ type: 'hint' });
  try {
    const d = await net.wait('hint', () => true, 3000);
    if (!d.options.length) { toast('没有能压的牌，建议过'); return; }
    ui.hintOptions = d.options;
    ui.hintIndex = (ui.hintIndex + 1) % ui.hintOptions.length;
    ui.selected = new Set(ui.hintOptions[ui.hintIndex].map(c => c.id));
  } catch (e) {
    toast('暂时无提示');
  }
}

function doPlay() {
  const cards = [...ui.selected].map(id => ({ id }));
  if (!cards.length) { toast('请先选牌或点提示'); return; }
  net.send({ type: 'play', cards });
}

// —— 触摸 ——
wx.onTouchEnd(e => {
  const t = e.changedTouches[0];
  const x = t.clientX, y = t.clientY;
  for (const b of ui.buttons) {
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) { b.action(); return; }
  }
  if (ui.scene === 'game') {
    // 从后往前找（上层牌优先）
    for (let i = ui.cardRects.length - 1; i >= 0; i--) {
      const r = ui.cardRects[i];
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
        if (ui.selected.has(r.id)) ui.selected.delete(r.id);
        else ui.selected.add(r.id);
        ui.hintOptions = [];
        wx.vibrateShort && wx.vibrateShort({ type: 'light' });
        return;
      }
    }
  }
});

// —— 网络事件 ——
net.on('welcome', d => { net.profile = d.profile; });
net.on('room_joined', d => { ui.roomId = d.roomId; });
net.on('room_state', d => {
  ui.roomState = d;
  if (ui.scene === 'lobby' && d.state === 'waiting' && !ui.roomId) ui.scene = 'room';
});
net.on('queued', d => toast(`排队中，第${d.position}位（共${d.waiting}人）`));
net.on('game_start', d => {
  ui.mySeat = d.seat;
  ui.snapshot = d.snapshot;
  ui.teamIdx = d.snapshot.teamOf[d.seat];
  ui.scene = 'game';
  ui.selected.clear();
  ui.hintOptions = [];
  setTurnTimer(d.snapshot);
  if (!d.reconnect) toast(`对局开始！亮${d.snapshot.flip} 打${d.snapshot.level}`, 3000);
});
net.on('snapshot', d => {
  ui.snapshot = d.snapshot;
  setTurnTimer(d.snapshot);
});
net.on('events', d => {
  for (const ev of d.events) {
    if (ev.type === 'play') {
      ui.lastPlay = { cards: ev.cards, seat: ev.seat };
    }
    if (ev.type === 'finish') {
      const names = ui.snapshot ? ui.snapshot.names : [];
      toast(`${names[ev.seat] || '玩家'}第${ev.rank}个出完`, 1500);
    }
    if (ev.type === 'auto_play') toast('超时，系统已代出', 1500);
    if (ev.type === 'round_result') {
      const r = ev.result;
      const win = r.winners.includes(ui.mySeat);
      toast(`本副结束：${r.base}基础+${r.tugBonus}拖+${r.leftover}剩=${r.total}级 ${win ? '+' : '-'}${r.total * (ui.roomState ? ui.roomState.stake : 1)}币`, 4000);
      ui.selected.clear();
      ui.hintOptions = [];
    }
    if (ev.type === 'match_over') {
      const win = ui.teamIdx === ev.winnerTeam;
      toast(win ? '🎉 你们赢了整场！' : '整场结束，对方获胜', 5000);
      setTimeout(() => {
        ui.scene = 'lobby';
        ui.snapshot = null;
        ui.roomId = null;
        refreshProfile();
      }, 4500);
    }
  }
});
net.on('hint', () => {}); // 由 wait() 处理
net.on('error', d => toast(d.error));
net.on('__disconnect', () => {
  toast('连接断开，正在重连…', 3000);
  setTimeout(tryReconnect, 1500);
});

function setTurnTimer(snap) {
  if (snap && snap.turn === ui.mySeat) {
    if (!ui.turnDeadline) ui.turnDeadline = Date.now() + TURN_LIMIT_MS;
  } else {
    ui.turnDeadline = null;
  }
}

async function refreshProfile() {
  try {
    const name = wx.getStorageSync('gd_name');
    const r = await net.request('/api/login', { name, password: 'guest' });
    if (r.ok) { net.profile = r.profile; net.token = r.token; wx.setStorageSync('gd_token', r.token); }
  } catch (e) { /* 忽略 */ }
}

let reconnecting = false;
async function tryReconnect() {
  if (reconnecting) return;
  reconnecting = true;
  for (let i = 0; i < 5; i++) {
    try {
      await net.connect();
      reconnecting = false;
      return; // welcome/重连快照由事件处理
    } catch (e) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  reconnecting = false;
  toast('重连失败，请重启游戏');
}

// —— 启动：尝试用缓存 token 自动登录 ——
(async () => {
  render();
  canvas.requestAnimationFrame(loop);
  const token = wx.getStorageSync('gd_token');
  const name = wx.getStorageSync('gd_name');
  if (token && name) {
    try {
      net.token = token;
      const r = await net.request('/api/login', { name, password: 'guest' });
      if (r.ok) {
        net.profile = r.profile;
        net.token = r.token;
        wx.setStorageSync('gd_token', r.token);
        await net.connect();
        ui.scene = 'lobby';
        return;
      }
    } catch (e) { /* 落到登录页 */ }
  }
})();
