import test from 'node:test';
import assert from 'node:assert/strict';
import { Round } from '../engine/game.js';
import { seatPermutation } from '../engine/match.js';

const C = (suit, rank, id) => ({ id: id ?? suit + rank, suit, rank });

function buildRound(hands, teamOf, level, tug) {
  const r = new Round(['A', 'B', 'C', 'D'], teamOf, Math.random);
  r.level = level;
  r.tug = tug;
  r.hands = hands;
  r.state = 'playing';
  r.lead = 0;
  return r;
}

test('双上+双拖：头游对2(2级)+二游单2(1级)，基础3 → 共6级', () => {
  let n = 0;
  const T = s => ({ id: 't' + (n++), suit: s, rank: '2' });
  // 队伍 [0,1,0,1]：0/2 一队（赢家），1/3 一队
  const hands = [
    [T('♠'), T('♣')],        // seat0 头游：脱手对2（2张普通拖=2级）
    [T('♠'), T('♦')],        // seat1 三游：剩2张（双下才计，本例双上不罚三游？双上=对方双下→三游+末游全罚）
    [T('♣')],                 // seat2 二游：脱手单2（1级）
    [T('♠')],                 // seat3 末游：剩1张（+1罚）
  ];
  const r = buildRound(hands, [0, 1, 0, 1], '9', '2');
  r.led = true; // 构造局面：首攻已出，不受禁拖限制
  const p0 = hands[0].slice(), p2 = hands[2].slice();
  assert.ok(r.act(0, p0).ok);
  r.lead = 2; r.trick = null;
  assert.ok(r.act(2, p2).ok);
  r.finishOrder = [0, 2, 1, 3];
  r.state = 'finished';
  const res = r.settle({ 0: p0, 2: p2 });
  assert.equal(res.base, 3);       // 双上
  assert.equal(res.tugBonus, 3);   // 头游2 + 二游1
  assert.equal(res.leftover, 3);   // 双下→三游2张+末游1张，每张+1
  assert.equal(res.total, 9);      // 3+3+3=9 ≤13
});

test('非双上：仅头游算拖分，二游纯拖不计', () => {
  let n = 0;
  const T = s => ({ id: 't' + (n++), suit: s, rank: '2' });
  // 名次：头游0(队0)、二游1(队1)、三游2(队0) → 一三 base=2
  const hands = [
    [T('♠'), T('♣')],   // seat0 头游：脱手对2 = 2级 ✓
    [T('♥')],            // seat1 二游：脱手红2 → 非双上不计分
    [C('♠', 'K')],       // seat2 三游
    [C('♠', 'Q'), C('♠', '2')], // seat3 末游：剩1张拖 +1罚
  ];
  const r = buildRound(hands, [0, 1, 0, 1], '9', '2');
  r.led = true;
  const p0 = hands[0].slice(), p1 = hands[1].slice();
  assert.ok(r.act(0, p0).ok);
  r.lead = 1; r.trick = null;
  assert.ok(r.act(1, p1).ok);
  r.lead = 2; r.trick = null;
  assert.ok(r.act(2, hands[2].slice()).ok);
  r.finishOrder = [0, 1, 2, 3];
  r.state = 'finished';
  const res = r.settle({ 0: p0, 1: p1 });
  assert.equal(res.base, 2);
  assert.equal(res.tugBonus, 2);   // 仅头游对2=2级，二游红2不计
  assert.equal(res.leftover, 1);   // 仅末游1张
  assert.equal(res.total, 5);
});

test('红桃拖每张+2级（拖牌奖励部分）', () => {
  let n = 0;
  const T = s => ({ id: 't' + (n++), suit: s, rank: '2' });
  // 一四：头游0(队0)、二游1(队1)、三游3(队1)、末游2(队0)
  const hands = [
    [T('♥'), T('♠')],   // seat0 头游：红拖(2级)+普通拖(1级)=3级
    [C('♠', 'K')],       // seat1 二游
    [C('♠', 'Q')],       // seat2 末游（队0，自己人，剩♠Q非拖）
    [C('♠', 'J')],       // seat3 三游
  ];
  const r = buildRound(hands, [0, 1, 0, 1], '9', '2');
  r.led = true;
  const p0 = hands[0].slice();
  assert.ok(r.act(0, p0).ok);
  r.lead = 1; r.trick = null;
  assert.ok(r.act(1, hands[1].slice()).ok);
  r.lead = 3; r.trick = null;
  assert.ok(r.act(3, hands[3].slice()).ok);
  r.finishOrder = [0, 1, 3, 2];
  r.state = 'finished';
  const res = r.settle({ 0: p0 });
  assert.equal(res.base, 1);
  assert.equal(res.tugBonus, 3);   // 红2=2级 + ♠2=1级
  assert.equal(res.leftover, 0);   // 末游无剩余拖牌
  assert.equal(res.total, 4);
});

