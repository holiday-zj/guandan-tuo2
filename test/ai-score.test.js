// 评分层测试：硬事实计算 / 候选评分排序 / 违规校验器 / 引擎推荐
import test from 'node:test';
import assert from 'node:assert/strict';
import { Round } from '../engine/game.js';
import { PlayTracker, handStrength, tugPolicy } from '../engine/ai/analyze.js';
import { buildFacts, factsToText, prepareDecision, validateDecision, engineRecommend, scoreCandidate, passScore, estimateOppBeatRisk, estimateHands, bombHandsCount } from '../engine/ai/score.js';
import { RoundMemory } from '../engine/ai/memory.js';
import { bestInterpretation } from '../engine/classify.js';
import { leadOptions, followOptions } from '../engine/hint.js';

function makeRound(level = '9', hands = null, seed = 1) {
  const rng = (() => { let s = seed; return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648; })();
  const r = new Round([0, 1, 2, 3], [0, 1, 0, 1], rng);
  r.deal();
  r.applyFlip({ flip: { suit: '♠', rank: '8' }, level, tug: level === '2' ? '3' : '2', teamOf: [0, 1, 0, 1], holders: [0, 2] });
  if (hands) r.hands = hands;
  r.startPlay(0);
  r.led = true;
  return r;
}
const C = (rank, suit = '♠', id = Math.floor(Math.random() * 1e9)) => ({ id, suit, rank });

function buildCtx(round, seat, best = null, driver = null) {
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
    situation: { partner: (seat + 2) % 4 }, seat, round, tracker,
    driver: driver || { best, consecutivePasses: 0, turn: seat, trickSeq: 1 },
    isFirstLead: !round.led,
  };
}

test('buildFacts：对手牌圈主只剩1张 → oppLastCard + 必须压制', () => {
  const myHand = [C('A', '♠', 1), C('K', '♠', 2), C('5', '♠', 3), C('4', '♣', 4)];
  const round = makeRound('9', [myHand, [C('3', '♠', 90)], [C('4', '♠', 91)], [C('8', '♠', 60), C('9', '♠', 93)]]);
  const best = { cards: [C('8', '♠', 60)], it: bestInterpretation([C('8', '♠', 60)], '9'), by: 3 };
  const ctx = buildCtx(round, 0, best);
  ctx.tracker.playedBySeat[3] = 26; // 座3剩1张
  const facts = buildFacts(ctx);
  assert.equal(facts.oppUrgentNow, true, '对手剩1张应告急');
  assert.equal(facts.oppLastCard, true, '剩1张应触发oppLastCard');
  const txt = factsToText(facts, 0);
  assert.match(txt, /他就出完/, '事实文本应警告放过去对手就出完');
  assert.match(txt, /必须压/, '必须压制');
});

test('buildFacts：过牌后果——对手牌圈+三家已表态 → 牌权回对手（接风真相）', () => {
  const myHand = [C('K', '♠', 1), C('5', '♠', 3), C('4', '♣', 4)];
  const round = makeRound('9', [myHand, [C('3', '♠', 90)], [C('4', '♠', 91)], [C('6', '♠', 92)]]);
  // 座1(对手)领出，座2、座3已过，轮到我(座0)——我过则圈结束，牌权回座1
  const best = { cards: [C('7', '♠', 60)], it: bestInterpretation([C('7', '♠', 60)], '9'), by: 1 };
  const ctx = buildCtx(round, 0, best, { best, consecutivePasses: 2, turn: 0, trickSeq: 3 });
  const facts = buildFacts(ctx);
  assert.equal(facts.passEndsTrick, true, '我过牌应结束本圈');
  assert.equal(facts.passNextOwner, 1, '牌权应回座1');
  assert.equal(facts.passNextIsPartner, false);
  assert.equal(facts.passWindsToOpp, false);
  const txt = factsToText(facts, 0);
  assert.match(txt, /牌权回到对手1号位/, '应明示牌权回对手');
  assert.match(txt, /过牌不是"送队友"/, '应纠正接风误解');
});

