# web/

Strategy to Video · 本地网页服务（V0.1 + V0.2 预览 + 策略卡通道）。

安装、启动与完整操作步骤见仓库根目录 `README.md`。

## 可执行通道

| 策略标识 | 入口 | 数据来源 | 说明 |
|---|---|---|---|
| `macd` | MACD 演示策略 | SIMULATED 模拟数据 | V0.1 固定参数，视频 V1.2.2 |
| `timeseries` | 通用时间序列 | 用户 CSV | A 类折线 |
| `cross_section` | 横向对比 | 用户 CSV | B 类条形 |
| `stock_ohlc` | 股票日线 | 用户 CSV | C 类，MACD → V1.2.4 渲染 + 41 项验收 |
| `strategy_card` | **策略回测视频（自动取数）** | 东方财富未复权日线 | 代码 + 区间 + 模板，无需 CSV |

`strategy_card` 的模板与前端表单同源于 `src/strategyCard.js`：

- `close_buy_open_sell`：尾盘买入 · 次日开盘卖出（可选开盘跳空持仓阈值）
- `macd_cross`：MACD(12,26,9) 金叉买入 · 死叉卖出

## 目录要点

- `server.js`：HTTP 入口，`/api/health` 的能力自述由 `STRATEGY_MODES` 单点派生。
- `src/validation.js`：请求白名单与归一化；策略卡由 `src/strategyCard.js` 装配。
- `src/taskManager.js`：任务状态机与留档（`source.csv` / `dividend.csv` / `card.json` / `status.json`）。
- `src/engineBridge.js`：并发守卫与适配器路由。
- `src/adapters/`：每个可执行策略一个适配器，策略专有流程不写进桥接层。

## 回归

```bash
node tools/check_strategy_card_api.cjs   # 策略卡校验/任务装配，离线，期望 36/36
node tools/e2e_strategy_card_web.cjs     # 起服务走 HTTP 全链路，需要东方财富网络
npm run check:api                        # health 能力口径，期望 6/6
```
