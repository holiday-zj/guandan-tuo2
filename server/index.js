// 掼蛋（拖2）服务端入口：HTTP 注册/登录 + WebSocket 对战
// 特性：SQLite 持久化、出牌提示、断线重连、超时托管
// 启动：node server/index.js  （默认端口 8080）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptKey, parseFrames, encodeFrame, OP } from './ws.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, '..', 'web');
import { store, loadMember, settleCoins, publicProfile, memberCache } from './db.js';
import { config } from './config.js';
import {
  wxLogin, createRecharge, claimDailyFree, verifyIdentity, devFakePay, handlePayNotify,
} from './pay.js';
import { Lobby, GameSession } from './room.js';
import { botDecide, botDecideAsync } from './bot.js';
import { followOptions, leadOptions } from '../engine/hint.js';
import { bestInterpretation } from '../engine/classify.js';
import { llmStatus } from '../engine/ai/llm.js';

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

  // 静态网页版试玩客户端
  if (url.pathname === '/' || url.pathname.startsWith('/web/')) {
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice('/web/'.length);
    const file = path.normalize(path.join(WEB_DIR, rel));
    if (file.startsWith(WEB_DIR) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      const ext = path.extname(file);
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
      res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
      return;
    }
    res.writeHead(404); res.end('not found');
    return;
  }

  // REST API
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', async () => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    try {
      const data = body ? JSON.parse(body) : {};

      // 微信登录（无需登录态）
      if (url.pathname === '/api/wx/login') {
        const r = await wxLogin(data.code || '');
        if (!r.ok) { res.statusCode = 400; res.end(JSON.stringify(r)); return; }
        res.end(JSON.stringify(r));
        return;
      }

      // 米大师支付回调（生产需验签，验签逻辑在 handlePayNotify 中）
      if (url.pathname === '/api/pay/notify') {
        const r = handlePayNotify(data, req.headers['x-signature'] || '');
        res.end(JSON.stringify({ ok: !!r.ok }));
        return;
      }

      // 需要登录态的接口
      if (url.pathname.startsWith('/api/pay/') || url.pathname === '/api/profile' || url.pathname === '/api/verify') {
        const out = await handleAuthApi(url.pathname, req, data);
        if (out.status) res.statusCode = out.status;
        res.end(JSON.stringify(out.body));
        return;
      }

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
      return { ok: true, time: Date.now(), payEnabled: config.payEnabled };
    case '/api/ai/status': {
      // 机器人AI状态：大模型是否已启用（不暴露任何密钥内容）
      const st = llmStatus();
      return {
        ok: true, llmEnabled: st.enabled, base: st.base, model: st.model,
        keyLen: st.keyLen, thinkMinMs: Number(process.env.BOT_THINK_MIN || 400),
        llmTimeoutMs: Number(process.env.BOT_LLM_TIMEOUT || 9000),
      };
    }
    default:
      throw new Error('unknown path: ' + path);
  }
}

// 需要登录态的 API（token 从 Authorization 头或 query 取）
function authMember(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : new URL(req.url, 'http://x').searchParams.get('token');
  if (!token) return null;
  return store.authByToken(token);
}