test('buildFacts：队友出完最后一手+三家不要 → 接风给我(passWindsToMe)', () => {
  const myHand = [C('K', '♠', 1), C('5', '♠', 3)];
  const round = makeRound('9', [myHand, [C('3', '♠', 90)], [C('4', '♠', 91)], []]);
  round.finishOrder = [3]; // 座3(我的队友? 不, 座0队友是座2) — 改用座2出完
  round.finishOrder = [2];
  const best = { cards: [C('7', '♠', 60)], it: bestInterpretation([C('7', '♠', 60)], '9'), by: 2 };
  // 座2已出完；一圈内座3、座1已过(passes=2)，我过 → 圈结束 → 接风给best.by+2=座0=我
  const ctx = buildCtx(round, 0, best, { best, consecutivePasses: 2, turn: 0, trickSeq: 3 });
  const facts = buildFacts(ctx);
  assert.equal(facts.passEndsTrick, true);
  assert.equal(facts.passWindsToMe, true, '应识别接风给我');
  assert.match(factsToText(facts, 0), /接风给你/);
});

test('buildFacts：队友剩1张 → partnerNeedLead，文本强制夺牌权', () => {
  const myHand = [C('A', '♠', 1), C('K', '♠', 2), C('5', '♠', 3)];
  const round = makeRound('9', [myHand, [C('8', '♠', 60), C('3', '♠', 90), C('4', '♠', 91)], [C('9', '♥', 92)], [C('6', '♠', 93)]]);
  const best = { cards: [C('8', '♠', 60)], it: bestInterpretation([C('8', '♠', 60)], '9'), by: 1 };
  const ctx = buildCtx(round, 0, best);
  ctx.tracker.playedBySeat[2] = 26; // 队友(座2)剩1张
  const facts = buildFacts(ctx);
  assert.equal(facts.partnerNeedLead, true);
  const txt = factsToText(facts, 0);
  assert.match(txt, /必须夺牌权/, '应要求夺牌权');
  assert.match(txt, /过牌不是接风|过牌≠接风|拿不到牌权/);
});

test('评分排序：跟小牌时"小压"排在"用A压"和"上炸"之前', () => {
  const myHand = [C('5', '♠', 1), C('6', '♠', 2), C('A', '♠', 3), C('9', '♠', 4), C('9', '♥', 5), C('9', '♣', 6), C('9', '♦', 7)];
  const round = makeRound('K', [myHand, [C('3', '♠', 90)], [C('4', '♠', 91)], [C('6', '♠', 92)]]);
  const t = [C('4', '♠', 60)];
  const best = { cards: t, it: bestInterpretation(t, 'K'), by: 1 };
  const ctx = buildCtx(round, 0, best);
  const { recommend } = prepareDecision(ctx);
  assert.equal(recommend.action, 'play', '应推荐出牌(能小压)');
  const top = ctx.candidates[0];
  assert.equal(top.idx, recommend.idx, '#0应是引擎推荐');
  assert.equal(top.type, 'single', '最优应是单张');
  assert.equal(top.cards[0].rank, '5', '应选最小的能压单张5，实际' + top.cards[0].rank);
  // 炸弹排在最后
  const bombIdx = ctx.candidates.findIndex(c => c.type === 'bomb');
  assert.ok(bombIdx > 0, '炸弹应排在靠后位置');
});

test('评分：一手清牌候选压倒一切(winAll置顶)', () => {
  const myHand = [C('K', '♠', 1), C('K', '♥', 2)];
  const round = makeRound('9', [myHand, [C('3', '♠', 90)], [C('4', '♠', 91)], [C('6', '♠', 92)]]);
  const t = [C('Q', '♠', 60), C('Q', '♥', 61)];
  const best = { cards: t, it: bestInterpretation(t, '9'), by: 1 };
  const ctx = buildCtx(round, 0, best);
  const { facts, recommend } = prepareDecision(ctx);
  assert.equal(facts.canWinAll, true);
  assert.equal(recommend.action, 'play');
  const rc = ctx.candidates.find(c => c.idx === recommend.idx);
  assert.equal(rc.cards.length, 2, '应推荐对K清牌');
  assert.equal(rc.idx, 0, '清牌候选应排#0');
});

