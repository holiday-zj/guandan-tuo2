// 掼蛋小游戏入口：登录 → 大厅 → 房间/对战
import { net } from './js/net.js';
import { drawCard } from './js/card.js';

const canvas = wx.createCanvas();
const ctx = canvas.getContext('2d');
const W = canvas.width, H = canvas.height;

// —— 状态机 ——
const ui = {
  scene: 'login',   // login → lobby → game
  mySeat: null,
  snapshot: null,
  selected: new Set(), // 选中的牌 id
  buttons: [],        // {x,y,w,h,label,action}
  toast: null,
};

function setToast(text, ms = 2000) {
  ui.toast = { text, until: Date.now() + ms };
}

// —— 渲染 ——
function render() {
  ctx.clearRect(0, 0, W, H);
  ui.buttons = [];
  if (ui.scene === 'login') renderLogin();
  else if (ui.scene === 'lobby') renderLobby();
  else if (ui.scene === 'game') renderGame();
  if (ui.toast && Date.now() < ui.toast.until) {
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(W / 2 - 200, H / 2 - 30, 400, 60);
    ctx.fillStyle = '#fff';
    ctx.font = '26px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(ui.toast.text, W / 2, H / 2 + 9);
  }
}

function button(label, x, y, w, h, action) {
  ctx.fillStyle = '#2e7d32';
  roundRect(x, y, w, h, 10); ctx.fill();
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

function renderLogin() {
  ctx.fillStyle = '#1b3a24';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 64px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('掼蛋 · 拖2', W / 2, H * 0.3);
  button('一键登录 / 注册', W / 2 - 180, H * 0.5, 360, 90, () => {
    const name = '玩家' + Math.floor(Math.random() * 100000);
    net.register(name, 'guest').then(() => {
      net.connect().then(() => { ui.scene = 'lobby'; });
    }).catch(e => setToast('登录失败: ' + e.message));
  });
}

function renderLobby() {
  ctx.fillStyle = '#1b3a24';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#fff';
  ctx.font = '32px sans-serif';
  ctx.textAlign = 'left';
  const p = net.profile;
  ctx.fillText(`${p ? p.name : ''}   游戏币 ${p ? p.coins : 0}`, 40, 60);
  button('创建房间', W * 0.2 - 160, H * 0.5, 320, 90, () => {
    net.send({ type: 'create_room', stake: 1, botFill: false });
  });
  button('快速匹配', W * 0.5 - 160, H * 0.5, 320, 90, () => {
    net.send({ type: 'quick_match' });
    setToast('正在排队…');
  });
  button('机器人凑桌', W * 0.8 - 160, H * 0.5, 320, 90, () => {
    net.send({ type: 'create_room', stake: 1, botFill: true });
    setTimeout(() => net.send({ type: 'start_game' }), 300);
  });
}

function renderGame() {
  ctx.fillStyle = '#0f5c2e';
  ctx.fillRect(0, 0, W, H);
  const snap = ui.snapshot;
  if (!snap) return;

  // 顶部信息
  ctx.fillStyle = '#fff';
  ctx.font = '28px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`第${snap.roundNum}副  级牌:${snap.level}  拖:${snap.tug}`, 30, 46);
  ctx.textAlign = 'right';
  ctx.fillText(`双方进度 ${snap.levels[0] ?? '-'} : ${snap.levels[1] ?? '-'}`, W - 30, 46);

  // 其他三家（背面 + 张数）
  const others = [1, 2, 3].map(rel => (ui.mySeat + rel) % 4);
  const pos = [
    { x: W - 150, y: H * 0.35 },   // 下家（右）
    { x: W / 2, y: 90 },           // 对家（上）
    { x: 90, y: H * 0.35 },        // 上家（左）
  ];
  others.forEach((s, i) => {
    const { x, y } = pos[i];
    drawCard(ctx, {}, x - 40, y, 80, 110, { faceDown: true });
    ctx.fillStyle = '#fff';
    ctx.font = '24px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${snap.names[s]}(${snap.handCounts[s]})`, x, y + 135);
    if (snap.turn === s) { ctx.fillStyle = '#ffcf3f'; ctx.fillText('▶ 出牌中', x, y + 162); }
  });

  // 桌面：当前最大牌
  if (snap.best) {
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.font = '30px sans-serif';
    ctx.textAlign = 'center';
    const labels = snap.best.cards.map(c => label(c)).join(' ');
    ctx.fillText(`桌面: ${labels}  (${snap.names[snap.best.by]})`, W / 2, H * 0.45);
  }

  // 自己的手牌（底部，可重叠展开）
  const hand = snap.hand;
  const cw = 96, ch = 136;
  const gap = hand.length > 1 ? Math.min(46, (W - 160 - cw) / (hand.length - 1)) : 0;
  const startX = (W - (cw + gap * (hand.length - 1))) / 2;
  const baseY = H - ch - 20;
  ui.cardRects = [];
  hand.forEach((c, i) => {
    const x = startX + i * gap;
    const sel = ui.selected.has(c.id);
    drawCard(ctx, c, x, baseY, cw, ch, { selected: sel, wild: c.suit === '♥' && c.rank === snap.level });
    ui.cardRects.push({ x, y: baseY - (sel ? 18 : 0), w: cw, h: ch, id: c.id });
  });

  // 出牌 / 过牌按钮
  const myTurn = snap.turn === ui.mySeat;
  if (myTurn) {
    button('出牌', W / 2 - 220, H * 0.62, 200, 76, () => {
      const cards = [...ui.selected].map(id => ({ id }));
      if (!cards.length) return setToast('请先选牌');
      net.send({ type: 'play', cards });
      ui.selected.clear();
    });
    if (snap.best) button('过', W / 2 + 20, H * 0.62, 200, 76, () => {
      net.send({ type: 'pass' });
      ui.selected.clear();
    });
  }
}

function label(c) {
  if (c.suit === 'X') return c.rank === 'BJ' ? '大王' : '小王';
  const R = { T: '10' };
  return c.suit + (R[c.rank] || c.rank);
}

// —— 触摸 ——
wx.onTouchEnd(e => {
  const t = e.changedTouches[0];
  const x = t.clientX, y = t.clientY;
  // 按钮
  for (const b of ui.buttons) {
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) { b.action(); render(); return; }
  }
  // 手牌选择
  if (ui.scene === 'game' && ui.cardRects) {
    for (let i = ui.cardRects.length - 1; i >= 0; i--) {
      const r = ui.cardRects[i];
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
        if (ui.selected.has(r.id)) ui.selected.delete(r.id);
        else ui.selected.add(r.id);
        render();
        return;
      }
    }
  }
});

