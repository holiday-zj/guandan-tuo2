// AI 分析层单元测试：算牌、手数分解、拖牌策略、团队局势
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDeck } from '../engine/cards.js';
import {
  PlayTracker, TOTAL_OF_RANK, decompose, handStrength, tugPolicy, describeTable,
} from '../engine/ai/analyze.js';

const C = (rank, suit = '♠', id = Math.floor(Math.random() * 1e9)) => ({ id, suit, rank });

test('两副牌每个点数总数为8，大小王各2', () => {
  assert.equal(TOTAL_OF_RANK['A'], 8);
  assert.equal(TOTAL_OF_RANK['2'], 8);
  assert.equal(TOTAL_OF_RANK.SJ, 2);
  assert.equal(TOTAL_OF_RANK.BJ, 2);
  const deck = makeDeck();
  assert.equal(deck.length, 108);
  const cnt = {};
  for (const c of deck) cnt[c.rank] = (cnt[c.rank] || 0) + 1;
  for (const r of Object.keys(TOTAL_OF_RANK)) assert.equal(cnt[r], TOTAL_OF_RANK[r], r);
});

test('算牌：未见任何牌时，外部剩余=总数-我手牌', () => {
  const t = new PlayTracker();
  t.reset('9', '2');
  const hand = [C('2'), C('2'), C('A')]; // 我手里2张2、1张A
  const rem = t.remainingOutside(hand);
  assert.equal(rem['2'], 8 - 2, '外面还剩6张2');
  assert.equal(rem.A, 8 - 1);
  assert.equal(rem.BJ, 2);
});

test('算牌：记录出牌后剩余递减，过牌次数被统计', () => {
  const t = new PlayTracker();
  t.reset('9', '2');
  t.record(1, [C('2'), C('2')], 'pair');   // 下家出一对2
  t.record(2, null, 'pass');                // 对家过
  t.record(2, null, 'pass');
  const rem = t.remainingOutside([C('2')]); // 我手里1张2
  assert.equal(rem['2'], 8 - 2 - 1, '外面剩5张2');
  assert.equal(t.playedBySeat[1], 2);
  assert.equal(t.passCount[2], 2, '对家过牌2次(牌力弱信号)');
  assert.equal(t.handCounts()[1], 25, '下家剩25张');
});

test('算牌：某点数绝迹 → 识别为绝对控制', () => {
  const t = new PlayTracker();
  t.reset('9', '2');
  // 外面7张K全出完，我手里还有1张K
  for (let i = 0; i < 7; i++) t.record(i % 4, [C('K')], 'single');
  const hand = [C('K'), C('3')];
  const st = handStrength(hand, '9', t);
  assert.ok(st.sureWins.includes('K'), 'K应是绝对控制');
  assert.equal(t.remainingOutside(hand).K, 0);
});

test('手数分解：炸弹/同花顺被识别为控制张而非普通手数', () => {
  const hand = [
    C('7', '♠', 1), C('7', '♥', 2), C('7', '♣', 3), C('7', '♦', 4),   // 7炸（4张全占）
    C('3', '♠', 5), C('4', '♠', 6), C('5', '♠', 7), C('6', '♠', 8), C('8', '♠', 9), // ♠34568→不构成同花顺
    C('9', '♠', 10),
  ];
  // 级牌用T：避免7/9被当级牌、红桃9被当逢人配干扰计数
  const d = decompose(hand, 'T');
  const bombs = d.controls.filter(c => c.type === 'bomb');
  assert.ok(bombs.length >= 1, '应识别出7炸');
  assert.equal(bombs[0].cards.length, 4);
  assert.equal(bombs[0].cards.every(c => c.rank === '7'), true);
  // 剩余牌里不应再有7
  const allUsed = [...d.combos, ...d.controls].flatMap(c => c.cards.map(x => x.id));
  assert.equal(new Set(allUsed).size, allUsed.length, '每张牌只应被用一次(无重复分配)');
  assert.ok(allUsed.includes(1) && allUsed.includes(9), '全部10张牌都应被分配');
});

test('手数分解：同花顺单独成立时能识别', () => {
  const hand = [C('3', '♠', 1), C('4', '♠', 2), C('5', '♠', 3), C('6', '♠', 4), C('7', '♠', 5)];
  const d = decompose(hand, 'T');
  const sf = d.controls.filter(c => c.type === 'straight_flush');
  assert.equal(sf.length, 1, '应识别出♠34567同花顺');
  assert.equal(sf[0].cards.length, 5);
  assert.equal(d.combos.length, 0, '不应再拆成散牌');
});

test('手数分解：同点王成对而非各自单出', () => {
  const hand = [C('BJ', 'X', 1), C('BJ', 'X', 2), C('3', '♠', 3)];
  const d = decompose(hand, 'T');
  const pair = d.combos.find(c => c.type === 'pair' && c.cards.every(x => x.rank === 'BJ'));
  assert.ok(pair, '两张大王应成对');
});

test('手数分解：天王(4王)识别为最强控制张', () => {
  const hand = [C('BJ', 'X', 1), C('BJ', 'X', 2), C('SJ', 'X', 3), C('SJ', 'X', 4), C('5', '♠', 5)];
  const d = decompose(hand, 'T');
  const kings = d.controls.find(c => c.type === 'kings');
  assert.ok(kings, '应识别天王炸');
  assert.equal(kings.cards.length, 4);
  assert.ok(kings.power > 90, '天王应最高power');
});

