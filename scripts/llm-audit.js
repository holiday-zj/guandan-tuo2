// LLM 决策质量审计：解析 data/llm-io.log，统计违规率（改造前后对比的唯一标尺）
// 用法: node scripts/llm-audit.js [日志文件] [--json 输出文件] [--samples]
// 新版日志含 AUDIT 行（引擎注入的结构化事实），审计精确；旧日志按 prompt 文本推断（标记 legacy）。
// 违规定义（全部来自 SYSTEM_PROMPT 的红线规则）：
//   V1 pass_on_lead          领出时过牌（非法，必然降级）
//   V2 pass_opp_urgent       对手告急(牌圈主≤3张)且有合法候选时过牌
//   V3 jiefeng_misread       过牌理由含"接风"但过牌后牌权归对手（接风误解）
//   V4 beat_partner          压了未出完队友的牌（非清牌非冲刺）
//   V5 pick_warned           有干净候选时仍选拆牌候选（非告急/非清牌）
//   V6 pick_hands_up         有手数不增的候选时仍选手数增加的候选
//   V7 pass_partner_urgent   队友≤1张急需牌权却过牌
//   V8 ignore_recommend      偏离引擎推荐且非过牌类合理偏离（观察指标，不算硬违规）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG = process.argv[2] || path.resolve(__dirname, '../data/llm-io.log');
const jsonOut = (() => {
  const i = process.argv.indexOf('--json');
  return i >= 0 ? process.argv[i + 1] : null;
})();

const txt = fs.readFileSync(LOG, 'utf8');

// —— DECISION 终局行统计（实际执行动作；新架构才有）——
const DEC = { total: 0, via: {}, violations: 0 };
for (const m of txt.matchAll(/DECISION (\{.*\})/g)) {
  let d; try { d = JSON.parse(m[1]); } catch { continue; }
  DEC.total++;
  DEC.via[d.via || '?'] = (DEC.via[d.via || '?'] || 0) + 1;
  if (d.violation) DEC.violations++;
}

