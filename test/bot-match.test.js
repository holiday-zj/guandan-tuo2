// 纯机器人整场对局测试（LLM驱动）：绕开WS/e2e客户端，直接驱动 GameSession
// 目的：若此测试卡顿 → 服务端问题；若通过 → 问题在客户端交互链路
// 注意：4个座位全是bot时，一次 driveBots() 会连续跑完整场（循环只在"轮到非bot"时退出）
import assert from 'node:assert/strict';
import { Lobby, GameSession } from '../server/room.js';
import { llmStatus } from '../engine/ai/llm.js';

const st = llmStatus();
console.log('LLM状态:', st.enabled ? `✅ ${st.model}` : '❌ 未启用(将走启发式)');

const lobby = new Lobby();
const room = lobby.createPrivateRoom('bot:1', { stake: 1, rounds: 1 }); // 1副牌
room.seats = ['bot:1', 'bot:2', 'bot:3', 'bot:4'];

const session = new GameSession(room, () => null);
session.start();
console.log('开局: 第', session.roundNum, '副, 级牌', session.match.round.level);

const t0 = Date.now();
const LIMIT = 360000; // 6分钟上限（LLM每手~1-2s，一副约100+手）

// 看门狗：主线程若被同步代码卡死，此定时器不会触发；若事件循环活着但driveBots挂起，超时后打印状态
const watchdog = setInterval(() => {
  const el = ((Date.now() - t0) / 1000).toFixed(0);
  const r = session.match.round;
  const hands = r.hands.map(h => (h ? h.length : 0)).join(',');
  console.log(`  [watchdog ${el}s] round=${r.state} turn=${session.driver.turn} hands=[${hands}] finish=${r.finishOrder.length}`);
  if (Date.now() - t0 > LIMIT) {
    console.log('❌ 看门狗：超过时限，强制退出（卡死实锤）');
    process.exit(2);
  }
}, 15000);

const events = await session.driveBots();
clearInterval(watchdog);
const total = Date.now() - t0;

console.log(`\n=== 结果 ===`);
console.log('driveBots 总耗时:', (total / 1000).toFixed(1) + 's', '| 事件数:', events.length);
console.log('session.over:', session.over, '| finishOrder:', JSON.stringify(session.match.round.finishOrder));
console.log('结算:', JSON.stringify(session.match.round.result ? {
  base: session.match.round.result.base,
  tugBonus: session.match.round.result.tugBonus,
  leftover: session.match.round.result.leftover,
  total: session.match.round.result.total,
} : null));

assert.equal(session.match.round.state, 'finished', '应正常结束');
assert.equal(session.match.round.finishOrder.length, 4, '应有完整4个名次');
assert.ok(events.length > 50, '事件数应>50(实际' + events.length + ')');
assert.ok(total < LIMIT, '整场超时(疑似卡死)');
console.log('\n=== 纯机器人LLM对局测试通过 ===');
process.exit(0);