test('总分封顶13级', () => {
  let n = 0;
  const T = s => ({ id: 't' + (n++), suit: s, rank: '2' });
  const H = s => ({ id: 'h' + (n++), suit: s, rank: '2' }); // 红拖
  // 双上：头游脱手4张拖炸(含2红=6级)，二游脱手对2(2级)，基础3 → 11；末游剩3张拖 → +3 = 14 > 13 → 封顶13
  const hands = [
    [T('♠'), T('♣'), H('♥'), { id: 'w1', suit: '♥', rank: '2' }], // 头游：2普通+2红 = 2+4=6级
    [T('♠'), T('♦')],       // 三游：剩2张
    [T('♣'), T('♠')],       // 二游：脱手对2 = 2级
    [T('♠'), T('♣'), T('♦')], // 末游：剩3张
  ];
  const r = buildRound(hands, [0, 1, 0, 1], '9', '2');
  r.led = true;
  const p0 = hands[0].slice(), p2 = hands[2].slice();
  assert.ok(r.act(0, p0).ok);
  r.lead = 2; r.trick = null;
  assert.ok(r.act(2, p2).ok);
  r.finishOrder = [0, 2, 1, 3];
  r.state = 'finished';
  const res = r.settle({ 0: p0, 2: p2 });
  assert.equal(res.base, 3);
  assert.equal(res.tugBonus, 8);   // 6 + 2
  assert.equal(res.leftover, 5);   // 双下：2 + 3
  assert.equal(res.total, 13);     // 3+8+5=16 → 封顶13
  assert.equal(res.capped, true);
});

test('首攻不允许直接出纯拖牌', () => {
  const r = buildRound([[C('♠', '2')], [C('♠', 'K')], [C('♠', 'Q')], [C('♠', 'J')]], [0, 1, 0, 1], '9', '2');
  const ev = r.act(0, [C('♠', '2')]);
  assert.equal(ev.ok, false);
  assert.match(ev.error, /首攻/);
});

test('头游末手纯拖牌不可被压（强制接风）', () => {
  let n = 0;
  const T = s => ({ id: 't' + (n++), suit: s, rank: '2' });
  const r = buildRound([[T('♠')], [C('♠', 'A')], [C('♠', 'K')], [C('♠', 'Q')]], [0, 1, 0, 1], '9', '2');
  // seat0 先出 K（非拖，首攻合法），然后打光……构造：seat0 头游脱手单拖
  // 简化：seat1 先领出 A，seat0 用单2接不了（2最小）——改用：seat0 首攻 K 不行（手里只有2）
  // 直接测锁定逻辑：手工构造
  r.hands = [[T('♠')], [C('♠', 'A')], [C('♠', 'K')], [C('♠', 'Q')]];
  r.led = true;
  const ev = r.act(0, [r.hands[0][0]]); // 头游脱手纯拖
  assert.ok(ev.ok);
  assert.equal(ev.tugLocked, true);
  // seat1 想压 A 也不行
  r.lead = 1;
  const ev2 = r.act(1, [C('♠', 'A')]);
  assert.equal(ev2.ok, false);
  assert.match(ev2.error, /不可压制/);
});

test('座位重排：队友对角', () => {
  const perm = seatPermutation([0, 0, 1, 1]);
  assert.deepEqual(perm, [0, 3, 1, 2]);
  const perm2 = seatPermutation([1, 0, 1, 0]);
  assert.deepEqual(perm2, [0, 1, 2, 3]);
  const perm3 = seatPermutation([1, 1, 0, 0]);
  assert.deepEqual(perm3, [2, 1, 3, 0]);
  for (const teamOf of [[0,0,1,1],[0,1,0,1],[0,1,1,0],[1,0,0,1],[1,0,1,0],[1,1,0,0]]) {
    const p = seatPermutation(teamOf);
    assert.equal(teamOf[p[0]], teamOf[p[2]], '新座位0/2同队: ' + JSON.stringify(teamOf));
    assert.equal(teamOf[p[1]], teamOf[p[3]], '新座位1/3同队: ' + JSON.stringify(teamOf));
  }
});