const blocks = txt.split(/\n(?=\[\d{4}-\d{2}-\d{2} [\d:]+\] #\w+ (?:REQUEST|RESPONSE|ERROR))/);

const pairs = new Map();
const order = [];
for (const b of blocks) {
  const m = b.match(/^\[[\d\- :]+\] #(\w+) (REQUEST|RESPONSE|ERROR)/);
  if (!m) continue;
  const [, rid, typ] = m;
  if (typ === 'REQUEST') { pairs.set(rid, { req: b }); order.push(rid); }
  else if (pairs.has(rid)) pairs.get(rid)[typ === 'RESPONSE' ? 'resp' : 'err'] = b;
}

const V = ['V1_pass_on_lead', 'V2_pass_opp_urgent', 'V3_jiefeng_misread', 'V4_beat_partner',
  'V5_pick_warned', 'V6_pick_hands_up', 'V7_pass_partner_urgent', 'V8_ignore_recommend'];
const S = {
  total: 0, errors: 0, parseFail: 0, ok: 0, pass: 0, play: 0,
  corrected: 0, overridden: 0, engineFallback: 0, llmClean: 0,
  retries: 0, legacy: 0, audited: 0,
  latencies: [],
};
for (const k of V) S[k] = 0;
const samples = {};
const addSample = (k, s) => { (samples[k] = samples[k] || []).push(s); };

for (const rid of order) {
  const p = pairs.get(rid);
  S.total++;
  if (p.err) { S.errors++; continue; }
  if (!p.resp) continue;

  if (/retry":1/.test(p.resp)) S.retries++;

  const ms = p.resp.match(/耗时 (\d+)ms/);
  if (ms) S.latencies.push(+ms[1]);

  const parsedM = p.resp.match(/PARSED（解析后实际执行）-----\n(.*)/);
  let d = null;
  if (parsedM) { try { d = JSON.parse(parsedM[1].trim()); } catch { /* noop */ } }
  if (!d) {
    const raw = p.resp.match(/RAW（模型原始输出）-----\n([\s\S]*?)\n-----/);
    if (raw) { try { d = JSON.parse(raw[1].trim()); } catch { /* noop */ } }
  }
  if (!d) { S.parseFail++; continue; }
  S.ok++;

  const auditM = p.resp.match(/----- AUDIT ----- (\{.*\})/);
  let A = null;
  if (auditM) { try { A = JSON.parse(auditM[1]); } catch { /* noop */ } }

  const req = p.req;
  if (!A) {
    // —— 旧日志：从 prompt 文本推断（尽力而为）——
    S.legacy++;
    const isLead = /轮到你【领出】/.test(req);
    const trickM = req.match(/当前牌圈：(队友|对手)\((\d)号位\)/);
    const urgentOpp = new Set();
    for (const m of req.matchAll(/🚨(下家\(对手\)|上家\(对手\))(\d)只剩(\d+)张/g)) urgentOpp.add(+m[2]);
    const partnerUrgent1 = /🚨队友\d只剩1张/.test(req);
    const partnerDone = /队友已出完|对家\(队友\)\d: (头游|二游|三游|末游)/.test(req);
    A = {
      isLead, byPartner: trickM ? trickM[1] === '队友' : null, trickBy: trickM ? +trickM[2] : null,
      oppUrgentNow: trickM ? urgentOpp.has(+trickM[2]) : false,
      partnerNeedLead: partnerUrgent1 && !partnerDone,
      partnerDone, passEndsTrick: null, passWindsToOpp: null, passNextIsPartner: null,
      canWinAll: /可一手清完|清牌/.test(req) && /✅/.test(req),
      handCount: (req.match(/我的手牌\((\d+)张/) || [])[1] | 0,
      recAction: null, recIdx: null, candScores: null, passScore: null,
    };
  } else {
    S.audited++;
  }

  // 候选行解析（新旧日志通用）
  const cands = new Map();
  for (const m of req.matchAll(/^(★?)(\d+)\. (.*)$/gm)) {
    cands.set(+m[2], { rec: !!m[1], line: m[3] });
  }

  const tail = () => req.slice(-700) + '\n>>> ' + JSON.stringify(d);
  const bucket = A && auditM ? 'new' : 'legacy';
  const bump = k => { S[k]++; S[k + '@' + bucket] = (S[k + '@' + bucket] || 0) + 1; addSample(k, tail()); };

  if (d.action === 'pass') {
    S.pass++;
    const reason = d.reason || '';
    if (A.isLead) bump('V1_pass_on_lead');
    if (!A.isLead && A.oppUrgentNow && cands.size > 0) bump('V2_pass_opp_urgent');
    if (!A.isLead && A.byPartner === false && !A.partnerDone && A.partnerNeedLead) bump('V7_pass_partner_urgent');
    if (/接风/.test(d.reason || '') && !A.isLead && A.byPartner === false && !A.partnerDone && A.passEndsTrick === false) {
      // 对手领牌、队友未出完、过牌不会结束本圈 → "等接风"必是误读
      bump('V3_jiefeng_misread');
    } else if (/接风/.test(d.reason || '') && A.passWindsToOpp === true) {
      bump('V3_jiefeng_misread');
    }
  } else if (d.action === 'play') {
    S.play++;
    const c = cands.get(d.candidate);
    const line = c ? c.line : '';
    const isWinAll = A.canWinAll && A.winAllIdx === d.candidate;
    if (!A.isLead && A.byPartner === true && !A.partnerDone && !isWinAll) {
      // 冲刺(≤5张/≤2手)允许压队友清牌，其余算违规
      const sprint = (A.handCount || 99) <= 5 || (A.myHands || 99) <= 2;
      if (!sprint) bump('V4_beat_partner');
    }
    const urgentNow = A.oppUrgentNow || A.partnerNeedLead;
    if (c && !urgentNow && !isWinAll) {
      const warned = line.includes('⚠');
      const cleanAlt = [...cands.values()].some(x => !x.line.includes('⚠'));
      if (warned && cleanAlt) { bump('V5_pick_warned'); }
      const up = /\(增\d+/.test(line);
      const noUp = [...cands.values()].some(x => !/\(增\d+/.test(x.line || ''));
      if (up && noUp) bump('V6_pick_hands_up');
    }
    if (A.recAction === 'play' && A.recIdx !== null && d.candidate !== A.recIdx) {
      S.V8_ignore_recommend++;
    } else if (A.recAction === 'pass') {
      S.V8_ignore_recommend++;
    }
  }
}

const lat = S.latencies.slice().sort((a, b) => a - b);
const pct = (n, dd) => dd ? (100 * n / dd).toFixed(1) + '%' : '-';
const decisions = S.pass + S.play;
const hardTotal = S.V1_pass_on_lead + S.V2_pass_opp_urgent + S.V3_jiefeng_misread + S.V4_beat_partner
  + S.V5_pick_warned + S.V6_pick_hands_up + S.V7_pass_partner_urgent;

const report = {
  log: LOG,
  requests: S.total, errors: S.errors, parseFail: S.parseFail,
  validDecisions: S.ok, auditedNew: S.audited, legacyGuessed: S.legacy, retries: S.retries,
  passRate: pct(S.pass, decisions),
  executed: DEC.total ? { total: DEC.total, viaBreakdown: DEC.via, caughtViolations: DEC.violations } : null,
  llmClean: S.llmClean, corrected: S.corrected, overridden: S.overridden, engineFallback: S.engineFallback,
  violations: Object.fromEntries(V.map(k => [k, `${S[k]} (${pct(S[k], decisions)})` + (S[k + '@new'] ? ` [新架构${S[k + '@new']}/旧${S[k + '@legacy'] || 0}]` : '')])),
  hardViolationTotal: `${hardTotal} (${pct(hardTotal, decisions)})`,
  hardViolationNewArchOnly: V.slice(0, 7).reduce((a, k) => a + (S[k + '@new'] || 0), 0),
  latencyMs: lat.length ? { p50: lat[lat.length >> 1], p90: lat[Math.floor(lat.length * .9)], p99: lat[Math.floor(lat.length * .99)], max: lat[lat.length - 1] } : null,
};

console.log('=== LLM 决策质量审计 ===');
console.log(JSON.stringify(report, null, 2));
if (process.argv.includes('--samples')) {
  for (const [k, v] of Object.entries(samples)) {
    console.log(`\n----- ${k} 样例(${v.length}) -----`);
    console.log(v.slice(0, 3).join('\n---\n'));
  }
}
if (jsonOut) {
  fs.writeFileSync(jsonOut, JSON.stringify({ report, samples: Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, v.slice(0, 5)])) }, null, 2));
  console.log('\nsaved ->', jsonOut);
}
