// 掼蛋（拖2）服务端入口：HTTP 注册/登录 + WebSocket 对战
// 特性：SQLite 持久化、出牌提示、断线重连、超时托管
// 启动：node server/index.js  （默认端口 8080）
import http from 'node:http';
import { acceptKey, parseFrames, encodeFrame, OP } from './ws.js';
import { store, loadMember, settleCoins, publicProfile, memberCache } from './db.js';
import { Lobby, GameSession } from './room.js';
import { botDecide } from './bot.js';
import { followOptions, leadOptions } from '../engine/hint.js';
import { bestInterpretation } from '../engine/classify.js';

const PORT = process.env.PORT || 8080;
const TURN_TIMEOUT_MS = 30000; // 30秒不出牌自动托管出牌

const lobby = new Lobby();
const sessions = new Map();   // roomId -> GameSession
const clients = new Map();    // memberId -> {ws, seat, roomId}
const turnTimers = new Map(); // roomId -> timeout handle

// —— HTTP ——
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  // WebSocket 升级
  if (req.headers.upgrade === 'websocket') {
    const token = url.searchParams.get('token');
    const member = store.authByToken(token);
    if (!member) { res.writeHead(401); res.end('unauthorized'); return; }
    const key = req.headers['sec-websocket-key'];
    req.socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + acceptKey(key) + '\r\n\r\n');
    attachWs(req.socket, member);
    return;
  }

  // REST API
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    try {
      const data = body ? JSON.parse(body) : {};
      const out = handleApi(url.pathname, req.method, data);
      res.end(JSON.stringify(out));
    } catch (e) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  });
});

function handleApi(path, method, data) {
  switch (path) {
    case '/api/register': {
      if (!data.name || !data.password) throw new Error('需要 name 与 password');
      const r = store.register(data.name, data.password);
      if (!r.ok) throw new Error(r.error);
      const token = store.issueToken(r.member.id);
      return { ok: true, token, profile: publicProfile(r.member) };
    }
    case '/api/login': {
      const r = store.login(data.name, data.password);
      if (!r.ok) throw new Error(r.error);
      const token = store.issueToken(r.member.id);
      return { ok: true, token, profile: publicProfile(r.member) };
    }
    case '/api/rooms':
      return { ok: true, rooms: lobby.publicList(), queue: lobby.queue.length };
    case '/api/health':
      return { ok: true, time: Date.now() };
    default:
      throw new Error('unknown path: ' + path);
  }
}

// —— WebSocket 会话 ——
function attachWs(socket, member) {
  let buf = Buffer.alloc(0);
  const ws = {
    send(obj) { try { socket.write(encodeFrame(OP.TEXT, JSON.stringify(obj))); } catch {} },
  };
  const existing = clients.get(member.id);
  if (existing && existing.ws) { try { existing.ws.send({ type: 'replaced' }); } catch {} }
  clients.set(member.id, { ws, seat: existing ? existing.seat : null, roomId: existing ? existing.roomId : null });
  ws.send({ type: 'welcome', profile: publicProfile(loadMember(member.id)), name: member.name });

  // 断线重连：若仍在对局中，立即补发当前牌局快照
  const rec = clients.get(member.id);
  if (rec && rec.roomId) {
    const session = sessions.get(rec.roomId);
    const room = lobby.rooms.get(rec.roomId);
    if (session && room && room.state === 'playing') {
      ws.send({ type: 'room_joined', roomId: rec.roomId, seat: rec.seat, reconnect: true });
      ws.send({ type: 'game_start', seat: rec.seat, snapshot: session.snapshotFor(rec.seat), reconnect: true });
      const snap = session.snapshotFor(rec.seat);
      ws.send({ type: 'snapshot', snapshot: snap });
    } else if (room && room.state === 'waiting') {
      ws.send({ type: 'room_joined', roomId: rec.roomId, seat: rec.seat, reconnect: true });
      broadcastRoom(rec.roomId);
    }
  }

  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    const { messages, rest } = parseFrames(buf);
    buf = rest;
    for (const m of messages) {
      if (m.opcode === OP.CLOSE) { socket.end(); return; }
      if (m.opcode === OP.PING) { socket.write(encodeFrame(OP.PONG, m.payload)); continue; }
      if (m.opcode !== OP.TEXT) continue;
      let msg;
      try { msg = JSON.parse(m.payload.toString()); } catch { continue; }
      handleMsg(member, msg);
    }
  });
  socket.on('close', () => {
    // 断线保留座位 5 分钟（超时由托管机制自动出牌）
    const c = clients.get(member.id);
    if (c) c.ws = null;
    lobby.dequeue(member.id);
  });
  socket.on('error', () => {});
}

