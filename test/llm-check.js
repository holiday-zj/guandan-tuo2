// LLM 连通性与延迟自检：确认机器人真的在用大模型
// 用法: node test/llm-check.js
import { llmStatus, reloadLlmConfig, askJson } from '../engine/ai/llm.js';

const st = reloadLlmConfig();
console.log('=== LLM 配置状态 ===');
console.log('  enabled :', st.enabled, st.enabled ? '✅ 大模型已启用' : '❌ 未启用（机器人走启发式）');
console.log('  base    :', st.base);
console.log('  model   :', st.model, '/ fast:', st.fastModel);
console.log('  keyLen  :', st.keyLen, st.keyLen >= 20 ? '✅' : '❌ 占位符或过短');

if (!st.enabled) {
  console.log('\n⚠️  未启用。请把真实密钥写入 data/llm.env 的 LLM_KEY 行，然后重启服务。');
  process.exit(1);
}

console.log('\n=== 连通性测试 ===');
const t0 = Date.now();
const r = await askJson('你是掼蛋助手，只输出JSON。', '手牌有对A，对手出对K。该出什么？输出{"answer":"..."}', { timeoutMs: 60000 });
console.log('  结果  :', r.ok ? '✅ 调用成功' : '❌ 失败');
console.log('  耗时  :', r.ms + 'ms');
if (r.ok) {
  console.log('  回复  :', JSON.stringify(r.data).slice(0, 120));
  console.log('  tokens:', JSON.stringify(r.usage || {}));
} else {
  console.log('  错误  :', r.error);
  if (r.raw) console.log('  原始  :', String(r.raw).slice(0, 200));
}

console.log('\n=== 真实出牌决策延迟（模拟3次，含缓存）===');
const PROMPT = `本副打9(级牌9)，拖牌=2。我是座位0，对家(队友)=座位2。
进度：我剩18张 | 下家(对手)剩20张 | 对家(队友)剩22张 | 上家(对手)剩19张
我的牌力：中等(52分)，手数≈7，控制张1个(4炸)
外面剩余：大王×1 小王×2 级牌9×3 拖牌2×4 A×5
当前牌圈：对手(座位3)出了【♠A ♥A】(pair)，你是第2个应对
我的手牌(18张)：♠2 ♥2 ♠5 ♠7 ♠8 ♥8 ♣9 ♦9 ♠J ♠Q ♥K ♣K ♠A ♣3 ♦5 ♥7 ♣T
合法候选：
0. 单 ♠2【纯拖!】
1. 对 ♠2 ♥2【纯拖!】
2. 对 ♠5 ♦5
3. 对 ♠8 ♥8
4. 对 ♣9 ♦9
5. 对 ♠J ♠J
6. 对 ♠Q ♠Q
7. 对 ♥K ♣K
8. 炸弹 ♣9 ♦9 ♠9 ♥9
请决策，输出JSON。`;
for (let i = 0; i < 3; i++) {
  const t = Date.now();
  const rr = await askJson('你是掼蛋AI。只输出JSON:{"action":"play","candidate":N,"reason":"20字内"}', PROMPT + `\n(第${i}次)`, { timeoutMs: 60000, temperature: 0.3, maxTokens: 150 });
  if (rr.ok) console.log(`  第${i + 1}次 ✅ ${Date.now() - t}ms (总${rr.ms}ms) → ${JSON.stringify(rr.data).slice(0, 90)}${rr.cached ? ' [缓存命中]' : ''}`);
  else console.log(`  第${i + 1}次 ❌ ${Date.now() - t}ms ${rr.error}`);
}

console.log('\n完成。若延迟 <3s/手，机器人用大模型出牌体验可接受；>5s 建议改混合模式。');
