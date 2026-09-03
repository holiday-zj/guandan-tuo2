// 掼蛋（拖2）服务端入口：HTTP 注册/登录 + WebSocket 对战
// 启动：node server/index.js  （默认端口 8080）
import http from 'node:http';
import crypto from 'node:crypto';
import { acceptKey, parseFrames, encodeFrame, OP } from './ws.js';
import {
  register, login, issueToken, auth, settleCoins, publicProfile, members,
} from './store.js';
import { Lobby, GameSession } from './room.js';

const PORT = process.env.PORT || 8080;
const lobby = new Lobby();
const sessions = new Map();   // roomId -> GameSession
const clients = new Map();    // memberId -> {ws, name}

// —— HTTP ——
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  // WebSocket 升级
  if (req.headers.upgrade === 'websocket') {
    const token = url.searchParams.get('token');
    const member = auth(token);
    if (!member) { res.writeHead(401); res.end('unauthorized'); return; }
    const key = req.headers['sec-websocket-key'];
    // 手动写入 101 握手响应并立即刷新，再挂载帧处理
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
      if ([...members.values()].some(m => m.name === data.name)) throw new Error('昵称已被占用');
      const m = register(data.name, data.password);
      const token = issueToken(m.id);
      return { ok: true, token, profile: publicProfile(m) };
    }
    case '/api/login': {
      const m = login(data.name, data.password);
      if (!m) throw new Error('账号或密码错误');
      const token = issueToken(m.id);
      return { ok: true, token, profile: publicProfile(m) };
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
  clients.set(member.id, { ws, name: member.name, seat: null, roomId: null });
  ws.send({ type: 'welcome', profile: publicProfile(member), name: member.name });

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
    const c = clients.get(member.id);
    if (c && c.roomId) {
      const room = lobby.rooms.get(c.roomId);
      if (room) room.removePlayer(member.id);
      broadcastRoom(c.roomId);
    }
    clients.delete(member.id);
    lobby.dequeue(member.id);
  });
  socket.on('error', () => {});
}

function handleMsg(member, msg) {
  const c = clients.get(member.id);
  if (!c) return;
  const ws = c.ws;

  switch (msg.type) {
    case 'create_room': {
      const room = lobby.createPrivateRoom(member.id, {
        stake: msg.stake || 1,
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
      maybeStart(msg.roomId);
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
      break;
    }
    case 'leave_room': {
      const room = lobby.rooms.get(c.roomId);
      if (room) { room.removePlayer(member.id); broadcastRoom(room.id); }
      lobby.dequeue(member.id);
      c.roomId = null; c.seat = null;
      ws.send({ type: 'left_room' });
      break;
    }
    default:
      ws.send({ type: 'error', error: 'unknown message type: ' + msg.type });
  }
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

  const session = new GameSession(room, id => members.get(id));
  sessions.set(roomId, session);
  session.start();
  room.state = 'playing';
  const botEvents = session.driveBots(); // 首出者是机器人时自动推进

  // 给每个真人推初始快照
  for (let seat = 0; seat < 4; seat++) {
    const id = room.seats[seat];
    if (id && !id.startsWith('bot:')) {
      const cc = clients.get(id);
      if (cc) cc.ws.send({ type: 'game_start', seat, snapshot: session.snapshotFor(seat) });
    }
  }
  broadcast(roomId, { type: 'state', roundNum: session.roundNum, level: session.match.round.level });
}

function pushEvents(roomId, events) {
  const session = sessions.get(roomId);
  if (!session) return;
  for (const ev of events) {
    if (ev.type === 'round_result') settleWallet(session, ev.result);
  }
  broadcast(roomId, { type: 'events', events });
  // 推送最新快照给每位真人
  const room = lobby.rooms.get(roomId);
  if (room) {
    for (let seat = 0; seat < 4; seat++) {
      const id = room.seats[seat];
      if (id && !id.startsWith('bot:')) {
        const cc = clients.get(id);
        if (cc) cc.ws.send({ type: 'snapshot', snapshot: session.snapshotFor(seat) });
      }
    }
  }
}

function settleWallet(session, result) {
  const room = session.room;
  const stake = room.stake || 1;
  const amount = result.total * stake;
  const winners = result.winners.map(s => room.seats[s]).filter(id => id && !id.startsWith('bot:'));
  const losers = result.losers.map(s => room.seats[s]).filter(id => id && !id.startsWith('bot:'));
  const wMembers = winners.map(id => members.get(id)).filter(Boolean);
  const lMembers = losers.map(id => members.get(id)).filter(Boolean);
  settleCoins(wMembers, lMembers, amount);
  for (const m of wMembers) m.stats.wins++;
  for (const m of [...wMembers, ...lMembers]) m.stats.rounds++;
}

function broadcast(roomId, msg) {
  const room = lobby.rooms.get(roomId);
  if (!room) return;
  for (const id of room.seats) {
    if (id && !id.startsWith('bot:')) {
      const cc = clients.get(id);
      if (cc) cc.ws.send(msg);
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
  console.log('REST: /api/register /api/login /api/rooms /api/health');
  console.log('WS:   ws://127.0.0.1:' + PORT + '/?token=<token>');
});