function handleMsg(member, msg) {
  const c = clients.get(member.id);
  if (!c) return;
  const ws = c.ws;
  if (!ws) return;

  switch (msg.type) {
    case 'ping': {
      ws.send({ type: 'pong' });
      break;
    }
    case 'create_room': {
      const room = lobby.createPrivateRoom(member.id, {
        stake: Math.max(1, Math.min(10, msg.stake || 1)),
        botFill: !!msg.botFill,
      });
      c.roomId = room.id; c.seat = 0;
      ws.send({ type: 'room_created', roomId: room.id, stake: room.stake });
      broadcastRoom(room.id);
      break;
    }
    case 'join_room': {
      const res = lobby.joinRoom(msg.roomId, member.id);
      if (!res.ok) { ws.send({ type: 'error', error: res.error }); break; }
      c.roomId = msg.roomId; c.seat = res.seat;
      ws.send({ type: 'room_joined', roomId: msg.roomId, seat: res.seat });
      broadcastRoom(msg.roomId);
      break;
    }
    case 'quick_match': {
      const q = lobby.enqueue(member.id);
      ws.send({ type: 'queued', position: q.indexOf(member.id) + 1, waiting: q.length });
      const room = lobby.tryFormTable();
      if (room) {
        for (const id of room.seats) {
          const cc = clients.get(id);
          if (cc) { cc.roomId = room.id; cc.seat = room.seats.indexOf(id); }
        }
        broadcastRoom(room.id);
        maybeStart(room.id, true); // 大厅凑桌自动开局
      }
      break;
    }
    case 'start_game': {
      maybeStart(c.roomId, true);
      break;
    }
    case 'hint': {
      const session = sessions.get(c.roomId);
      if (!session) { ws.send({ type: 'error', error: '不在对局中' }); break; }
      const seat = c.seat;
      const r = session.match.round;
      if (r.state !== 'playing' || session.driver.turn !== seat) { ws.send({ type: 'error', error: '未到你的回合' }); break; }
      let opts;
      if (session.driver.best) {
        opts = followOptions(r.hands[seat], r.level, session.driver.best.it, 8);
      } else {
        opts = leadOptions(r.hands[seat], r.level, 8);
      }
      ws.send({ type: 'hint', options: opts.map(o => o.cards.map(card => ({ id: card.id, suit: card.suit, rank: card.rank }))) });
      break;
    }
    case 'play':
    case 'pass': {
      const room = lobby.rooms.get(c.roomId);
      if (!room || room.state !== 'playing') { ws.send({ type: 'error', error: '对局未开始' }); break; }
      const session = sessions.get(c.roomId);
      if (!session) break;
      const seat = c.seat;
      const action = msg.type === 'pass' ? { type: 'pass' } : { type: 'play', cards: msg.cards || [] };
      const res = session.handleAction(seat, action);
      if (!res.ok) { ws.send({ type: 'error', error: res.error }); break; }
      const botEvents = session.driveBots(); // 机器人接力，直到轮到真人
      pushEvents(room.id, [...res.events, ...botEvents]);
      scheduleTurnTimeout(room.id);
      break;
    }
    case 'leave_room': {
      const room = lobby.rooms.get(c.roomId);
      if (room) {
        if (room.state === 'playing') { ws.send({ type: 'error', error: '对局中无法退出' }); break; }
        room.removePlayer(member.id);
        if (room.playerCount() === 0) lobby.rooms.delete(room.id);
        else broadcastRoom(room.id);
      }
      lobby.dequeue(member.id);
      c.roomId = null; c.seat = null;
      ws.send({ type: 'left_room' });
      break;
    }
    default:
      ws.send({ type: 'error', error: 'unknown message type: ' + msg.type });
  }
}

// —— 超时托管：轮到某真人超过时限未出牌，服务端代打 ——
function scheduleTurnTimeout(roomId) {
  clearTimeout(turnTimers.get(roomId));
  const timer = setTimeout(() => autoPlay(roomId), TURN_TIMEOUT_MS);
  turnTimers.set(roomId, timer);
}

