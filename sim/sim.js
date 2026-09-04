// 完整比赛模拟：验证 发牌→亮牌定级定队→座位重排(对角)→进贡→出牌→结算 全链路（无升级，固定副数）
import { Match } from '../engine/match.js';
import { playRound, makeSimpleBot } from '../engine/driver.js';

const N = parseInt(process.argv[2] || '50', 10);
let ok = 0, fails = [];

for (let i = 0; i < N; i++) {
  let m = null;
  try {
    m = new Match(['东', '南', '西', '北'], { totalRounds: 8 });
    const bots = [makeSimpleBot(), makeSimpleBot(), makeSimpleBot(), makeSimpleBot()];
    let guard = 0;
    while (!m.matchOver) {
      if (++guard > 30) throw new Error('too many rounds (no progress?)');
      const { round, flipInfo, tribute } = m.newRound();

      // 不变量：队友必须对角（队伍0坐0/2，队伍1坐1/3）
      const t = round.teamOf;
      if (t[0] !== t[2] || t[1] !== t[3] || t[0] === t[1]) throw new Error('队友未对角: ' + JSON.stringify(t));
      // 不变量：级牌由亮牌决定
      if (!flipInfo.level) throw new Error('no level');

      // 首出权：有进贡则进贡方先出，否则座位0
      let lead = 0;
      if (tribute.type === 'single' || tribute.type === 'double') lead = tribute.tributes[0].from;
      round.startPlay(lead);
      playRound(round, bots, { strict: true });
      const result = round.settle(round.finishedByPlay || {});
      m.applyResult(result);
      // 基本不变量检查
      if (result.total < 1 || result.total > 13) throw new Error(`total out of range: ${result.total}`);
      if (result.losers.length !== 2) throw new Error('losers != 2');
    }
    ok++;
    if (i < 3 || i === N - 1) {
      console.log(`[match ${i + 1}] rounds=${m.roundNo} roundWins=${JSON.stringify(m.roundWins)} winner=${m.winnerTeam === -1 ? '平局' : '队伍' + m.winnerTeam}`);
    }
  } catch (e) {
    fails.push({ i, err: e.message });
    if (fails.length <= 2) {
      console.error(`[match ${i + 1}] FAIL: ${e.message}`);
      const r = m && m.round;
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
