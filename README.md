# 掼蛋（安徽拖2）在线游戏

微信小程序（小游戏）在线掼蛋，按安徽"拖2"地方规则，含会员、积分（游戏币）、房间/大厅、微信支付占位（合规见下）。

## 规则实现（已验证）

| 规则 | 实现 |
|---|---|
| 两副牌108张（含4王） | `engine/cards.js` |
| 亮牌定级：亮几打几+1（亮A打2，亮K打A） | `levelFromFlip()` |
| 拖牌：打2拖3，其余拖2 | `tugRank()` |
| 红桃级牌=逢人配（除王外任意配） | `classify.js` 穷举替换 |
| 牌型：单/对/三/三带二/顺子/三连对/钢板/炸弹/同花顺/四大天王 | `classifyNatural()` |
| 大小：天王＞6+张炸＞同花顺＞5张内炸＞普通牌型；顺子仅A2345~10JQKA | `beatScore()/canBeat()` |
| 亮牌定队：两张相同亮牌者结队对坐；同在一人手中则队伍不变 | `Round.flip()` |
| 进贡/还贡/抗贡（双大王抗贡） | `engine/match.js` |
| 接风 | `GameSession.endTrick()` |
| **算级**：基础级（双下3/一三2/一四1）+ 头二游脱手纯拖牌（红拖×2）+ 三游末游剩余拖牌（红拖×2） | `Round.settle()` |
| 结算：输家每人付 总级数×房主设定币值 | `store.settleCoins()` |

**你的算例已写成单元测试**：头游拖2个2 + 二游拖1个2 + 三游末游剩4个2 = 3(双下)+3+4 = **10级** ✓（`test/settle.test.js`）

## 测试

```bash
npm test                  # 20 个规则单元测试（牌型/比较/算级）
npm run sim               # 100 场机器人自动对局压测（全链路无死锁）
npm run test:e2e          # 1真人+3机器人 打完一整场（需先 npm start）
npm run test:integration  # 4真人WS连接 建房→对战→结算→钱包守恒校验
```

已验证结果：
- 单元测试 20/20 通过
- 机器人模拟 500/500 场完成，无死锁
- 4真人集成测试：40副牌打完全场，钱包严格守恒

## 架构

```
engine/   纯规则引擎（零依赖，可被小程序端直接引用）
  cards.js      牌张基础工具
  classify.js   牌型识别（含逢人配穷举）
  game.js       单副牌状态机
  match.js      整场编排（升级/进贡）
  driver.js     机器人对局驱动
server/   Node.js 服务端（零第三方依赖）
  ws.js         RFC6455 WebSocket 实现
  store.js      会员/钱包（内存版，接库即可换）
  room.js       房间/大厅/对局会话
  bot.js        服务端机器人
  index.js      HTTP + WS 入口
client-wechat/  微信小游戏客户端（开发中）
```

### 协议

REST：`POST /api/register` `{name,password}`、`POST /api/login`、`GET /api/rooms`

WebSocket：`ws://host/?token=***

客户端 → 服务端：
- `{type:'create_room', stake, botFill}` 建房
- `{type:'join_room', roomId}` 加入
- `{type:'quick_match'}` 大厅排队
- `{type:'start_game'}` 房主开局
- `{type:'play', cards:[{id}]}` 出牌 / `{type:'pass'}` 过牌
- `{type:'leave_room'}`

服务端 → 客户端：
- `welcome / room_created / room_joined / room_state / queued`
- `game_start {seat, snapshot}` — 初始牌局快照（只含自己的手牌）
- `events [...]` — play/pass/finish/new_trick/round_result/next_round/match_over
- `snapshot` — 每步后的最新状态

## 微信小游戏合规要点

1. **主体**：小游戏虚拟支付（游戏币/房卡）必须**企业主体**注册，个人主体不可
2. **类目**：需申请"棋牌游戏"类目，并先取得**国家新闻出版署的游戏版号（ISBN）**
3. **支付**：取得版号后，使用微信虚拟支付（安卓）+ iOS 端按微信最新政策处理；**不得提供游戏币反向兑换现金**
4. **无版号过渡方案**：先做纯免费娱乐版（每日赠送游戏币、不可购买），用满资质后再开通充值
5. 防沉迷：需接入实名认证与未成年人保护（棋牌类强制）

## 路线图

- [x] 规则引擎 + 单元测试（20/20）
- [x] 机器人自动对局压测（500场）
- [x] 服务端：注册/登录/房间/大厅/实时对战/钱包结算
- [x] 4真人联调通过，钱包守恒
- [ ] 微信小游戏客户端（Canvas 渲染 + 触摸理牌 + 房间/大厅/商城界面）
- [ ] 服务端接 MySQL/Redis 持久化（会员、战绩、房间）
- [ ] 微信支付（版号到手后接入虚拟支付）
- [ ] 防沉迷实名认证
- [ ] 断线重连、托管出牌、聊天/表情
- [ ] 回放与战绩系统
