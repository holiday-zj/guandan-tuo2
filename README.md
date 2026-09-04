# 掼蛋（安徽拖2）在线游戏

微信小程序（小游戏）在线掼蛋，按安徽"拖2"地方规则，含会员、积分（游戏币）、房间/大厅、微信支付占位（合规见下）。

## 规则实现（定制完整版，已验证）

| 规则 | 实现 |
|---|---|
| 两副牌108张（含4王），逆时针出牌 | `engine/cards.js` |
| 亮牌定队：和亮牌同点数者一队，交叉对坐（队友面对面，每副自动重排座位） | `Round.flip()` + `seatPermutation()` |
| 级数：亮几打几+1（亮A打2） | `levelFromFlip()` |
| 拖牌：打2拖3，其余一律拖2 | `tugRank()` |
| 红桃级牌=逢人配（可配除大小王外任意牌） | `classify.js` 穷举替换 |
| 牌型：单/对/三/三带二/5张顺子/三连对(木板)/钢板/炸弹/同花顺/四大天王 | `classifyNatural()` |
| 大小：天王＞6张+炸＞**同花顺＞5张内炸**＞普通牌型；顺子仅A2345~10JQKA；钢板=2组3张(如666777) | `beatScore()/canBeat()` |
| 进贡/还贡/抗贡（双大王抗贡） | `engine/match.js` |
| 首攻禁拖：开局第一轮不允许直接出拖牌 | `Round.act()` |
| 头游特权：末手纯拖牌不可被压（强制接风队友）；二游拖牌只计分无特权 | `trick.locked` |
| 基础分：双上+3 / 一三+2 / 一四+1 | `Round.settle()` |
| 拖牌奖励：双上时头游+二游末手纯拖均计分，否则仅头游；普通拖+1/张，红桃拖+2/张 | `Round.settle()` |
| 末游惩罚：仅末游剩余拖牌每张+1级；双下时三游+末游全算 | `Round.settle()` |
| **总分封顶13级**，超出作废 | `Round.settle()` |
| 结算：输家每人付 总级数×底注 | `store.settleCoins()` |

## 测试

```bash
npm test                  # 29 个规则单元测试（牌型/比较/结算/提示/座位重排）
npm run sim               # 100 场机器人自动对局压测（全链路无死锁）
npm run test:e2e          # 1真人+3机器人 打完一整场（需先 npm start）
npm run test:integration  # 4真人WS连接 建房→对战→结算→钱包守恒校验
node test/hint-reconnect.test.js  # 出牌提示协议 + 断线重连
```

已验证结果：
- 单元测试 29/29 通过（含定制规则全部条款）
- 机器人模拟 200场完成，无死锁，总分恒≤13
- 4真人集成测试：整场打完，钱包严格守恒（总和恒为 4×初始币）
- SQLite 持久化：重启服务端后账号/币数/战绩完整保留
- 断线重连：重连后自动恢复当前牌局快照

网页试玩版：启动服务后访问 `http://服务器:8080/`

## 架构

```
engine/   纯规则引擎（零依赖，可被小程序端直接引用）
  cards.js      牌张基础工具
  classify.js   牌型识别（含逢人配穷举）
  game.js       单副牌状态机
  match.js      整场编排（升级/进贡）
  hint.js       出牌提示（枚举合法出法）
  driver.js     机器人对局驱动
server/   Node.js 服务端（零第三方依赖）
  ws.js         RFC6455 WebSocket 实现
  db.js         SQLite 持久化（会员/战绩/会话，node:sqlite）
  room.js       房间/大厅/对局会话
  bot.js        服务端机器人 + 超时托管代打
  index.js      HTTP + WS 入口
client-wechat/  微信小游戏客户端
  game.js       登录/大厅/房间/牌桌（理牌、提示、倒计时、重连）
  js/net.js     网络层（心跳、等待助手）
  js/card.js    Canvas 牌面渲染
```

### 协议

REST：`POST /api/register` `{name,password}`、`POST /api/login`、`GET /api/rooms`

WebSocket：`ws://host/?token=***

客户端 → 服务端：
- `{type:'create_room', stake, botFill}` 建房（stake 1-10 币/级）
- `{type:'join_room', roomId}` 加入
- `{type:'quick_match'}` 大厅排队
- `{type:'start_game'}` 房主开局
- `{type:'play', cards:[{id}]}` 出牌 / `{type:'pass'}` 过牌
- `{type:'hint'}` 请求出牌提示（返回最多8种候选）
- `{type:'leave_room'}` / `{type:'ping'}`

服务端 → 客户端：
- `welcome / pong / room_created / room_joined / room_state / queued / left_room`
- `game_start {seat, snapshot}` — 初始/重连快照（只含自己的手牌）
- `events [...]` — play/pass/finish/auto_play/new_trick/round_result/next_round/match_over
- `snapshot` — 每步后的最新状态
- `hint {options}` — 提示候选

### 服务端特性

- **超时托管**：30秒不出牌自动代打（最小能压牌，否则过）
- **断线重连**：掉线保留座位，重连后自动恢复牌局快照
- **持久化**：SQLite 存会员/币数/战绩/会话，重启不丢

## 微信小游戏合规要点

1. **主体**：小游戏虚拟支付（游戏币/房卡）必须**企业主体**注册，个人主体不可
2. **类目**：需申请"棋牌游戏"类目，并先取得**国家新闻出版署的游戏版号（ISBN）**
3. **支付**：取得版号后，使用微信虚拟支付（安卓）+ iOS 端按微信最新政策处理；**不得提供游戏币反向兑换现金**
4. **无版号过渡方案**：先做纯免费娱乐版（每日赠送游戏币、不可购买），用满资质后再开通充值
5. 防沉迷：需接入实名认证与未成年人保护（棋牌类强制）

## 路线图

- [x] 规则引擎 + 单元测试（26/26）
- [x] 机器人自动对局压测（500场）
- [x] 服务端：注册/登录/房间/大厅/实时对战/钱包结算
- [x] 4真人联调通过，钱包守恒
- [x] 出牌提示引擎（枚举合法出法）+ 提示协议
- [x] SQLite 持久化（重启不丢号）
- [x] 断线重连、超时托管（30秒代打）
- [x] 微信小游戏客户端：理牌/提示/倒计时/选牌动画/自动登录
- [ ] 微信开发者工具真机调试与美术资源
- [ ] 微信支付（版号到手后接入虚拟支付）
- [ ] 防沉迷实名认证
- [ ] 部署上线（备案域名 + WSS）
- [ ] 聊天/表情、回放与战绩榜
