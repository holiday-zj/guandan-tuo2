import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDeck, levelFromFlip, tugRank, orderValue, isWild, tugValueOf } from '../engine/cards.js';
import { interpret, bestInterpretation, canBeat, classifyNatural, SHAPE } from '../engine/classify.js';

const C = (suit, rank) => ({ id: suit + rank, suit, rank });

test('deck has 108 cards', () => {
  assert.equal(makeDeck().length, 108);
});

test('levelFromFlip: 亮A打2, 亮8打9, 亮K打A', () => {
  assert.equal(levelFromFlip('A'), '2');
  assert.equal(levelFromFlip('8'), '9');
  assert.equal(levelFromFlip('K'), 'A');
  assert.equal(levelFromFlip('2'), '3');
});

test('tugRank: 打2拖3, 其余拖2', () => {
  assert.equal(tugRank('2'), '3');
  assert.equal(tugRank('9'), '2');
  assert.equal(tugRank('A'), '2');
});

test('orderValue: 大王>小王>级牌>A', () => {
  assert.ok(orderValue('BJ', '9') > orderValue('SJ', '9'));
  assert.ok(orderValue('SJ', '9') > orderValue('9', '9'));
  assert.ok(orderValue('9', '9') > orderValue('A', '9'));
  assert.equal(orderValue('9', '9'), 15);
});

test('tugValueOf: 红拖2级, 普通拖1级', () => {
  assert.equal(tugValueOf(C('♥', '2'), '9'), 2);
  assert.equal(tugValueOf(C('♠', '2'), '9'), 1);
  assert.equal(tugValueOf(C('♥', '3'), '2'), 2);
  assert.equal(tugValueOf(C('♠', '5'), '9'), 0);
});

test('single pair triple classification', () => {
  const lv = '9';
  assert.equal(bestInterpretation([C('♠', '5')], lv).type, 'single');
  assert.equal(bestInterpretation([C('♠', '5'), C('♥', '5')], lv).type, 'pair');
  assert.equal(bestInterpretation([C('♠', '5'), C('♥', '5'), C('♣', '5')], lv).type, 'triple');
});

test('pair cannot beat single (different shape)', () => {
  const lv = '9';
  const single = bestInterpretation([C('♠', 'A')], lv);
  const pair = bestInterpretation([C('♠', '5'), C('♥', '5')], lv);
  assert.equal(canBeat(pair, single), false);
});

test('level card beats A as single', () => {
  const lv = '9';
  const a = bestInterpretation([C('♠', 'A')], lv);
  const nine = bestInterpretation([C('♠', '9')], lv);
  assert.equal(canBeat(nine, a), true);
  assert.equal(canBeat(a, nine), false);
});

test('bomb hierarchy: kings > 6-bomb > straight flush > 5-bomb > 4-bomb', () => {
  const lv = '9';
  const kings = bestInterpretation([C('X', 'BJ'), C('X', 'BJ'), C('X', 'SJ'), C('X', 'SJ')], lv);
  assert.equal(kings.type, 'kings');
  const bomb6 = bestInterpretation(Array.from({ length: 6 }, (_, i) => C(['♠', '♥', '♣', '♦', '♠', '♥'][i], '7')), lv);
  assert.equal(bomb6.type, 'bomb');
  assert.equal(bomb6.len, 6);
  const sf = bestInterpretation(['3', '4', '5', '6', '7'].map(r => C('♠', r)), lv);
  assert.equal(sf.type, 'straight_flush');
  const bomb5 = bestInterpretation(Array.from({ length: 5 }, (_, i) => C(['♠', '♥', '♣', '♦', '♠'][i], 'K')), lv);
  assert.equal(bomb5.type, 'bomb');
  const bomb4 = bestInterpretation(['♠', '♥', '♣', '♦'].map(s => C(s, '3')), lv);
  assert.equal(bomb4.type, 'bomb');

  assert.equal(canBeat(kings, bomb6), true);
  assert.equal(canBeat(bomb6, sf), true);
  assert.equal(canBeat(sf, bomb5), true);
  assert.equal(canBeat(bomb5, bomb4), true);
  assert.equal(canBeat(bomb4, sf), false);
  assert.equal(canBeat(bomb6, kings), false);
});

test('bomb beats any normal combination', () => {
  const lv = '9';
  const straight = bestInterpretation(['3', '4', '5', '6', '7'].map((r, i) => C(['♠', '♥', '♣', '♦', '♠'][i], r)), lv);
  assert.equal(straight.type, 'straight');
  const bomb4 = bestInterpretation(['♠', '♥', '♣', '♦'].map(s => C(s, '4')), lv);
  assert.equal(canBeat(bomb4, straight), true);
});

test('straight: A2345 smallest, 10JQKA largest, QKA23 invalid', () => {
  const lv = '9';
  const s1 = bestInterpretation(['A', '2', '3', '4', '5'].map((r, i) => C(['♠', '♥', '♣', '♦', '♠'][i], r)), lv);
  const s2 = bestInterpretation(['T', 'J', 'Q', 'K', 'A'].map((r, i) => C(['♥', '♣', '♦', '♠', '♥'][i], r)), lv);
  const bad = bestInterpretation(['Q', 'K', 'A', '2', '3'].map(r => C('♣', r)), lv);
  assert.equal(s1.type, 'straight');
  assert.equal(s2.type, 'straight');
  assert.equal(bad, null);
  assert.equal(canBeat(s2, s1), true);
  assert.equal(canBeat(s1, s2), false);
});

test('pair straight & triple straight (钢板)', () => {
  const lv = '9';
  const ps = bestInterpretation(['3', '3', '4', '4', '5', '5'].map((r, i) => C(i % 2 ? '♥' : '♠', r)), lv);
  assert.equal(ps.type, 'pair_straight');
  const ts = bestInterpretation(['7', '7', '7', '8', '8', '8'].map((r, i) => C(['♠', '♥', '♣'][i % 3], r)), lv);
  assert.equal(ts.type, 'triple_straight');
});

test('triple with pair (三带二)', () => {
  const lv = '9';
  const tp = bestInterpretation([C('♠', '8'), C('♥', '8'), C('♣', '8'), C('♠', '4'), C('♥', '4')], lv);
  assert.equal(tp.type, 'triple_pair');
});

test('wild (红桃级牌) forms bomb: four 9s + wild = 5张9炸', () => {
  const lv = '9';
  const cards = [C('♠', '9'), C('♥', '9'), C('♣', '9'), C('♦', '9'), C('♥', lv)];
  // 注意：这里的♥9 与 ♥级牌是不同牌；级牌是♥9时逢人配=♥9，需换一个级牌测试
  const lv2 = 'T';
  const cards2 = [C('♠', '9'), C('♥', '9'), C('♣', '9'), C('♦', '9'), C('♥', 'T')];
  const best = bestInterpretation(cards2, lv2);
  assert.equal(best.type, 'bomb');
  assert.equal(best.len, 5);
});

test('wild forms straight flush', () => {
  const lv = 'T'; // 逢人配 = ♥10
  const cards = [C('♠', '3'), C('♠', '4'), C('♠', '5'), C('♠', '6'), C('♥', 'T')];
  const best = bestInterpretation(cards, lv);
  assert.equal(best.type, 'straight_flush');
});

test('wild cannot substitute jokers', () => {
  const lv = 'T';
  const cards = [C('X', 'BJ'), C('X', 'SJ'), C('♥', lv)];
  const interps = interpret(cards, lv);
  // 不能组成天王（需要双大王）
  assert.ok(!interps.some(it => it.type === 'kings'));
});
