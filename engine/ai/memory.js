// 单副牌的对局记忆：保留上下文 + 超阈值自动压缩
//
// 设计要点：
//   1. 记忆按"每副牌"独立（每副重新亮牌定级定队，跨副记忆无意义）
//   2. 分两类内容：
//      - publicLog：全场公开出牌流水（所有座位共享的客观事实）
//      - plans[seat]：该座位自己的决策理由/战术意图（私有，保证计划连续性）
//   3. 压缩策略：超过 SOFT_LIMIT 字符时
//      a) 立即做确定性摘要（零延迟，不阻塞出牌）
//      b) 后台再用大模型精炼摘要（fire-and-forget，供后续决策使用）
//   4. 压缩只动"旧"内容，最近 N 条始终原样保留（近期细节对决策最有用）
import { askJson } from './llm.js';

const SOFT_LIMIT = Number(process.env.AI_MEMORY_CHARS || 1400);   // 触发压缩的字符数（瘦身：决策相关信息密度优先，注意力不被稀释）
const KEEP_PUBLIC = Number(process.env.AI_MEMORY_KEEP_PUBLIC || 14); // 始终保留最近多少条公开出牌
const KEEP_PLANS = Number(process.env.AI_MEMORY_KEEP_PLANS || 4);    // 始终保留自己最近多少条意图
const SUMMARY_LIMIT = 700;                                       // 摘要目标长度

const SHAPE_CN = {
  single: '单', pair: '对', triple: '三张', triple_pair: '三带二', straight: '顺子',
  pair_straight: '三连对', triple_straight: '钢板', bomb: '炸弹', straight_flush: '同花顺', kings: '天王',
};

export class RoundMemory {
  constructor(roundNum, level, tug) {
    this.roundNum = roundNum;
    this.level = level;
    this.tug = tug;
    this.publicLog = [];            // [{n, seat, text, notable}]
    this.plans = [[], [], [], []];  // seat -> [{n, text}]
    this.summary = '';              // 已压缩的历史摘要
    this.summaryUpTo = 0;           // summary 已覆盖到 publicLog 的哪个下标
    this.seq = 0;
    this._compressing = false;
    this.compressCount = 0;
  }

  // 记录一次公开动作（出牌/过牌）。notable=值得长期记住的关键事件
  addPlay(seat, text, notable = false) {
    this.publicLog.push({ n: ++this.seq, seat, text, notable });
  }

  // 记录某座位自己的决策意图（私有上下文）
  addPlan(seat, text) {
    if (!text) return;
    const list = this.plans[seat];
    if (!list) return;
    list.push({ n: ++this.seq, text: String(text).slice(0, 60) });
    if (list.length > KEEP_PLANS * 3) list.splice(0, list.length - KEEP_PLANS * 2); // 硬上限防膨胀
  }

  size() {
    let n = this.summary.length;
    for (const p of this.publicLog) n += p.text.length + 6;
    for (const l of this.plans) for (const p of l) n += p.text.length + 4;
    return n;
  }

  // 生成给某个座位看的记忆上下文
  buildFor(seat) {
    const parts = [];
    if (this.summary) parts.push('【本副早期回顾(已压缩)】\n' + this.summary);

    const recent = this.publicLog.slice(this.summaryUpTo).slice(-KEEP_PUBLIC);
    if (recent.length) {
      parts.push('【最近出牌流水】\n' + recent.map(p => `#${p.n} 座${p.seat} ${p.text}`).join('\n'));
    }

    const myPlans = this.plans[seat].slice(-KEEP_PLANS);
    if (myPlans.length) {
      parts.push('【我此前几手的判断(仅供了解我留了什么牌，局势变了就按当前局面决策，不要死守旧计划)】\n'
        + myPlans.map(p => `#${p.n} ${p.text}`).join('\n'));
    }

    if (!parts.length) return '';
    return '═══ 对局记忆（第' + this.roundNum + '副，打' + this.level + '拖' + this.tug + '）═══\n'
      + parts.join('\n\n');
  }

