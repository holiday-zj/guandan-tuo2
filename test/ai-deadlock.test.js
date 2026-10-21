// 死锁回归测试：机器人领出时必须有牌可出（曾因"手里只剩逢人配"枚举出0候选而卡死整局）
import test from 'node:test';
import assert from 'node:assert/strict';
import { leadOptions, followOptions } from '../engine/hint.js';
import { Round } from '../engine/game.js';
import { PlayTracker } from '../engine/ai/analyze.js';
import { decideAsync } from '../engine/ai/decide.js';
import { bestInterpretation } from '../engine/classify.js';

const W = (id, level) => ({ id, suit: '♥', rank: level }); // 逢人配 = 红桃级牌
const C = (rank, suit, id) => ({ id, suit, rank });

test('回归：手牌只剩逢人配时 leadOptions 必须非空（死锁根因）', () => {
  for (const level of ['2', '5', '9', 'A']) {
    const opts = leadOptions([W(1, level)], level, 50);
    assert.ok(opts.length >= 1, `级牌${level}：只剩1张逢人配应有候选，实际${opts.length}`);
    const opts2 = leadOptions([W(1, level), W(2, level)], level, 50);
    assert.ok(opts2.length >= 1, `级牌${level}：只剩2张逢人配应有候选，实际${opts2.length}`);
  }
});

test('回归：decideAsync 在领出时永不返回 pass（引擎禁止→会死锁）', async () => {
  const cases = [
    { name: '只剩1张逢人配', hand: [W(1, '9')] },
    { name: '只剩2张逢人配', hand: [W(1, '9'), W(2, '9')] },
    { name: '只剩1张拖牌', hand: [C('2', '♠', 1)] },
    { name: '只剩1张普通牌', hand: [C('7', '♣', 1)] },
    { name: '只剩大小王', hand: [C('BJ', 'X', 1), C('SJ', 'X', 2)] },
  ];
  for (const cs of cases) {
    const round = {
      level: '9', tug: '2', teamOf: [0, 1, 0, 1], finishOrder: [], led: true,
      hands: [cs.hand, [C('3', '♠', 50)], [C('4', '♠', 51)], [C('5', '♠', 52)]],
      trick: null,
    };
    const trackers = [new PlayTracker(), new PlayTracker(), new PlayTracker(), new PlayTracker()];
    trackers.forEach(t => t.reset('9', '2'));
    const session = { match: { round }, driver: { best: null, turn: 0, trickSeq: 0 }, trackers };
    const a = await decideAsync(session, 0, trackers);
    assert.equal(a.type, 'play', `${cs.name}: 领出必须出牌，实际 ${a.type} (via=${a.via})`);
    // 出的牌必须在手
    for (const c of a.cards) assert.ok(cs.hand.some(h => h.id === c.id), `${cs.name}: 出牌必须在手中`);
  }
});

test('回归：首攻时即使手里只有拖牌也要能出（避免首攻禁拖规则导致死锁）', async () => {
  // 极端构造：手里只有拖牌2。首攻禁纯拖，但引擎最终会接受（否则永久卡住）
  const round = {
    level: '9', tug: '2', teamOf: [0, 1, 0, 1], finishOrder: [], led: false, // 首攻
    hands: [[C('2', '♠', 1)], [C('3', '♠', 50)], [C('4', '♠', 51)], [C('5', '♠', 52)]],
    trick: null,
  };
  const trackers = [new PlayTracker(), new PlayTracker(), new PlayTracker(), new PlayTracker()];
  trackers.forEach(t => t.reset('9', '2'));
  const session = { match: { round }, driver: { best: null, turn: 0, trickSeq: 0 }, trackers };
  const a = await decideAsync(session, 0, trackers);
  assert.equal(a.type, 'play', '首攻只有拖牌时也必须出牌（保底）');
  assert.equal(a.cards.length, 1);
});

