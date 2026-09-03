import test from 'node:test';
import assert from 'node:assert/strict';
import { Round } from '../engine/game.js';
import { seatPermutation } from '../engine/match.js';

const C = (suit, rank) => ({ id: suit + rank, suit, rank });

function buildRound(hands, teamOf, level, tug) {
  const r = new Round(['A', 'B', 'C', 'D'], teamOf, Math.random);
  r.level = level;
  r.tug = tug;
  r.hands = hands;
  r.state = 'playing';
  r.lead = 0;
  return r;
}

test('安徽拖2算级：双下3 + 头游拖2个2(2级) + 二游拖1个2(1级) + 三游末游剩4个2(4级) = 10级', () => {
  // 打9（拖2）。队伍 [0,1,0,1]：0/2 一队，1/3 一队
  // 名次：头游0、二游2（双下）；三游1剩♠2♦2、末游3剩♠2♣2（全部普通拖，无红拖）
  let n = 0;
  const C2 = (suit) => ({ id: 't' + (n++), suit, rank: '2' });
  const hands = [
    [C2('♠'), C2('♣')],              // seat0 头游：脱手2个普通2 = 2级
    [C2('♠'), C2('♦')],              // seat1 三游：剩2个2 = 2级
    [C2('♣')],                        // seat2 二游：脱手1个普通2 = 1级
    [C2('♠'), C2('♣')],              // seat3 末游：剩2个2 = 2级
  ];
  const r = buildRound(hands, [0, 1, 0, 1], '9', '2');

  const p0 = hands[0].slice(), p2 = hands[2].slice(); // 先复制（act 会清空原数组）
  let ev = r.act(0, p0);
  assert.ok(ev.ok, ev.error);
  r.lead = 2; r.trick = null;
  ev = r.act(2, p2);
  assert.ok(ev.ok, ev.error);
  // seat1 剩2个2未出完 → 三游；seat3 剩2个2 → 末游
  r.finishOrder = [0, 2, 1, 3];
  r.state = 'finished';

  const res = r.settle({ 0: p0, 2: p2 });
  assert.equal(res.base, 3);        // 双下
  assert.equal(res.tugBonus, 3);    // 头游2级 + 二游1级
  assert.equal(res.leftover, 4);    // 三游2 + 末游2
  assert.equal(res.total, 10);      // 3 + 3 + 4 = 10 ✓（用户示例）
});

test('红拖算2级（一三局面）', () => {
  // 名次：头游0、二游1（队1）、三游2（队0）、末游3（队1）→ 一三 base=2
  const hands = [
    [C('♥', '2')],                    // seat0 头游：红拖脱手 = 2级
    [C('♠', '5')],                    // seat1 二游
    [C('♠', 'K')],                    // seat2 三游
    [C('♥', '2'), C('♠', '2')],       // seat3 末游：红拖2级 + 普通拖1级 = 3级
  ];
  const r = buildRound(hands, [0, 1, 0, 1], '9', '2');

  let ev = r.act(0, [C('♥', '2')]);
  assert.ok(ev.ok);
  r.lead = 1; r.trick = null;
  ev = r.act(1, [C('♠', '5')]);
  assert.ok(ev.ok);
  r.lead = 2; r.trick = null;
  ev = r.act(2, [C('♠', 'K')]);
  assert.ok(ev.ok);
  // seat3 自动末游
  r.state = 'finished';
  assert.deepEqual(r.finishOrder, [0, 1, 2, 3]);

  const res = r.settle({ 0: [C('♥', '2')] });
  assert.equal(res.base, 2);        // 一三
  assert.equal(res.tugBonus, 2);    // 头游红拖
  assert.equal(res.leftover, 3);    // 末游 ♥2(2级) + ♠2(1级)
  assert.equal(res.total, 7);
});

test('一四升1级，无拖无剩余', () => {
  // 名次：头游0、二游1（队1）、三游3（队1）、末游2（队0剩♠Q）→ 一四 base=1
  const hands = [
    [C('♠', 'A')],              // seat0 头游（队0）
    [C('♠', 'K')],              // seat1 二游（队1）
    [C('♠', 'Q')],              // seat2 末游（队0）剩♠Q非拖
    [C('♠', 'J')],              // seat3 三游（队1）
  ];
  const r = buildRound(hands, [0, 1, 0, 1], '9', '2');
  let ev = r.act(0, [C('♠', 'A')]);
  assert.ok(ev.ok);
  r.lead = 1; r.trick = null;
  ev = r.act(1, [C('♠', 'K')]);
  assert.ok(ev.ok);
  r.lead = 3; r.trick = null;
  ev = r.act(3, [C('♠', 'J')]);
  assert.ok(ev.ok);
  r.state = 'finished';
  assert.deepEqual(r.finishOrder, [0, 1, 3, 2]);

  const res = r.settle({ 0: [C('♠', 'A')] });
  assert.equal(res.base, 1);        // 一四
  assert.equal(res.tugBonus, 0);
  assert.equal(res.leftover, 0);
  assert.equal(res.total, 1);
});

test('座位重排：队友对角', () => {
  // 队伍 [0,0,1,1]（0队相邻坐0/1）→ 重排后对角；旧0不动，旧1移到对面
  const perm = seatPermutation([0, 0, 1, 1]);
  assert.deepEqual(perm, [0, 3, 1, 2]);
  // 队伍 [1,0,1,0] 本就是对角 → 全员不动
  const perm2 = seatPermutation([1, 0, 1, 0]);
  assert.deepEqual(perm2, [0, 1, 2, 3]);
  // 队伍 [1,1,0,0]：0队相邻坐2/3 → 旧2不动，旧3移到对面
  const perm3 = seatPermutation([1, 1, 0, 0]);
  assert.deepEqual(perm3, [2, 1, 3, 0]);
  // 所有排列结果都满足对角不变量
  for (const teamOf of [[0,0,1,1],[0,1,0,1],[0,1,1,0],[1,0,0,1],[1,0,1,0],[1,1,0,0]]) {
    const p = seatPermutation(teamOf);
    assert.equal(teamOf[p[0]], teamOf[p[2]], '新座位0/2同队: ' + JSON.stringify(teamOf));
    assert.equal(teamOf[p[1]], teamOf[p[3]], '新座位1/3同队: ' + JSON.stringify(teamOf));
  }
});
