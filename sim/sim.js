// 完整比赛模拟：验证 翻牌→定队→进贡→出牌→结算→升级 全链路
import { Match } from '../engine/match.js';
import { playRound, makeSimpleBot } from '../engine/driver.js';
import { cardLabel } from '../engine/cards.js';

const N = parseInt(process.argv[2] || '50', 10);
let ok = 0, fails = [];

for (let i = 0; i < N; i++) {
  let m = null;
  try {
    m = new Match(['东', '南', '西', '北'], { defaultTeamOf: [0, 1, 0, 1] });
    const bots = [makeSimpleBot(), makeSimpleBot(), makeSimpleBot(), makeSimpleBot()];
    let guard = 0;
    while (!m.matchOver) {
      if (++guard > 300) throw new Error('too many rounds (no progress?)');
      const { round, flipInfo, tribute } = m.newRound();
      // 首出权：有进贡则进贡方先出，否则首局由翻到亮牌者出（简化为座位0）
      let lead = 0;
      if (tribute.type === 'single' || tribute.type === 'double') lead = tribute.tributes[0].from;
      round.startPlay(lead);
      playRound(round, bots, { strict: true });
      const result = round.settle(round.finishedByPlay || {});
      m.applyResult(result);
      // 基本不变量检查
      if (result.total < 1 || result.total > 40) throw new Error(`total out of range: ${result.total}`);
      if (result.losers.length !== 2) throw new Error('losers != 2');
    }
    ok++;
    if (i < 3 || i === N - 1) {
      console.log(`[match ${i + 1}] rounds=${m.roundNo} winner=${m.teamName(m.winnerTeam)} levels=${JSON.stringify(m.levels)}`);
    }
  } catch (e) {
    fails.push({ i, err: e.message });
    if (fails.length <= 2) {
      console.error(`[match ${i + 1}] FAIL: ${e.message}`);
      const r = m.round;
      if (r) console.error('  finishOrder=', JSON.stringify(r.finishOrder), 'state=', r.state, 'hands=', r.hands.map(h => h && h.length));
    }
  }
}
console.log(`\n${ok}/${N} matches completed. failures: ${fails.length}`);
if (fails.length) {
  const kinds = {};
  for (const f of fails) kinds[f.err] = (kinds[f.err] || 0) + 1;
  console.log('failure kinds:', JSON.stringify(kinds, null, 1));
  process.exit(1);
}