test('回归：跟牌无候选时返回pass（不死循环）', async () => {
  const round = {
    level: '9', tug: '2', teamOf: [0, 1, 0, 1], finishOrder: [], led: true,
    hands: [[C('3', '♠', 1)], [C('A', '♠', 50)], [C('4', '♠', 51)], [C('5', '♠', 52)]],
    trick: null,
  };
  const big = [C('A', '♠', 50)];
  const trackers = [new PlayTracker(), new PlayTracker(), new PlayTracker(), new PlayTracker()];
  trackers.forEach(t => t.reset('9', '2'));
  const session = {
    match: { round },
    driver: { best: { cards: big, it: bestInterpretation(big, '9'), by: 1 }, turn: 0, trickSeq: 1 },
    trackers,
  };
  const a = await decideAsync(session, 0, trackers);
  assert.equal(a.type, 'pass', '3压不过A，应过牌');
});

test('整副对局：3机器人+1极简真人跑完8副不死锁（服务端同链路已在e2e覆盖）', async () => {
  // 用引擎驱动多副牌，全程 AI 决策，确认无死锁
  for (let roundNo = 0; roundNo < 3; roundNo++) {
    const r = new Round([0, 1, 2, 3], [0, 1, 0, 1]);
    r.deal();
    const info = r.flip();
    // 与生产 Match.newRound() 一致：强制队伍0坐0/2、队伍1坐1/3（对角）
    r.applyFlip({ ...info, teamOf: [0, 1, 0, 1] });
    r.startPlay(0);
    const trackers = [0, 1, 2, 3].map(() => { const t = new PlayTracker(); t.reset(r.level, r.tug); return t; });
    let guard = 0;
    let best = null;
    let passes = 0;
    let turn = 0;
    const active = s => !r.finishOrder.includes(s);
    const activeCount = () => [0, 1, 2, 3].filter(active).length;

    while (r.state === 'playing') {
      if (++guard > 3000) throw new Error(`第${roundNo}副未收敛(guard>3000) → 死锁`);
      if (!active(turn)) { turn = (turn + 1) % 4; continue; }
      r.lead = turn;
      const session = { match: { round: r }, driver: { best, turn, trickSeq: 0 }, trackers };
      let action = await decideAsync(session, turn, trackers);
      // 领出必须出牌
      if (!best) assert.equal(action.type, 'play', `第${roundNo}副 seat${turn} 领出不能pass`);
      if (action.type === 'pass') {
        passes++;
        trackers.forEach(t => t.record(turn, null, 'pass'));
        if (passes >= activeCount() - (active(best.by) ? 1 : 0)) {
          let next = active(best.by) ? best.by : (best.by + 2) % 4;
          if (!active(next)) {
            for (let s = 0; s < 4; s++) if (!r.finishOrder.includes(s)) r.finishOrder.push(s);
            r.state = 'finished'; break;
          }
          best = null; passes = 0; r.trick = null; turn = next; continue; // 与服务端 endTrick 一致：清空旧牌圈
        }
        turn = (turn + 1) % 4; continue;
      }
      const cards = action.cards.map(c => r.hands[turn].find(h => h.id === c.id)).filter(Boolean);
      assert.equal(cards.length, action.cards.length, '出牌必须在手中');
      const ev = r.act(turn, cards);
      assert.ok(ev.ok, `第${roundNo}副 seat${turn} 出牌被引擎拒绝: ${ev.error}`);
      best = { cards, it: ev.play, by: turn };
      passes = 0;
      trackers.forEach(t => t.record(turn, cards, ev.play.type));
      if (r.state === 'finished') break;
      turn = (turn + 1) % 4;
    }
    assert.equal(r.state, 'finished', `第${roundNo}副应正常结束`);
    assert.equal(r.finishOrder.length, 4, '应有完整4个名次');
    assert.equal(guard < 3000, true, `第${roundNo}副收敛，用了${guard}步`);
  }
});
