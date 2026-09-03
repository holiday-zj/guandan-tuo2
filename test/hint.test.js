import test from 'node:test';
import assert from 'node:assert/strict';
import { leadOptions, followOptions } from '../engine/hint.js';
import { bestInterpretation } from '../engine/classify.js';

const C = (suit, rank, id) => ({ id: id ?? suit + rank, suit, rank });

test('领出提示：包含单张/对子/顺子等基本牌型', () => {
  const lv = '9';
  const hand = [
    C('♠', '3'), C('♥', '4'), C('♣', '5'), C('♦', '6'), C('♠', '7'),  // 34567 顺
    C('♥', '8'), C('♥', '8'),                                          // 对8
    C('♣', 'K'),                                                        // 单K
  ];
  const opts = leadOptions(hand, lv);
  const types = new Set(opts.map(o => o.it.type));
  assert.ok(types.has('single'), '应有单张');
  assert.ok(types.has('pair'), '应有对子');
  assert.ok(types.has('straight'), '应有顺子');
});

test('领出提示：炸弹与同花顺', () => {
  const lv = '5';
  const hand = [
    C('♠', '8'), C('♥', '8'), C('♣', '8'), C('♦', '8'),              // 炸8
    C('♠', '3'), C('♠', '4'), C('♠', '5'), C('♠', '6'), C('♠', '7'), // 同花顺(注意♠5非级牌)
  ];
  const opts = leadOptions(hand, lv);
  const types = new Set(opts.map(o => o.it.type));
  assert.ok(types.has('bomb'), '应有炸弹');
  assert.ok(types.has('straight_flush'), '应有同花顺');
});

test('跟牌提示：只返回能压过的，且从小到大排序', () => {
  const lv = '9';
  const hand = [C('♠', '5'), C('♥', 'K'), C('♣', 'A'), C('♦', '3')];
  const target = bestInterpretation([C('♠', 'J')], lv); // 对方出单J
  const opts = followOptions(hand, lv, target);
  const labels = opts.map(o => o.cards.map(c => c.rank).join(''));
  assert.ok(!labels.includes('5'), '5压不过J');
  assert.ok(!labels.includes('3'), '3压不过J');
  assert.ok(labels.includes('K'), 'K可压');
  assert.ok(labels.includes('A'), 'A可压');
  // 排序：K 在 A 前
  assert.ok(labels.indexOf('K') < labels.indexOf('A'));
});

test('跟牌提示：炸弹可压普通牌型', () => {
  const lv = '9';
  const hand = [C('♠', '6'), C('♥', '6'), C('♣', '6'), C('♦', '6')];
  const target = bestInterpretation([C('♠', 'A')], lv);
  const opts = followOptions(hand, lv, target);
  assert.ok(opts.some(o => o.it.type === 'bomb'), '应有炸弹选项');
});

test('逢人配补对', () => {
  const lv = '9'; // 逢人配=♥9
  const hand = [C('♠', 'K'), C('♥', '9')]; // 单K + 红9(逢人配)
  const opts = leadOptions(hand, lv);
  assert.ok(opts.some(o => o.it.type === 'pair'), '逢人配应能与K组成对子');
});

test('无牌可压时返回空数组', () => {
  const lv = '9';
  const hand = [C('♠', '3'), C('♥', '4')];
  const target = bestInterpretation([C('♠', 'BJ')], lv); // 大王
  const opts = followOptions(hand, lv, target);
  assert.equal(opts.length, 0);
});