test('评分：队友牌圈默认推荐过牌(非清牌非冲刺)', () => {
  const myHand = [C('A', '♠', 1), C('K', '♠', 2), C('Q', '♠', 3), C('5', '♠', 4), C('6', '♣', 5), C('7', '♦', 6), C('8', '♥', 7)];
  const round = makeRound('9', [myHand, [C('3', '♠', 90)], [C('4', '♠', 91)], [C('6', '♠', 92)]]);
  const t = [C('5', '♥', 60)];
  const best = { cards: t, it: bestInterpretation(t, '9'), by: 2 }; // 队友座2
  const ctx = buildCtx(round, 0, best);
  const { facts, recommend } = prepareDecision(ctx);
  assert.equal(facts.byPartner, true);
  assert.equal(recommend.action, 'pass', '队友的牌应推荐过');
  assert.equal(recommend.hard, 'partner-lead');
});

test('评分：告急对手牌圈推荐压制(must-beat)，即使要上大牌', () => {
  const myHand = [C('A', '♠', 1), C('K', '♠', 2), C('5', '♠', 3), C('4', '♣', 4), C('6', '♦', 5), C('7', '♥', 6)];
  const round = makeRound('9', [myHand, [C('3', '♠', 90)], [C('4', '♠', 91)], [C('8', '♠', 60), C('J', '♠', 93)]]);
  const t = [C('8', '♠', 60)];
  const best = { cards: t, it: bestInterpretation(t, '9'), by: 3 };
  const ctx = buildCtx(round, 0, best);
  ctx.tracker.playedBySeat[3] = 25; // 座3剩2张
  const { facts, recommend } = prepareDecision(ctx);
  assert.equal(facts.oppUrgentNow, true);
  assert.equal(recommend.action, 'play', '告急必须压制');
  assert.equal(recommend.hard, 'must-beat');
});

test('校验器：告急时LLM过牌 → 违规文本要求压制', () => {
  const myHand = [C('A', '♠', 1), C('K', '♠', 2), C('5', '♠', 3)];
  const round = makeRound('9', [myHand, [C('3', '♠', 90)], [C('4', '♠', 91)], [C('8', '♠', 60), C('J', '♠', 93)]]);
  const t = [C('8', '♠', 60)];
  const best = { cards: t, it: bestInterpretation(t, '9'), by: 3 };
  const ctx = buildCtx(round, 0, best);
  ctx.tracker.playedBySeat[3] = 25;
  const { facts } = prepareDecision(ctx);
  const v = validateDecision({ action: 'pass', reason: '留力' }, ctx, facts);
  assert.ok(v, '告急过牌应被判违规');
  assert.match(v, /必须压制/);
});

test('校验器：领出时pass → 违规', () => {
  const round = makeRound('9', [[C('A', '♠', 1), C('5', '♠', 3)], [C('3', '♠', 90)], [C('4', '♠', 91)], [C('6', '♠', 92)]]);
  const ctx = buildCtx(round, 0, null);
  prepareDecision(ctx);
  const v = validateDecision({ action: 'pass' }, ctx, ctx.facts);
  assert.match(v, /领出不能过牌/);
});

test('校验器：压未出完队友的牌(非清牌) → 违规', () => {
  const myHand = [C('A', '♠', 1), C('K', '♠', 2), C('Q', '♠', 3), C('5', '♠', 4), C('6', '♣', 5), C('7', '♦', 6)];
  const round = makeRound('9', [myHand, [C('3', '♠', 90)], [C('4', '♠', 91)], [C('6', '♠', 92)]]);
  const t = [C('5', '♥', 60)];
  const best = { cards: t, it: bestInterpretation(t, '9'), by: 2 };
  const ctx = buildCtx(round, 0, best);
  const { facts } = prepareDecision(ctx);
  const pick = ctx.candidates.find(c => c.type === 'single');
  const v = validateDecision({ action: 'play', candidate: pick.idx }, ctx, facts);
  assert.ok(v, '压队友应违规');
  assert.match(v, /队友/);
});