// —— 网络事件绑定 ——
net.on('room_created', () => setToast('房间已创建，等待玩家…'));
net.on('room_joined', d => setToast('已加入房间，座位' + d.seat));
net.on('queued', d => setToast(`排队中，第${d.position}位`));
net.on('game_start', d => {
  ui.mySeat = d.seat;
  ui.snapshot = d.snapshot;
  ui.scene = 'game';
  setToast('对局开始！你是座位' + d.seat);
  render();
});
net.on('snapshot', d => { ui.snapshot = d.snapshot; render(); });
net.on('events', d => {
  for (const ev of d.events) {
    if (ev.type === 'round_result') {
      const r = ev.result;
      setToast(`本副结束：${r.base}+${r.tugBonus}+${r.leftover}=${r.total}级`, 3500);
    }
    if (ev.type === 'match_over') {
      setToast(`比赛结束！胜方：队伍${ev.winnerTeam}`, 5000);
      setTimeout(() => { ui.scene = 'lobby'; ui.snapshot = null; render(); }, 4000);
    }
  }
});
net.on('error', d => setToast('错误: ' + d.error));
net.on('room_state', d => { if (ui.scene === 'lobby') setToast(`房间 ${d.seats.join('/')} [${d.state}]`); });

// —— 启动 ——
render();