async function handleAuthApi(path, req, data) {
  const member = authMember(req);
  if (!member) return { status: 401, body: { ok: false, error: '未登录' } };
  switch (path) {
    case '/api/profile':
      return { body: { ok: true, profile: publicProfile(store.memberById(member.id)) } };
    case '/api/pay/packages':
      return { body: { ok: true, packages: config.packages, payEnabled: config.payEnabled, dailyFree: config.dailyFreeCoins,
        isVerified: member.isVerified, isMinor: member.isMinor,
        dailyClaimed: store.dailyClaimed(member.id) } };
    case '/api/pay/daily': {
      const r = claimDailyFree(member);
      return r.ok ? { body: r } : { status: 400, body: r };
    }
    case '/api/pay/create': {
      const r = createRecharge(member, data.packageId, data.platform);
      return r.ok ? { body: r } : { status: 400, body: r };
    }
    case '/api/pay/dev_fake': {
      const r = devFakePay(member, data.packageId);
      return r.ok ? { body: r } : { status: 400, body: r };
    }
    case '/api/pay/orders':
      return { body: { ok: true, orders: store.listOrders(member.id) } };
    case '/api/verify': {
      const r = verifyIdentity(member, data.realName, data.idNumber);
      return r.ok ? { body: r } : { status: 400, body: r };
    }
  }
  throw new Error('unknown path: ' + path);
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
      const seat = session.engineSeat(member.id);
      ws.send({ type: 'room_joined', roomId: rec.roomId, seat, reconnect: true });
      ws.send({ type: 'game_start', seat, snapshot: session.snapshotFor(member.id), reconnect: true });
      ws.send({ type: 'snapshot', snapshot: session.snapshotFor(member.id) });
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
      try { handleMsg(member, msg); } catch (e) {
        // 单条消息处理出错不能拖垮整个服务端进程
        console.error('[handleMsg error]', e && e.stack || e);
        try { ws.send({ type: 'error', error: '服务器内部错误: ' + (e && e.message || e) }); } catch {}
      }
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
        rounds: Math.max(1, Math.min(16, msg.rounds || 8)),
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
      const seat = session.engineSeat(member.id);
      if (seat < 0) { ws.send({ type: 'error', error: '不在本局中' }); break; }
      const r = session.match.round;
      if (r.state !== 'playing' || session.driver.turn !== seat) { ws.send({ type: 'error', error: '未到你的回合' }); break; }
      let opts;
      if (session.driver.best) {
        opts = followOptions(r.hands[seat], r.level, session.driver.best.it, 8);
      } else {
        opts = leadOptions(r.hands[seat], r.level, 8);
        // 首攻禁拖：排除纯拖牌的领出候选
        if (!r.led) opts = opts.filter(o => !o.cards.every(c => c.rank === r.tug));
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
      const seat = session.engineSeat(member.id);
      if (seat < 0) { ws.send({ type: 'error', error: '不在本局中' }); break; }
      const action = msg.type === 'pass' ? { type: 'pass' } : { type: 'play', cards: msg.cards || [] };
      const res = session.handleAction(seat, action);
      if (!res.ok) { ws.send({ type: 'error', error: res.error }); break; }
      pushEvents(room.id, res.events);
      scheduleTurnTimeout(room.id);
      // 机器人接力（异步：AI 决策可能耗时，不阻塞 WS 消息循环）
      driveBotsAsync(room.id);
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
    case 'end_request': {
      const session = sessions.get(c.roomId);
      if (!session || session.over) { ws.send({ type: 'error', error: '对局未开始' }); break; }
      // 试玩/人机房（含机器人）：申请即默认通过，直接结束
      const room = lobby.rooms.get(c.roomId);
      const hasBots = room && room.seats.some(id => id && String(id).startsWith('bot:'));
      if (hasBots) {
        terminateMatch(c.roomId, '提前结束（' + member.name + ' 申请，试玩模式默认通过）');
        break;
      }
      // 纯真人房：发起提前结束申请（申请人默认同意，需共2人同意）
      session.endVote = {
        by: member.id, byName: member.name,
        reason: String(msg.reason || '').slice(0, 50),
        votes: new Set([member.id]),
        expiresAt: Date.now() + 60000,
      };
      broadcast(c.roomId, {
        type: 'end_proposal', byName: member.name, reason: session.endVote.reason,
        votes: 1, need: 2, expiresAt: session.endVote.expiresAt,
      });
      break;
    }
    case 'end_vote': {
      const session = sessions.get(c.roomId);
      if (!session || !session.endVote) break;
      if (Date.now() > session.endVote.expiresAt) { session.endVote = null; break; }
      if (msg.agree) session.endVote.votes.add(member.id);
      broadcast(c.roomId, {
        type: 'end_proposal', byName: session.endVote.byName, reason: session.endVote.reason,
        votes: session.endVote.votes.size, need: 2, expiresAt: session.endVote.expiresAt,
      });
      if (session.endVote.votes.size >= 2) terminateMatch(c.roomId, '提前结束（' + session.endVote.votes.size + '人同意）');
      else if (!msg.agree) ws.send({ type: 'error', error: '已记录你的不同意意见' });
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

// 机器人接力驱动（带并发锁：同一房间不会有两个循环同时跑）
async function driveBotsAsync(roomId) {
  const session = sessions.get(roomId);
  if (!session || session._botBusy) return;
  session._botBusy = true;
  try {
    const ev = await session.driveBots();
    if (ev && ev.length) pushEvents(roomId, ev);
  } catch (e) {
    console.error('[driveBots] 异常', roomId, e.message || e);
  } finally {
    session._botBusy = false;
    // 必须重排超时：若机器人循环异常中断且牌权仍在机器人手上，
    // 否则没有任何东西再推进牌局 → 死锁（客户端表现为"卡住不动"）
    const room = lobby.rooms.get(roomId);
    if (room && room.state === 'playing' && session.match && session.match.round.state === 'playing') {
      scheduleTurnTimeout(roomId);
    }
  }
}

async function autoPlay(roomId) {
  const session = sessions.get(roomId);
  const room = lobby.rooms.get(roomId);
  if (!session || !room || room.state !== 'playing') return;
  const r = session.match.round;
  if (r.state !== 'playing') return;
  const seat = session.driver.turn;
  const occupant = session.match.occupants[seat];
  if (occupant && String(occupant).startsWith('bot:')) {
    // 轮到机器人却触发了超时：说明机器人循环没在跑（可能异常中断过），
    // 主动拉起，否则牌局永久卡死
    await driveBotsAsync(roomId);
    return;
  }

  // 代打：用 AI 决策（LLM 优先，失败降级启发式），比旧的极简逻辑强
  let action;
  try {
    action = await botDecideAsync(session, seat);
  } catch (e) {
    action = botDecide(session, seat);
  }
  // 期间牌局可能已推进（别的动作插入），校验仍是该座位回合
  if (session.driver.turn !== seat || r.state !== 'playing') return;
  const res = session.handleAction(seat, action);
  if (!res.ok) {
    const pass = session.handleAction(seat, { type: 'pass' });
    if (!pass.ok) return;
    pushEvents(roomId, [{ type: 'auto_play', seat }, ...pass.events]);
  } else {
    pushEvents(roomId, [{ type: 'auto_play', seat }, ...res.events]);
  }
  scheduleTurnTimeout(roomId);
  await driveBotsAsync(roomId);
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

  // 给每个真人推初始快照（按玩家身份定位，座位可能已被亮牌重排）
  for (const id of room.seats) {
    if (id && !String(id).startsWith('bot:')) {
      const cc = clients.get(id);
      if (cc && cc.ws) cc.ws.send({ type: 'game_start', seat: session.engineSeat(id), snapshot: session.snapshotFor(id) });
    }
  }
  broadcast(roomId, { type: 'state', roundNum: session.roundNum, level: session.match.round.level });
  scheduleTurnTimeout(roomId);
  // 首出者是机器人时自动推进（异步，不阻塞开局）
  driveBotsAsync(roomId);
}

function pushEvents(roomId, events) {
  const session = sessions.get(roomId);
  if (!session) return;
  for (const ev of events) {
    if (ev.type === 'round_result') settleWallet(session, ev.result);
    if (ev.type === 'match_over') finishMatch(session);
  }
  broadcast(roomId, { type: 'events', events });
  // 推送最新快照给每位真人（按玩家身份定位）
  const room = lobby.rooms.get(roomId);
  if (room) {
    for (const id of room.seats) {
      if (id && !String(id).startsWith('bot:')) {
        const cc = clients.get(id);
        if (cc && cc.ws) cc.ws.send({ type: 'snapshot', snapshot: session.snapshotFor(id) });
      }
    }
  }
}

function settleWallet(session, result) {
  const room = session.room;
  const stake = room.stake || 1;
  const amount = result.total * stake;
  const occupants = session.match.occupants; // 引擎座位 → 玩家身份（重排后）
  const winnerIds = result.winners.map(s => occupants[s]).filter(id => id && !String(id).startsWith('bot:'));
  const loserIds = result.losers.map(s => occupants[s]).filter(id => id && !String(id).startsWith('bot:'));
  settleCoins(winnerIds, loserIds, amount);
  for (const id of [...winnerIds, ...loserIds]) {
    const m = loadMember(id);
    if (m) { m.stats.rounds++; if (winnerIds.includes(id)) m.stats.wins++; store.bumpStats(m.id, m.stats); }
  }
}

function finishMatch(session) {
  clearTimeout(turnTimers.get(session.room.id));
  const ranking = session.match.ranking();
  store.logMatch(ranking[0] ? ranking[0].score : 0, session.match.roundNo, {
    ranking: ranking.map(r => ({ id: r.id, score: r.score })),
  });
  for (const id of session.room.seats) {
    if (id && !String(id).startsWith('bot:')) {
      const m = loadMember(id);
      if (m) { m.stats.matches++; store.bumpStats(m.id, m.stats); }
    }
  }
}

// 提前结束比赛：以当前个人积分定排名，不再结算本副，全员回大厅
function terminateMatch(roomId, reason) {
  const session = sessions.get(roomId);
  const room = lobby.rooms.get(roomId);
  if (!session || !room) return;
  session.over = true;
  session.endVote = null;
  room.state = 'finished';
  clearTimeout(turnTimers.get(roomId));
  const names = session.seatNames();
  const nameOf = {};
  session.match.occupants.forEach((id, i) => nameOf[String(id)] = names[i]);
  const ranking = session.match.ranking().map(r => ({ id: r.id, name: nameOf[String(r.id)], score: r.score }));
  store.logMatch(ranking[0] ? ranking[0].score : 0, session.match.roundNo, { terminated: true, reason });
  broadcast(roomId, { type: 'match_over', ranking, scores: session.match.scores(), terminated: true, reason });
  // 全员回大厅
  for (const id of room.seats) {
    if (id && !String(id).startsWith('bot:')) {
      const cc = clients.get(id);
      if (cc) { cc.roomId = null; cc.seat = null; }
    }
  }
  lobby.rooms.delete(roomId);
  sessions.delete(roomId);
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
  const nameOf = id => { const m = loadMember(id); return m ? m.name : null; };
  broadcast(roomId, { type: 'room_state', seats: room.names(nameOf), state: room.state, stake: room.stake });
}

server.listen(PORT, () => {
  console.log(`[掼蛋·拖2] 服务端已启动：http://127.0.0.1:${PORT}`);
  console.log('持久化: SQLite (data/guandan.db)');
  console.log('REST: /api/register /api/login /api/rooms /api/health');
  console.log('WS:   ws://127.0.0.1:' + PORT + '/?token=<token>');
});