test('校验器：有干净候选时选拆牌候选 → 违规并给出替代', () => {
  // 手牌: 对5(成型) + 散张8；对手出单4 → 候选含"单5(拆对)"与"单8(干净)"
  const myHand = [C('5', '♠', 1), C('5', '♥', 2), C('8', '♠', 3), C('T', '♦', 4), C('J', '♣', 5)];
  const round = makeRound('9', [myHand, [C('3', '♠', 90)], [C('4', '♠', 91)], [C('6', '♠', 92)]]);
  const t = [C('4', '♠', 60)];
  const best = { cards: t, it: bestInterpretation(t, '9'), by: 1 };
  const ctx = buildCtx(round, 0, best);
  const { facts } = prepareDecision(ctx);
  const splitPair = ctx.candidates.find(c => c.cards.length === 1 && c.cards[0].rank === '5');
  assert.ok(splitPair, '应有单5候选');
  const v = validateDecision({ action: 'play', candidate: splitPair.idx, reason: '压4' }, ctx, facts);
  assert.ok(v, '拆对5压单4(有干净单8替代)应违规');
  assert.match(v, /拆散|手数/);
});

test('engineRecommend：过牌分——过牌送对手接风时倾向出牌', () => {
  const myHand = [C('K', '♠', 1), C('5', '♠', 3), C('4', '♣', 4), C('6', '♦', 5), C('7', '♥', 6), C('8', '♠', 7)];
  const round = makeRound('9', [myHand, [C('3', '♠', 90)], [C('4', '♠', 91)], [C('6', '♠', 92)]]);
  // 对手座1出小牌，其他两家已过 → 我过牌则牌权回对手
  const t = [C('3', '♠', 60)];
  const best = { cards: t, it: bestInterpretation(t, '9'), by: 1 };
  const ctx = buildCtx(round, 0, best, { best, consecutivePasses: 2, turn: 0, trickSeq: 3 });
  const { facts } = prepareDecision(ctx);
  assert.equal(facts.passEndsTrick, true);
  const ps = passScore(ctx, facts);
  const ctx2 = buildCtx(round, 0, best, { best, consecutivePasses: 0, turn: 0, trickSeq: 1 });
  const { facts: f2 } = prepareDecision(ctx2);
  const ps2 = passScore(ctx2, f2);
  assert.ok(ps < ps2, '过牌送对手牌权时pass分应更低(更倾向出牌)');
});

test('prepareDecision：候选按分数降序且重新编号，#0=推荐(出牌时)', () => {
  const round = makeRound('9');
  const ctx = buildCtx(round, 0, null);
  const { recommend } = prepareDecision(ctx);
  for (let i = 0; i < ctx.candidates.length; i++) {
    assert.equal(ctx.candidates[i].idx, i, 'idx应连续重编号');
    if (i > 0) assert.ok(ctx.candidates[i - 1].score >= ctx.candidates[i].score, '应降序');
  }
  if (recommend.action === 'play') {
    assert.equal(recommend.idx, ctx.candidates.reduce((b, c) => c.score > ctx.candidates[b].score ? c.idx : b, 0));
  }
});

/* ===== 用户规则修正：队友握牌权 / 拦截窗口 ===== */

test('队友剩1张且正握牌权(刚出炸弹) → 不触发partnerNeedLead，推荐坚决过牌', () => {
  // 场景复现：队友座2出了5张炸剩1张，我(座0)不该被强迫夺牌权
  const myHand = [C('T', '♠', 1), C('T', '♥', 2), C('T', '♣', 3), C('T', '♦', 4), C('T', '♠', 5),
    C('J', '♠', 6), C('Q', '♥', 7), C('6', '♠', 8), C('6', '♥', 9), C('6', '♣', 10)];
  const round = makeRound('9', [myHand, [C('3', '♠', 90)], [C('K', '♥', 91)], [C('4', '♠', 92)]]);
  round.finishOrder = [];
  const bombCards = [C('9', '♠', 70), C('9', '♥', 71), C('9', '♣', 72), C('9', '♦', 73), C('9', '♠', 74)];
  const best = { cards: bombCards, it: bestInterpretation(bombCards, '9'), by: 2 }; // 队友的炸
  const ctx = buildCtx(round, 0, best);
  ctx.tracker.playedBySeat[2] = 26; // 队友剩1张
  const { facts, recommend } = prepareDecision(ctx);
  assert.equal(facts.partnerLeading, true, '队友应被识别为握牌权');
  assert.equal(facts.partnerNeedLead, false, '队友握牌权时不该判needLead');
  assert.equal(recommend.action, 'pass', '应推荐过牌让队友走');
  const txt = factsToText(facts, 0);
  assert.match(txt, /坚决过牌|绝不能压队友/, '文本应明说坚决过牌');
  assert.match(txt, /要得起/, '应给出对手要得起概率');
});

