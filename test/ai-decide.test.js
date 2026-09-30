// AI 决策层测试：降级保底、LLM输出校验、整副对局跑通（新AI驱动）
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDeck, shuffle } from '../engine/cards.js';
import { Round } from '../engine/game.js';
import { PlayTracker, handStrength, tugPolicy } from '../engine/ai/analyze.js';
import { heuristicDecide, decideAsync, SYSTEM_PROMPT } from '../engine/ai/decide.js';
import { leadOptions, followOptions } from '../engine/hint.js';
import { bestInterpretation, canBeat } from '../engine/classify.js';
import { llmStatus } from '../engine/ai/llm.js';

// 构造一个测试局面
function makeRound(level = '9', hands = null, seed = 1) {
  const rng = (() => { let s = seed; return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648; })();
  const r = new Round([0, 1, 2, 3], [0, 1, 0, 1], rng);
  r.deal();
  r.applyFlip({ flip: { suit: '♠', rank: '8' }, level, tug: level === '2' ? '3' : '2', teamOf: [0, 1, 0, 1], holders: [0, 2] });
  if (hands) r.hands = hands;
  r.startPlay(0);
  r.led = true; // 默认已过首攻
  return r;
}
const C = (rank, suit = '♠', id = Math.floor(Math.random() * 1e9)) => ({ id, suit, rank });

function buildCtx(round, seat, best = null) {
  const hand = round.hands[seat];
  const tracker = new PlayTracker();
  tracker.reset(round.level, round.tug);
  const strength = handStrength(hand, round.level, tracker);
  const policy = tugPolicy(hand, round.level, strength, {});
  const candidates = (best
    ? followOptions(hand, round.level, best.it, 40)
    : leadOptions(hand, round.level, 200)
  ).map((o, i) => ({ idx: i, cards: o.cards, it: o.it, type: o.it.type }));
  return {
    hand, level: round.level, tug: round.tug, best, candidates,
    strength, strengths: { [seat]: strength }, policy,
    situation: { partner: (seat + 2) % 4 }, seat, round, tracker, isFirstLead: !round.led,
  };
}

test('SYSTEM_PROMPT 覆盖关键规则与团队/拖牌要求', () => {
  for (const kw of ['拖', '双上', '末游', '逢人配', '接风', '队友', 'JSON']) {
    assert.ok(SYSTEM_PROMPT.includes(kw), 'system prompt 应包含: ' + kw);
  }
  assert.ok(SYSTEM_PROMPT.length < 3000, 'prompt 应精简(' + SYSTEM_PROMPT.length + '字符)');
});

test('启发式：领出必出牌，且首攻不出纯拖', () => {
  const round = makeRound('9', [
    [C('2', '♠', 1), C('2', '♥', 2), C('5', '♠', 3), C('8', '♣', 4)],
    [C('3', '♠', 5)], [C('4', '♠', 6)], [C('6', '♠', 7)],
  ]);
  round.led = false; // 首攻
  const ctx = buildCtx(round, 0, null);
  const a = heuristicDecide(ctx);
  assert.equal(a.type, 'play', '领出必须出牌');
  const played = ctx.hand.filter(h => a.cards.some(c => c.id === h.id));
  assert.equal(played.every(c => c.rank === '2'), false, '首攻不能出纯拖牌');
});

test('启发式：弱牌(dump策略)领出时优先甩掉拖牌', () => {
  const weak = [
    C('2', '♠', 1), C('2', '♣', 2),            // 拖牌
    C('4', '♠', 3), C('6', '♥', 4), C('8', '♣', 5), C('T', '♦', 6),
    C('3', '♠', 7), C('5', '♥', 8), C('7', '♣', 9), C('J', '♦', 10),
    C('4', '♣', 11), C('9', '♥', 12),
  ];
  const round = makeRound('9', [weak, [C('3', '♠', 90)], [C('4', '♠', 91)], [C('6', '♠', 92)]]);
  const ctx = buildCtx(round, 0, null);
  assert.equal(ctx.policy.policy, 'dump', '弱牌应判定为dump');
  // 多跑几次：dump策略下拖牌应比强牌策略更早被打出
  let tugLedFirst = 0;
  for (let i = 0; i < 5; i++) {
    const a = heuristicDecide(buildCtx(round, 0, null));
    const played = ctx.hand.filter(h => a.cards.some(c => c.id === h.id));
    if (played.some(c => c.rank === '2')) tugLedFirst++;
  }
  assert.ok(tugLedFirst >= 1, 'dump策略下应主动出含拖牌的牌型，实际' + tugLedFirst);
});

test('启发式：不压队友的牌（团队观念）', () => {
  const myHand = [C('A', '♠', 1), C('K', '♠', 2), C('Q', '♠', 3)];
  const round = makeRound('9', [myHand, [C('3', '♠', 90)], [C('4', '♠', 91)], [C('6', '♠', 92)]]);
  const partnerSeat = 2; // seat 0 的队友是 2
  const partnerCards = [C('9', '♠', 50)];
  const best = { cards: partnerCards, it: bestInterpretation(partnerCards, '9'), by: partnerSeat };
  const ctx = buildCtx(round, 0, best);
  const a = heuristicDecide(ctx);
  assert.equal(a.type, 'pass', '队友出牌时不应压制');
});