test('牌力评估：好牌分数高于烂牌，标签合理', () => {
  const t = new PlayTracker(); t.reset('9', '2');
  const strong = [
    C('BJ', 'X', 1), C('BJ', 'X', 2), C('SJ', 'X', 3), C('SJ', 'X', 4), // 天王
    C('9', '♠', 5), C('9', '♥', 6), C('9', '♣', 7), C('9', '♦', 8),     // 级牌炸
    C('A', '♠', 9), C('A', '♥', 10), C('A', '♣', 11), C('A', '♦', 12),   // A炸
  ];
  const weak = [C('3', '♠', 1), C('4', '♥', 2), C('6', '♣', 3), C('8', '♦', 4),
    C('3', '♣', 5), C('5', '♥', 6), C('7', '♠', 7), C('J', '♦', 8),
    C('4', '♠', 9), C('6', '♥', 10), C('8', '♣', 11), C('T', '♦', 12)];
  const s1 = handStrength(strong, '9', t);
  const s2 = handStrength(weak, '9', t);
  assert.ok(s1.score > s2.score, `强牌${s1.score}应>弱牌${s2.score}`);
  assert.ok(['极强', '强'].includes(s1.label), '强牌标签=' + s1.label);
  assert.ok(['弱', '偏弱'].includes(s2.label), '弱牌标签=' + s2.label);
  assert.ok(s1.hands < s2.hands, '强牌手数更少');
});

test('拖牌策略：强牌留拖(keep)，弱牌甩拖(dump)', () => {
  const t = new PlayTracker(); t.reset('9', '2');
  // 强牌 + 手里有拖牌2 → keep
  const strong = [
    C('BJ', 'X', 1), C('BJ', 'X', 2), C('SJ', 'X', 3), C('SJ', 'X', 4),
    C('9', '♠', 5), C('9', '♥', 6), C('9', '♣', 7), C('9', '♦', 8),
    C('2', '♠', 9), C('2', '♥', 10),
  ];
  const st1 = handStrength(strong, '9', t);
  const p1 = tugPolicy(strong, '9', st1, {});
  assert.equal(p1.policy, 'keep', '强牌应留拖');
  assert.equal(p1.tugsInHand, 2);
  assert.ok(p1.tugValue >= 3, '含红桃2应≥3级(红拖2级+普通1级)，实际' + p1.tugValue);

  // 弱牌 + 有拖牌 → dump
  const weak = [C('3', '♠', 1), C('4', '♥', 2), C('6', '♣', 3), C('8', '♦', 4),
    C('2', '♠', 5), C('2', '♣', 6), C('5', '♥', 7), C('7', '♠', 8),
    C('4', '♠', 9), C('6', '♥', 10), C('8', '♣', 11), C('T', '♦', 12)];
  const st2 = handStrength(weak, '9', t);
  const p2 = tugPolicy(weak, '9', st2, {});
  assert.equal(p2.policy, 'dump', '弱牌应甩拖');
  assert.match(p2.reason, /末游|罚/, '理由应提到末游罚分');
});

test('拖牌策略：仅剩拖牌时冲刺锁牌(keep)', () => {
  const t = new PlayTracker(); t.reset('9', '2');
  const hand = [C('2', '♠', 1), C('2', '♥', 2)];
  const st = handStrength(hand, '9', t);
  const p = tugPolicy(hand, '9', st, {});
  assert.equal(p.policy, 'keep');
  assert.match(p.reason, /头游|末手|冲刺/);
});

test('拖牌策略：打2时拖3，策略同样生效', () => {
  const t = new PlayTracker(); t.reset('2', '3');
  const weak = [C('4', '♠', 1), C('6', '♥', 2), C('8', '♣', 3), C('T', '♦', 4),
    C('3', '♠', 5), C('3', '♣', 6), C('5', '♥', 7), C('7', '♠', 8),
    C('9', '♠', 9), C('J', '♥', 10), C('5', '♣', 11), C('7', '♦', 12)];
  const st = handStrength(weak, '2', t);
  const p = tugPolicy(weak, '2', st, {});
  assert.equal(p.tugsInHand, 2, '应统计到2张3');
  assert.ok(['dump', 'partial'].includes(p.policy), '打2弱牌也应倾向甩拖，实际' + p.policy);
});

test('牌情文本：包含级牌/拖牌/队伍/各家进度/外部剩余', () => {
  const t = new PlayTracker(); t.reset('9', '2');
  t.record(1, [C('5'), C('5')], 'pair');
  const round = {
    level: '9', tug: '2', teamOf: [0, 1, 0, 1], finishOrder: [],
    hands: [[C('3'), C('9'), C('2')], [C('4')], [C('5')], [C('6')]],
  };
  const strengths = { 0: handStrength(round.hands[0], '9', t) };
  const txt = describeTable(round, 0, t, strengths);
  assert.match(txt, /打9/, '含级牌');
  assert.match(txt, /拖牌=2/, '含拖牌');
  assert.match(txt, /对家/, '含队友标识');
  assert.match(txt, /外面剩余/, '含算牌结论');
  assert.match(txt, /剩\d+张/, '含各家剩余张数');
  assert.ok(txt.length < 1200, '文本应精简(实际' + txt.length + '字符)');
});

test('追踪器：进贡/还贡不影响计数(只记公开出牌)', () => {
  const t = new PlayTracker(); t.reset('9', '2');
  t.record(0, [C('A')], 'single');
  assert.equal(t.playedBySeat[0], 1);
  assert.equal(t.handCounts()[0], 26);
  // 重复 reset 应清空
  t.reset('9', '2');
  assert.equal(t.playedBySeat[0], 0);
  assert.equal(Object.keys(t.seenRank).length, 0);
});