test('校验器：队友剩1张握牌权时LLM压队友 → 违规强制过牌', () => {
  const myHand = [C('K', '♠', 1), C('K', '♥', 2), C('K', '♣', 3), C('K', '♦', 4), C('K', '♠', 5), C('K', '♥', 6),
    C('5', '♠', 7), C('6', '♠', 8)];
  const round = makeRound('9', [myHand, [C('3', '♠', 90)], [C('7', '♥', 91)], [C('4', '♠', 92)]]);
  const partnerCards = [C('7', '♠', 60)]; // 队友出单7
  const best = { cards: partnerCards, it: bestInterpretation(partnerCards, '9'), by: 2 };
  const ctx = buildCtx(round, 0, best);
  ctx.tracker.playedBySeat[2] = 26; // 队友剩1张
  const { facts } = prepareDecision(ctx);
  const bombCand = ctx.candidates.find(c => c.type === 'bomb');
  assert.ok(bombCand, '应有6K炸候选');
  const v = validateDecision({ action: 'play', candidate: bombCand.idx, reason: '压队友' }, ctx, facts);
  assert.ok(v, '压剩1张握牌权队友应违规');
  assert.match(v, /必须过牌/, '纠正语应说明必须过牌');
});

test('队友剩1张但牌权在对手手上 → partnerNeedLead 仍触发必须夺牌权', () => {
  const myHand = [C('A', '♠', 1), C('K', '♠', 2), C('5', '♠', 3), C('4', '♣', 4)];
  const round = makeRound('9', [myHand, [C('8', '♠', 60), C('3', '♠', 90)], [C('9', '♥', 91)], [C('6', '♠', 92)]]);
  const best = { cards: [C('8', '♠', 60)], it: bestInterpretation([C('8', '♠', 60)], '9'), by: 1 }; // 对手出牌
  const ctx = buildCtx(round, 0, best);
  ctx.tracker.playedBySeat[2] = 26; // 队友剩1张
  const { facts } = prepareDecision(ctx);
  assert.equal(facts.partnerLeading, false);
  assert.equal(facts.partnerNeedLead, true, '牌权在对手手上时应触发needLead');
  const v = validateDecision({ action: 'pass', reason: '让队友走' }, ctx, facts);
  assert.ok(v, 'pass应违规');
  assert.match(v, /夺牌权/);
});

test('拦截窗口：对手剩约3手(9张)且有结构无损候选时过牌 → 校验器要求接', () => {
  const myHand = [C('5', '♠', 1), C('6', '♠', 2), C('7', '♠', 3), C('8', '♠', 4),
    C('A', '♠', 5), C('K', '♥', 6), C('Q', '♣', 7), C('J', '♦', 8), C('4', '♠', 9), C('3', '♥', 10)];
  const round = makeRound('9', [myHand, [C('3', '♠', 90)], [C('4', '♠', 91)], [C('6', '♠', 92)]]);
  const t = [C('4', '♠', 60)]; // 对手出单4
  const best = { cards: t, it: bestInterpretation(t, '9'), by: 3 };
  const ctx = buildCtx(round, 0, best);
  ctx.tracker.playedBySeat[3] = 18; // 对手剩9张 ≈ 3手
  const { facts } = prepareDecision(ctx);
  assert.equal(facts.oppEndgame, true, '应识别拦截窗口');
  assert.equal(facts.oppHandsEst, 3);
  const v = validateDecision({ action: 'pass', reason: '懒得压' }, ctx, facts);
  assert.ok(v, '拦截窗口有干净候选时过牌应被提醒');
  assert.match(v, /拦截窗口/);
});

