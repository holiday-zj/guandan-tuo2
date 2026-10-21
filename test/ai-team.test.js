// 回归：队友必须是"对角"（0/2一队、1/3一队），前后相邻座位必为对手
// 规则由用户明确：0/1/2/3 位中 0与2是队友、1与3是队友
import test from 'node:test';
import assert from 'node:assert/strict';
import { seatPermutation } from '../engine/match.js';
import { teamSituation, describeTable } from '../engine/ai/analyze.js';
import { PlayTracker } from '../engine/ai/analyze.js';

const PARTNER = s => (s + 2) % 4;

test('规则：每个座位的队友都是对角(+2)，前后相邻都是对手', () => {
  for (let seat = 0; seat < 4; seat++) {
    const partner = PARTNER(seat);
    assert.equal(partner, (seat + 2) % 4);
    assert.notEqual(partner, (seat + 1) % 4, '下家不能是队友');
    assert.notEqual(partner, (seat + 3) % 4, '上家不能是队友');
  }
  // 具体断言用户给的规则
  assert.equal(PARTNER(0), 2, '0的队友是2');
  assert.equal(PARTNER(1), 3, '1的队友是3');
  assert.equal(PARTNER(2), 0, '2的队友是0');
  assert.equal(PARTNER(3), 1, '3的队友是1');
});

test('seatPermutation 总把队伍0排到0/2、队伍1排到1/3', () => {
  const cases = [
    [0, 1, 0, 1], // 已对角
    [0, 0, 1, 1], // 相邻同队 → 需重排
    [1, 0, 1, 0], // 已对角(反队)
    [1, 1, 0, 0], // 相邻同队 → 需重排
    [0, 1, 1, 0], // 0/3一队 → 需重排
    [1, 0, 0, 1], // 1/2? 实为 1,0,0,1 → 0与3? 需重排
  ];
  for (const teamOf of cases) {
    const perm = seatPermutation(teamOf);
    // perm[新座位] = 旧座位；重排后新座位0/2必须同队、1/3同队
    const newTeam = [0, 1, 2, 3].map(newSeat => teamOf[perm[newSeat]]);
    assert.equal(newTeam[0], newTeam[2], `${teamOf} 重排后 0与2 应同队，实为 ${newTeam}`);
    assert.equal(newTeam[1], newTeam[3], `${teamOf} 重排后 1与3 应同队，实为 ${newTeam}`);
    assert.notEqual(newTeam[0], newTeam[1], `${teamOf} 重排后 0与1 应为对手`);
  }
});

function mkRound(teamOf) {
  return {
    level: '9', tug: '2', teamOf, finishOrder: [],
    hands: [[], [], [], []],
  };
}

test('teamSituation 认定的 partner 恒为对角，opps 恒为相邻两家', () => {
  for (const teamOf of [[0, 1, 0, 1], [1, 0, 1, 0]]) {
    for (let seat = 0; seat < 4; seat++) {
      const t = new PlayTracker(); t.reset('9', '2');
      const sit = teamSituation(seat, mkRound(teamOf), t, {});
      assert.equal(sit.partner, PARTNER(seat), `seat${seat} 的 partner 应为对角`);
      assert.deepEqual(sit.opps.sort(), [(seat + 1) % 4, (seat + 3) % 4].sort(),
        `seat${seat} 的对手应为相邻两家`);
      // 对角必同队
      assert.equal(teamOf[sit.partner], teamOf[seat], '对角必须同队');
      // 相邻必为对手
      for (const o of sit.opps) assert.notEqual(teamOf[o], teamOf[seat], '相邻座位必须是对手');
    }
  }
});

test('describeTable 文本：对家标注为队友，上下家标注为对手', () => {
  const teamOf = [0, 1, 0, 1];
  const t = new PlayTracker(); t.reset('9', '2');
  const txt = describeTable(mkRound(teamOf), 0, t, {});
  assert.match(txt, /对家=2队0\(同队\)/, '座位0的对家应是2且同队');
  assert.match(txt, /对家\(队友\)/);
  assert.match(txt, /下家\(对手\)/);
  assert.match(txt, /上家\(对手\)/);
  assert.ok(!txt.includes('非同队'), '对角同队时不应出现"非同队"警告');
});

test('describeTable 在 teamOf 异常(对角不同队)时会显式警告', () => {
  // 这是防御性检查：万一上层传了非对角 teamOf，prompt 必须明确标出，
  // 让模型不要盲目信任位置关系
  const bad = [0, 1, 1, 0]; // 0与2不同队 → 违反对角规则
  const t = new PlayTracker(); t.reset('9', '2');
  const txt = describeTable(mkRound(bad), 0, t, {});
  assert.match(txt, /非同队/, '对角不同队时必须警告');
});