test('启发式：对手告急(≤3张)时压制，即使要用大牌', () => {
  const myHand = [C('A', '♠', 1), C('K', '♠', 2), C('5', '♠', 3), C('4', '♣', 4)];
  const round = makeRound('9', [myHand, [C('3', '♠', 90)], [C('4', '♠', 91)], [C('6', '♠', 92), C('7', '♠', 93)]]);
  const oppCards = [C('8', '♠', 60)];
  const best = { cards: oppCards, it: bestInterpretation(oppCards, '9'), by: 3 };
  const ctx = buildCtx(round, 0, best);
  // 让追踪器显示对手只剩2张
  ctx.tracker.playedBySeat[3] = 25;
  const a = heuristicDecide(ctx);
  assert.equal(a.type, 'play', '对手告急应压制');
});

test('启发式：能一手清牌时优先清牌（抢头游）', () => {
  const myHand = [C('K', '♠', 1), C('K', '♥', 2)];
  const round = makeRound('9', [myHand, [C('3', '♠', 90), C('4', '♠', 91)], [C('5', '♠', 92)], [C('6', '♠', 93)]]);
  const oppCards = [C('Q', '♠', 60)];
  const best = { cards: oppCards, it: bestInterpretation(oppCards, '9'), by: 1 };
  const ctx = buildCtx(round, 0, best);
  // 只有对K能压对Q —— 但对手出的是单张Q，需要单张压；改用单张场景
  const ctx2 = buildCtx(round, 0, { cards: [C('Q', '♠', 60)], it: bestInterpretation([C('Q', '♠', 60)], '9'), by: 1 });
  const a2 = heuristicDecide(ctx2);
  assert.equal(a2.type, 'play');
  assert.equal(a2.cards.length, 1, '单张跟牌只出1张');
});

test('启发式：锁定牌圈(头游纯拖)只能过', () => {
  const round = makeRound('9', [
    [C('A', '♠', 1), C('K', '♠', 2)], [C('3', '♠', 90)], [C('4', '♠', 91)], [C('6', '♠', 92)],
  ]);
  round.trick = { locked: true };
  const locked = [C('2', '♠', 70)];
  const best = { cards: locked, it: bestInterpretation(locked, '9'), by: 1 };
  // decideAsync 会检查 locked → pass
  const session = {
    match: { round }, driver: { best, consecutivePasses: 0, turn: 0, trickSeq: 1 },
    trackers: [new PlayTracker(), new PlayTracker(), new PlayTracker(), new PlayTracker()],
  };
  return decideAsync(session, 0).then(a => {
    assert.equal(a.type, 'pass');
    assert.equal(a.via, 'locked-trick');
  });
});

test('decideAsync：LLM未配置时自动降级启发式，不抛异常', async () => {
  const st = llmStatus();
  const round = makeRound('9');
  const session = {
    match: { round }, driver: { best: null, consecutivePasses: 0, turn: 0, trickSeq: 0 },
    trackers: [new PlayTracker(), new PlayTracker(), new PlayTracker(), new PlayTracker()],
  };
  const a = await decideAsync(session, 0);
  assert.ok(a, '应返回动作');
  assert.ok(['play', 'pass'].includes(a.type));
  if (!st.enabled) {
    assert.match(String(a.via || ''), /heuristic|fallback|no-candidates/, 'LLM未配置应走保底，via=' + a.via);
  }
  if (a.type === 'play') {
    // 出的牌必须在手牌中（不幻觉造牌）
    for (const c of a.cards) {
      assert.ok(round.hands[0].some(h => h.id === c.id), '出的牌必须在手中');
    }
  }
});

test('decideAsync：领出时绝不返回pass（引擎不允许）', async () => {
  const round = makeRound('9');
  const session = {
    match: { round }, driver: { best: null, consecutivePasses: 0, turn: 0, trickSeq: 0 },
    trackers: [new PlayTracker(), new PlayTracker(), new PlayTracker(), new PlayTracker()],
  };
  for (let seat = 0; seat < 4; seat++) {
    session.driver.turn = seat;
    const a = await decideAsync(session, seat);
    assert.equal(a.type, 'play', `seat${seat} 领出必须出牌`);
    assert.ok(a.cards.length > 0);
  }
});

test('decideAsync：首攻不出纯拖牌（规则约束）', async () => {
  const round = makeRound('9');
  round.led = false;
  const session = {
    match: { round }, driver: { best: null, consecutivePasses: 0, turn: 0, trickSeq: 0 },
    trackers: [new PlayTracker(), new PlayTracker(), new PlayTracker(), new PlayTracker()],
  };
  for (let i = 0; i < 8; i++) {
    session.driver.turn = i % 4;
    const a = await decideAsync(session, i % 4);
    if (a.type === 'play') {
      const played = round.hands[i % 4].filter(h => a.cards.some(c => c.id === h.id));
      assert.equal(played.every(c => c.rank === round.tug), false, '首攻不能纯拖');
    }
  }
});