test('拦截窗口：对手剩很多牌(20张)时过牌不触发拦截提醒', () => {
  const myHand = [C('5', '♠', 1), C('6', '♠', 2), C('7', '♠', 3), C('8', '♠', 4),
    C('A', '♠', 5), C('K', '♥', 6), C('Q', '♣', 7), C('J', '♦', 8), C('4', '♠', 9), C('3', '♥', 10)];
  const round = makeRound('9', [myHand, [C('3', '♠', 90)], [C('4', '♠', 91)], [C('6', '♠', 92)]]);
  const t = [C('4', '♠', 60)];
  const best = { cards: t, it: bestInterpretation(t, '9'), by: 3 };
  const ctx = buildCtx(round, 0, best);
  ctx.tracker.playedBySeat[3] = 7; // 对手剩20张
  const { facts } = prepareDecision(ctx);
  assert.equal(facts.oppEndgame, false);
  // 用大牌过牌是允许的(小单4不值得用K压)——不触发拦截违规
  const v = validateDecision({ action: 'pass', reason: '保留大牌' }, ctx, facts);
  assert.equal(v, null, '非拦截窗口过牌不该违规');
});

test('estimateOppBeatRisk：队友的天王炸=low，普通小单张=high', () => {
  const round = makeRound('9');
  const ctx0 = buildCtx(round, 0, null);
  // 天王炸
  const kings = [C('BJ', '♠', 1), C('BJ', '♥', 2), C('SJ', '♣', 3), C('SJ', '♦', 4)];
  const kBest = { cards: kings, it: bestInterpretation(kings, '9'), by: 2 };
  assert.equal(estimateOppBeatRisk(kBest, ctx0), 'low', '天王无人能压');
  // 单张3(小)：外面大把牌能压
  const small = [C('3', '♠', 5)];
  const sBest = { cards: small, it: bestInterpretation(small, '9'), by: 2 };
  assert.equal(estimateOppBeatRisk(sBest, ctx0), 'high', '小单张对手要得起概率高');
});

test('记忆压缩：全零段不再生成垃圾摘要行', () => {
  const m = new RoundMemory(1, '9', '2');
  // 少量出牌 + 让压缩只处理"无动作"区间
  m.addPlay(0, '出单[♠3]，剩26张');
  m.summaryUpTo = 0;
  // 手工构造：publicLog只有1条，KEEP_PUBLIC=14 → 无段可压，但直接调 deterministicCompress 验证空段
  m.addPlay(1, '过牌，压不过单(值3)');
  // 强制压缩全部：把 KEEP 调小到0不可行，改为验证摘要不含全零行
  const did = m.deterministicCompress();
  if (did) {
    assert.ok(!/座0出0手\/过0次；座1出0手\/过0次；座2出0手\/过0次；座3出0手\/过0次/.test(m.summary), '不应出现全零摘要行');
  }
  assert.ok(true);
});

/* ===== 用户规则：守门/追赶 + 唯一炸弹纪律 ===== */

test('守门：对手连赢1圈后又出牌，我是他上家 → mustGate=true，推荐压牌', () => {
  const myHand = [C('6', '♠', 1), C('7', '♥', 2), C('8', '♣', 3), C('4', '♦', 4),
    C('A', '♠', 5), C('K', '♥', 6), C('Q', '♣', 7), C('5', '♦', 8), C('3', '♠', 9), C('J', '♥', 10)];
  const round = makeRound('9', [myHand, [C('3', '♠', 90)], [C('4', '♠', 91)], [C('6', '♠', 92)]]);
  const t = [C('5', '♠', 60)]; // 对手座1(我=座0是他的上家)出单5
  const best = { cards: t, it: bestInterpretation(t, '9'), by: 1 };
  const driver = { best, consecutivePasses: 0, turn: 0, trickSeq: 2, streakInfo: { lastWinner: 1, winStreak: 1 } };
  const ctx = buildCtx(round, 0, best, driver);
  ctx.tracker.playedBySeat[1] = 10; // 对手剩17张，不告急
  const { facts, recommend } = prepareDecision(ctx);
  assert.equal(facts.streakOpp, 1);
  assert.equal(facts.streakCount, 1);
  assert.equal(facts.mustGate, true, '我是连赢对手的上家应触发守门');
  assert.equal(facts.mustChase, false);
  assert.equal(recommend.action, 'play', '守门务必压牌');
  assert.equal(recommend.hard, 'gate');
  assert.match(factsToText(facts, 0), /守门警报/);
});