  // 确定性摘要：把 publicLog[summaryUpTo .. len-KEEP_PUBLIC) 聚合成要点，零延迟
  deterministicCompress() {
    const end = Math.max(this.summaryUpTo, this.publicLog.length - KEEP_PUBLIC);
    if (end <= this.summaryUpTo) return false;
    const seg = this.publicLog.slice(this.summaryUpTo, end);
    if (!seg.length) return false;

    const byCount = [0, 0, 0, 0];
    const byPass = [0, 0, 0, 0];
    const shapes = [ {}, {}, {}, {} ];
    const notable = [];
    for (const p of seg) {
      if (p.notable) notable.push(`#${p.n}座${p.seat}${p.text}`);
      if (/^过/.test(p.text)) { byPass[p.seat]++; continue; }
      byCount[p.seat]++;
      for (const k of Object.keys(SHAPE_CN)) {
        if (p.text.includes(SHAPE_CN[k])) { shapes[p.seat][k] = (shapes[p.seat][k] || 0) + 1; break; }
      }
    }

    const lines = [];
    if (this.summary) lines.push(this.summary);
    // 全零段(该区间没有任何出牌/过牌)不生成摘要行——之前产生大量"座0出0手/过0次"垃圾行
    const hasAny = byCount.some(n => n > 0) || byPass.some(n => n > 0) || notable.length;
    if (hasAny) {
      lines.push(`第${seg[0].n}~${seg[seg.length - 1].n}手摘要：`
        + [0, 1, 2, 3].map(s => `座${s}出${byCount[s]}手/过${byPass[s]}次`
          + (Object.keys(shapes[s]).length ? '(' + Object.entries(shapes[s]).map(([k, v]) => SHAPE_CN[k] + v).join(' ') + ')' : '')).join('；'));
    }
    if (notable.length) lines.push('关键事件：' + notable.slice(-8).join('；'));

    let out = lines.join('\n');
    // 摘要本身也限长：太长就丢掉最前面的行
    if (out.length > SUMMARY_LIMIT) {
      const ls = out.split('\n');
      while (ls.length > 1 && ls.join('\n').length > SUMMARY_LIMIT) ls.shift();
      out = ls.join('\n');
    }
    this.summary = out;
    this.summaryUpTo = end;
    this.compressCount++;
    return true;
  }

  // 超阈值时触发压缩：确定性摘要立即生效 + 大模型精炼在后台补上
  maybeCompress() {
    if (this.size() <= SOFT_LIMIT) return false;
    const did = this.deterministicCompress();
    // 后台用大模型把摘要提炼得更有"棋感"（不阻塞当前决策）
    if (this.summary && !this._compressing) {
      this._compressing = true;
      const target = this.summary;
      askJson(
        '你是掼蛋对局记录压缩器。把给定的对局摘要提炼成更精炼的战术要点，保留：各家牌型倾向、谁可能捏着大牌、危险信号、我方计划。不要编造未提及的信息。只输出JSON。',
        `牌局：第${this.roundNum}副，打${this.level}，拖牌${this.tug}。\n待压缩摘要：\n${target}\n\n输出 {"summary":"<不超过260字的要点>"}`,
        { fast: true, timeoutMs: 8000, temperature: 0.2, maxTokens: 500 },
      ).then(r => {
        if (r.ok && r.data && typeof r.data.summary === 'string' && r.data.summary.length > 20) {
          // 只在摘要没被后续压缩大幅推进时替换，避免覆盖更新的信息
          this.summary = (this.summary.length > r.data.summary.length * 3)
            ? r.data.summary + '\n' + this.summary.slice(-200)
            : r.data.summary;
          if (this.summary.length > SUMMARY_LIMIT) this.summary = this.summary.slice(-SUMMARY_LIMIT);
        }
      }).catch(() => { /* 精炼失败无所谓，确定性摘要已可用 */ })
        .finally(() => { this._compressing = false; });
    }
    return did;
  }
}
