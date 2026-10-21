// 对局记忆测试：上下文保留 + 超阈值自动压缩
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoundMemory } from '../engine/ai/memory.js';

test('记忆记录公开出牌流水，buildFor 能看到最近动作', () => {
  const m = new RoundMemory(1, '9', '2');
  m.addPlay(0, '出单[♠3]，剩26张');
  m.addPlay(1, '过牌，压不过单(值3)');
  m.addPlay(2, '出单[♥A]，剩26张', false);
  const ctx = m.buildFor(0);
  assert.match(ctx, /最近出牌流水/);
  assert.match(ctx, /♠3/);
  assert.match(ctx, /♥A/);
  assert.match(ctx, /打9拖2/, '头部应含本副级牌拖牌');
});

test('私有计划只对本人可见（座位隔离）', () => {
  const m = new RoundMemory(1, '9', '2');
  m.addPlay(1, '出单[♠5]');
  m.addPlan(0, '我要留炸弹压末手');
  m.addPlan(1, '对家计划冲头游');
  const mine = m.buildFor(0);
  const others = m.buildFor(2);
  assert.match(mine, /留炸弹压末手/, '本人能看到自己的计划');
  assert.ok(!mine.includes('对家计划冲头游'), '看不到别人的计划');
  assert.ok(!others.includes('留炸弹压末手'), '座位2看不到座位0的计划');
});

test('关键事件(notable)在压缩后仍保留', () => {
  const m = new RoundMemory(1, '9', '2');
  // 先塞一条 notable 炸弹，再用大量普通出牌把它挤出"最近N条"窗口
  m.addPlay(0, '出炸弹[♠7 ♥7 ♣7 ♦7]，剩20张', true);
  for (let i = 0; i < 60; i++) m.addPlay(i % 4, `出单[♠${(i % 9) + 3}]，剩${20 - i % 10}张`);
  m.maybeCompress();
  const ctx = m.buildFor(1);
  assert.match(ctx, /关键事件|♠7/, '炸弹这类关键事件应被摘要保留');
});

test('超阈值触发压缩：summary 生成且总长受控', () => {
  const m = new RoundMemory(2, 'K', '2');
  for (let i = 0; i < 200; i++) {
    m.addPlay(i % 4, `出对[♠${(i % 9) + 3} ♥${(i % 9) + 3}]，剩${27 - (i % 20)}张`);
  }
  const before = m.size();
  const did = m.deterministicCompress();
  assert.ok(did, '应执行了压缩');
  assert.ok(m.summary.length > 0, '应生成摘要');
  assert.ok(m.summaryUpTo > 0, 'summaryUpTo 应前移');
  // 压缩后：buildFor 里"最近流水"只保留 KEEP_PUBLIC 条，而非全部200条
  const ctx = m.buildFor(0);
  const flowLines = ctx.split('\n').filter(l => /^#\d+ 座/.test(l));
  assert.ok(flowLines.length <= 26, `最近流水应≤26条，实际${flowLines.length}`);
  assert.match(ctx, /早期回顾/, '应出现已压缩的早期回顾段');
});

test('压缩幂等：无新内容时重复调用不报错、不前移', () => {
  const m = new RoundMemory(1, '9', '2');
  m.addPlay(0, '出单[♠3]');
  m.deterministicCompress(); // 只有1条，不足KEEP_PUBLIC，不该压缩
  const upto1 = m.summaryUpTo;
  m.deterministicCompress();
  assert.equal(m.summaryUpTo, upto1, '无新内容时 summaryUpTo 不应变化');
});

test('计划数量有硬上限，防止无限膨胀', () => {
  const m = new RoundMemory(1, '9', '2');
  for (let i = 0; i < 100; i++) m.addPlan(0, '计划' + i);
  assert.ok(m.plans[0].length <= 24, `plans[0] 应被裁剪到≤24，实际${m.plans[0].length}`);
  // buildFor 只取最近 KEEP_PLANS 条
  const ctx = m.buildFor(0);
  const planLines = ctx.split('\n').filter(l => /^#\d+ /.test(l));
  assert.ok(planLines.length <= 8, `展示的计划应≤8条，实际${planLines.length}`);
});

test('每副独立：新 RoundMemory 不携带旧副记忆', () => {
  const m1 = new RoundMemory(1, '9', '2');
  m1.addPlay(0, '出炸弹[♠7]');
  m1.addPlan(0, '第一副的计划');
  const m2 = new RoundMemory(2, 'K', '2'); // 新一副
  assert.equal(m2.publicLog.length, 0, '新副公开流水应为空');
  assert.equal(m2.plans[0].length, 0, '新副计划应为空');
  assert.ok(!m2.buildFor(0).includes('第一副'), '新副不含旧副记忆');
});