function autoPlay(roomId) {
  const session = sessions.get(roomId);
  const room = lobby.rooms.get(roomId);
  if (!session || !room || room.state !== 'playing') return;
  const r = session.match.round;
  if (r.state !== 'playing') return;
  const seat = session.driver.turn;
  const occupant = room.seats[seat];
  if (occupant && String(occupant).startsWith('bot:')) return; // 机器人由 driveBots 处理

  // 代打：能压就出最小的，否则过
  const action = botDecide(session, seat);
  const res = session.handleAction(seat, action);
  if (!res.ok) {
    const pass = session.handleAction(seat, { type: 'pass' });
    if (!pass.ok) return;
    pushEvents(roomId, [{ type: 'auto_play', seat }, ...pass.events]);
  } else {
    pushEvents(roomId, [{ type: 'auto_play', seat }, ...res.events]);
  }
  const botEvents = session.driveBots();
  if (botEvents.length) pushEvents(roomId, botEvents);
  scheduleTurnTimeout(roomId);
}

function maybeStart(roomId, force = false) {
  const room = lobby.rooms.get(roomId);
  if (!room || room.state !== 'waiting') return;

  // 机器人补位：仅在明确点击开始时执行
  if (force && room.botFill) {
    let botId = 0;
    for (let i = 0; i < 4; i++) {
      if (!room.seats[i]) room.seats[i] = 'bot:' + (++botId);
    }
  }
  if (!room.isFull()) {
    if (force) broadcast(roomId, { type: 'error', error: '人不够，无法开局' });
    return;
  }
  if (!force) return; // 满员后等待房主点击开始

  const session = new GameSession(room, id => loadMember(id));
  sessions.set(roomId, session);
  session.start();
  room.state = 'playing';
  const botEvents = session.driveBots(); // 首出者是机器人时自动推进

  // 给每个真人推初始快照
  for (let seat = 0; seat < 4; seat++) {
    const id = room.seats[seat];
    if (id && !String(id).startsWith('bot:')) {
      const cc = clients.get(id);
      if (cc && cc.ws) cc.ws.send({ type: 'game_start', seat, snapshot: session.snapshotFor(seat) });
    }
  }
  if (botEvents.length) pushEvents(roomId, botEvents);
  broadcast(roomId, { type: 'state', roundNum: session.roundNum, level: session.match.round.level });
  scheduleTurnTimeout(roomId);
}

function pushEvents(roomId, events) {
  const session = sessions.get(roomId);
  if (!session) return;
  for (const ev of events) {
    if (ev.type === 'round_result') settleWallet(session, ev.result);
    if (ev.type === 'match_over') finishMatch(session);
  }
  broadcast(roomId, { type: 'events', events });
  // 推送最新快照给每位真人
  const room = lobby.rooms.get(roomId);
  if (room) {
    for (let seat = 0; seat < 4; seat++) {
      const id = room.seats[seat];
      if (id && !String(id).startsWith('bot:')) {
        const cc = clients.get(id);
        if (cc && cc.ws) cc.ws.send({ type: 'snapshot', snapshot: session.snapshotFor(seat) });
      }
    }
  }
}

function settleWallet(session, result) {
  const room = session.room;
  const stake = room.stake || 1;
  const amount = result.total * stake;
  const winnerIds = result.winners.map(s => room.seats[s]).filter(id => id && !String(id).startsWith('bot:'));
  const loserIds = result.losers.map(s => room.seats[s]).filter(id => id && !String(id).startsWith('bot:'));
  settleCoins(winnerIds, loserIds, amount);
  for (const id of [...winnerIds, ...loserIds]) {
    const m = loadMember(id);
    if (m) { m.stats.rounds++; if (winnerIds.includes(id)) m.stats.wins++; store.bumpStats(m.id, m.stats); }
  }
}

function finishMatch(session) {
  clearTimeout(turnTimers.get(session.room.id));
  store.logMatch(session.winnerTeam, session.match.roundNo, {
    levels: session.match.levels,
  });
  for (const id of session.room.seats) {
    if (id && !String(id).startsWith('bot:')) {
      const m = loadMember(id);
      if (m) { m.stats.matches++; store.bumpStats(m.id, m.stats); }
    }
  }
}

function broadcast(roomId, msg) {
  const room = lobby.rooms.get(roomId);
  if (!room) return;
  for (const id of room.seats) {
    if (id && !String(id).startsWith('bot:')) {
      const cc = clients.get(id);
      if (cc && cc.ws) cc.ws.send(msg);
    }
  }
}

function broadcastRoom(roomId) {
  const room = lobby.rooms.get(roomId);
  if (!room) return;
  broadcast(roomId, { type: 'room_state', seats: room.names(), state: room.state, stake: room.stake });
}

server.listen(PORT, () => {
  console.log(`[掼蛋·拖2] 服务端已启动：http://127.0.0.1:${PORT}`);
  console.log('持久化: SQLite (data/guandan.db)');
  console.log('REST: /api/register /api/login /api/rooms /api/health');
  console.log('WS:   ws://127.0.0.1:' + PORT + '/?token=<token>');
});
