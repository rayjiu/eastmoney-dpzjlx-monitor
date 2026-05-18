# 东方财富大盘资金流分时监控

Chrome 扩展，在东方财富大盘资金流向页面右侧注入一个浮窗，把原本要 hover 折线图才能看到的每分钟资金流向数据，直接以表格形式实时展示。

## 功能

- 监听 `data.eastmoney.com/zjlx/dpzjlx.html` 页面
- 右侧可拖拽浮窗，支持折叠/展开（状态持久化）
- 4 个市场切换：沪深两市 / 沪市 / 深市 / 创业板
- 顶部 KPI 卡：实时主力净流入 + 主力净比 + 上证/深证点位
- 表格列：时间、主力、超大、大单、中单、小单、主力净比%
- 最新一行高亮 + 左侧黄色指示条
- 一键导出 CSV（含全部 15 个字段：5 档净流入金额 + 5 档净占比 + 上证/深证收盘+涨跌幅）
- 自动判断交易时段：盘中 6 秒轮询，休市降级为 60 秒

## 数据来源

直接调东方财富公开接口，不依赖页面 DOM，更稳定：

- 分时序列：`push2.eastmoney.com/api/qt/stock/fflow/kline/get?klt=1`（休市也能拿到最近交易日数据）
- 实时快照：`push2.eastmoney.com/api/qt/ulist.np/get`

## 安装

1. 下载/克隆本目录
2. Chrome 打开 `chrome://extensions/`
3. 右上角打开「开发者模式」
4. 点「加载已解压的扩展程序」，选择本目录
5. 访问 `https://data.eastmoney.com/zjlx/dpzjlx.html`，右侧应出现浮窗

## 文件结构

```
eastmoney-dpzjlx-monitor/
├── manifest.json    # MV3 配置
├── content.js       # 主逻辑(注入、轮询、渲染、导出)
├── panel.css        # 浮窗样式
├── icons/           # 图标
└── README.md
```

## 字段映射

`fflow/kline/get` 接口 `klt=1` + `fields2=f51..f65` 返回的逗号分隔字段顺序：

| 索引 | 字段 | 含义 |
|------|------|------|
| 0 | f51 | 时间 HH:mm |
| 1 | f52 | 主力净流入(元) |
| 2 | f53 | 小单净流入(元) |
| 3 | f54 | 中单净流入(元) |
| 4 | f55 | 大单净流入(元) |
| 5 | f56 | 超大单净流入(元) |
| 6 | f57 | 主力净占比(%) |
| 7 | f58 | 小单净占比(%) |
| 8 | f59 | 中单净占比(%) |
| 9 | f60 | 大单净占比(%) |
| 10 | f61 | 超大单净占比(%) |
| 11 | f62 | 上证收盘 |
| 12 | f63 | 上证涨跌幅(%) |
| 13 | f64 | 深证收盘 |
| 14 | f65 | 深证涨跌幅(%) |

注意 f53/f54/f55/f56 在接口返回里**不是按"超大/大/中/小"顺序**，而是"小/中/大/超大"，UI 已对齐处理。

## 已知限制

- 接口的 `ut` 参数是东方财富前端写死的固定 token，未来若失效需要从原页面请求里抓新值
- 跨日界历史回放尚未做，目前只显示当日。若需要可加日期选择器调用 `beg`/`end` 参数
- B 股没做（沪B/深B 资金流向小众，需要时改 `MARKETS` 配置加一行即可）

## 调试

打开浮窗所在 Tab 的 DevTools，Console 里可以看到 `[em-dpzjlx]` 前缀的错误日志。手动测试接口：

```javascript
fetch('https://push2.eastmoney.com/api/qt/stock/fflow/kline/get?lmt=0&klt=1&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65&ut=b2884a393a59ad64002292a3e90d46a5&secid=1.000001&secid2=0.399001')
  .then(r => r.json()).then(j => console.log(j.data.klines.slice(-3)))
```