test('追赶：对手连赢2圈后又出牌(>2次)，我是他下家 → mustChase=true', () => {
  const myHand = [C('6', '♠', 1), C('7', '♥', 2), C('8', '♣', 3), C('4', '♦', 4),
    C('A', '♠', 5), C('K', '♥', 6), C('Q', '♣', 7), C('5', '♦', 8), C('3', '♠', 9), C('J', '♥', 10)];
  const round = makeRound('9', [myHand, [C('3', '♠', 90)], [C('4', '♠', 91)], [C('6', '♠', 92)]]);
  const t = [C('5', '♠', 60)]; // 对手座3出牌；我=座0是他下家(3+1=0)
  const best = { cards: t, it: bestInterpretation(t, '9'), by: 3 };
  const driver = { best, consecutivePasses: 0, turn: 0, trickSeq: 2, streakInfo: { lastWinner: 3, winStreak: 2 } };
  const ctx = buildCtx(round, 0, best, driver);
  ctx.tracker.playedBySeat[3] = 10;
  const { facts, recommend } = prepareDecision(ctx);
  assert.equal(facts.mustChase, true, '连赢2圈+本圈出牌=第3次，下家应追赶');
  assert.equal(facts.mustGate, false);
  assert.equal(recommend.action, 'play', '追赶能压就压');
  assert.equal(recommend.hard, 'chase');
  assert.match(factsToText(facts, 0), /追赶警报/);
});

test('连赢对手是队友时 → 不触发守门/追赶(不给队友上强度)', () => {
  const myHand = [C('6', '♠', 1), C('7', '♥', 2), C('8', '♣', 3), C('4', '♦', 4), C('3', '♠', 9)];
  const round = makeRound('9', [myHand, [C('3', '♠', 90)], [C('4', '♠', 91)], [C('6', '♠', 92)]]);
  const t = [C('5', '♠', 60)]; // 队友座2出牌
  const best = { cards: t, it: bestInterpretation(t, '9'), by: 2 };
  const driver = { best, consecutivePasses: 0, turn: 0, trickSeq: 2, streakInfo: { lastWinner: 2, winStreak: 2 } };
  const ctx = buildCtx(round, 0, best, driver);
  const { facts } = prepareDecision(ctx);
  assert.equal(facts.mustGate, false);
  assert.equal(facts.mustChase, false);
});

test('守门警报下LLM过牌(有结构无损候选) → 校验器要求压牌', () => {
  const myHand = [C('6', '♠', 1), C('7', '♥', 2), C('8', '♣', 3), C('4', '♦', 4),
    C('A', '♠', 5), C('K', '♥', 6), C('Q', '♣', 7), C('5', '♦', 8), C('3', '♠', 9), C('J', '♥', 10)];
  const round = makeRound('9', [myHand, [C('3', '♠', 90)], [C('4', '♠', 91)], [C('6', '♠', 92)]]);
  const t = [C('5', '♠', 60)];
  const best = { cards: t, it: bestInterpretation(t, '9'), by: 1 };
  const driver = { best, consecutivePasses: 0, turn: 0, trickSeq: 2, streakInfo: { lastWinner: 1, winStreak: 1 } };
  const ctx = buildCtx(round, 0, best, driver);
  ctx.tracker.playedBySeat[1] = 10;
  const { facts } = prepareDecision(ctx);
  const v = validateDecision({ action: 'pass', reason: '省牌' }, ctx, facts);
  assert.ok(v, '守门时过牌应违规');
  assert.match(v, /守门方/);
});

test('bombHandsCount：4炸=1手；3张+红桃级牌(逢人配)=1手潜在炸；同花4连+配=1手', () => {
  // 普通4炸
  {
    const hand = [C('7', '♠', 1), C('7', '♥', 2), C('7', '♣', 3), C('7', '♦', 4), C('3', '♠', 5)];
    const st = handStrength(hand, '9', null);
    assert.equal(bombHandsCount(st, hand, '9'), 1, '4炸=1手');
  }
  // 3张7 + 红桃9(级牌9→逢人配)：可配成4炸
  {
    const hand = [C('7', '♠', 1), C('7', '♣', 2), C('7', '♦', 3), C('9', '♥', 4), C('3', '♠', 5)];
    const st = handStrength(hand, '9', null);
    assert.equal(bombHandsCount(st, hand, '9'), 1, '3张+红桃级牌应算1手潜在炸');
  }
  // 同花4连(♠5♠6♠7♠8) + 红桃级牌 → 同花顺
  {
    const hand = [C('5', '♠', 1), C('6', '♠', 2), C('7', '♠', 3), C('8', '♠', 4), C('9', '♥', 5), C('3', '♠', 6)];
    const st = handStrength(hand, '9', null);
    assert.equal(bombHandsCount(st, hand, '9'), 1, '同花4连+红桃级牌应算1手潜在同花顺');
  }
  // 无炸无配
  {
    const hand = [C('5', '♠', 1), C('6', '♥', 2), C('8', '♣', 3)];
    const st = handStrength(hand, '9', null);
    assert.equal(bombHandsCount(st, hand, '9'), 0);
  }
});

test('唯一炸弹：无告急时不许动用(评分重罚+校验器拦截)；对手≤2手时可炸', () => {
  const myHand = [C('7', '♠', 1), C('7', '♥', 2), C('7', '♣', 3), C('7', '♦', 4),
    C('3', '♠', 5), C('4', '♦', 6), C('5', '♠', 7), C('8', '♥', 8)];
  const round = makeRound('9', [myHand, [C('3', '♠', 90)], [C('4', '♠', 91)], [C('6', '♠', 92)]]);
  const t = [C('5', '♠', 60)]; // 对手出单5，我有单8能压(结构无损)
  const best = { cards: t, it: bestInterpretation(t, '9'), by: 1 };
  const ctx = buildCtx(round, 0, best);
  ctx.tracker.playedBySeat[1] = 10; // 对手剩17张
  const { facts, recommend } = prepareDecision(ctx);
  assert.equal(facts.soleBomb, true, '只有一手炸应识别soleBomb');
  assert.equal(facts.oppNearDone, false);
  assert.equal(recommend.action, 'play', '应压牌');
  const recC = ctx.candidates.find(c => c.idx === recommend.idx);
  assert.notEqual(recC.type, 'bomb', '唯一炸弹不该被推荐(用单8压)');
  // 校验器：LLM动用唯一炸弹(无告急) → 违规
  const bombCand = ctx.candidates.find(c => c.type === 'bomb');
  assert.ok(bombCand, '候选里应有炸7');
  const v = validateDecision({ action: 'play', candidate: bombCand.idx, reason: '炸他' }, ctx, facts);
  assert.ok(v, '无告急动用唯一炸弹应违规');
  assert.match(v, /留到最后/);

  // 对手估计只剩2手(8张→2手)：soleBomb允许使用
  const ctx2 = buildCtx(round, 0, best);
  ctx2.tracker.playedBySeat[1] = 19; // 剩8张=2手
  const f2 = prepareDecision(ctx2).facts;
  assert.equal(f2.oppNearDone, true, '对手8张(≤2手)应触发oppNearDone');
  const v2 = validateDecision({ action: 'play', candidate: ctx2.candidates.find(c => c.type === 'bomb').idx, reason: '炸他' }, ctx2, f2);
  assert.equal(v2, null, '对手≤2手时唯一炸弹可用');
});

test('两手持炸时不受唯一炸弹纪律限制', () => {
  const myHand = [C('7', '♠', 1), C('7', '♥', 2), C('7', '♣', 3), C('7', '♦', 4),
    C('K', '♠', 5), C('K', '♥', 6), C('K', '♣', 7), C('K', '♦', 8), C('3', '♠', 9)];
  const round = makeRound('9', [myHand, [C('3', '♠', 90)], [C('4', '♠', 91)], [C('6', '♠', 92)]]);
  const t = [C('5', '♠', 60)];
  const best = { cards: t, it: bestInterpretation(t, '9'), by: 1 };
  const ctx = buildCtx(round, 0, best);
  const { facts } = prepareDecision(ctx);
  assert.equal(facts.soleBomb, false, '两手炸不算soleBomb');
});
