# DSH Desktop

基于 DeepSeek Harness 的桌面客户端（Electron）：双击即用 —— 自动拉起 `dsh web`
本地服务并在原生窗口中打开，不再需要终端和浏览器。界面为 **Codex 桌面端风格**。

v0.2 起在"窗口壳"之上增加桌面控制层能力（部分思路与实现借鉴
[DshCockpit](https://github.com/Lxiayu/DshCockpit)，MIT）。

## 界面特性

- **无边框窗口**：Windows 原生窗口按钮（右上角系统绘制）+ Mica 毛玻璃材质 + 圆角阴影
  （Windows 11 22H2+；旧系统自动回退纯色）
- **Codex 深色皮肤**：深色主题下近黑底色、暖琥珀强调色、收敛圆角（外观设置可切换
  浅色/深色，浅色回到 DSH 原版）
- **顶部拖拽条**：32px 透明 caption，可拖动窗口、双击最大化（弹窗打开时自动让路）
- **右下角「在浏览器中打开」**：低调浮动按钮，一键在系统浏览器打开 Harness
- **启动页**：Codex 风格加载动画（透出 Mica）

## v0.2 控制层功能

| 功能 | 说明 |
| --- | --- |
| 托盘常驻 | 关闭窗口 = 最小化到托盘，dsh 服务继续后台运行（IM 渠道不中断）；托盘菜单：显示 / 浏览器打开 / Quick Ask / 重启服务 / 清理缓存 / 打开数据目录 / 退出 |
| Token/Context 胶囊 | 右上角悬浮胶囊实时显示当前会话上下文压力（60% 黄 / 85% 红），点击展开明细：最近请求 token、输入/输出、缓存读写、会话数、今日/本周/本月估算成本、预算状态、官方余额、存储占用。数据来自 `~/.dsh` 会话日志本地解析（5s 轮询，增量+缓存），完全离线 |
| 成本估算 | 按官方价目表折算金额（支持峰谷分时），今日/本周/本月；`monthlyBudget` 设置后 80%/100% 自动气泡报警。估算值仅供参考 |
| 官方余额 | 配置 DEEPSEEK_API_KEY（env > `~/.dsh/.credentials.yaml` > `~/.dsh/.env`）后轮询官方余额并低额提醒；key 不落日志不进 IPC 外传 |
| Quick Ask | 全局热键 `Ctrl+Alt+Space` 弹出快捷问询小窗，经 `dsh --profile headless` 后台运行，完成弹通知 |
| 运行时更新检查 | 对比 npm registry 最新版与本机版本（每 24h），有新版气泡提示 |
| 窗口记忆 / 自启 | 记住上次窗口位置；`settings.json` 设 `autoLaunch: true` 开机自启（仅打包态生效） |

设置项（`%APPDATA%/dsh-desktop/settings.json`）：`winBounds`、`autoLaunch`、
`contextWindow`（压力分母，默认 128000）、`monthlyBudget`、`costPeakEnabled`、
`costPeakWindows`（如 `"9-12,14-18"`）、`costModel`、`quickAskHotkey`、`dshHome`。

## 使用

```powershell
cd D:\1\dsh-desktop
npm install
npm start
```

或使用打包产物（dist 目录）：

```powershell
npm run dist           # 生成安装包 + 便携版
npm run dist:portable  # 仅便携版单文件
```

## 行为

- 启动时探测本地 dsh 实例（默认端口 3080）：**有则直接连接**（不重复启动，避免两个
  服务并发读写 ~/.dsh 会话）；没有则在空闲端口自动拉起，健康后加载界面
- **关闭窗口不再退出**：应用最小化到托盘，自己拉起的 dsh 服务继续后台运行；
  托盘「退出」才真正结束并清理受管服务；对外部实例（如脚本拉起的）始终不干预
- 上次壳异常退出残留的服务进程会在下次启动时被自动附着复用（不做孤儿查杀——
  本机 dsh 是常驻服务，IM 渠道依赖它存活）

## 配置

| 方式 | 示例 |
| --- | --- |
| 参数 | `npm start -- --port 3099 --dsh-root D:\deepseek-harness` |
| 环境变量 | `DSH_DESKTOP_DSH_ROOT`（检出目录）、`DSH_DESKTOP_NODE_PATH`（node 路径） |

## 结构

```
dsh-desktop/
├── src/
│   ├── main.js                # 主进程：服务管理 + 窗口 + 托盘 + Token/成本轮询 + Quick Ask + 更新检查
│   ├── preload.cjs            # 注入 caption/浏览器按钮 + Token 胶囊 UI + IPC 桥
│   ├── token-stats.js         # 会话日志 token 解析（借鉴 DshCockpit，MIT）
│   ├── cost.js                # 官方价目折算 + 峰谷 + 日历史 + 预算检查（借鉴 DshCockpit，MIT）
│   ├── balance.js             # DeepSeek 官方余额监控（复制自 DshCockpit，MIT）
│   ├── headless.js            # dsh --profile headless 一次性运行（Quick Ask 用）
│   └── renderer/
│       ├── loading.html       # 启动页（Codex 风格）
│       ├── codex-theme.css    # Codex 深色主题（insertCSS 注入，仅深色主题生效）
│       └── quickask*          # Quick Ask 小窗（html/preload/renderer）
├── build/                     # 应用图标（icon.svg 为源，PNG/ICO 由 npm run icons 生成）
├── electron-builder.yml       # 打包配置（NSIS + 便携版；icon.ico 进 extraResources 供托盘用）
└── package.json
```

## 图标

应用图标使用 DeepSeek 官方鲸鱼：蓝渐变圆角方块 + 白色鲸鱼。源文件 `build/icon.svg`，
用 `npm run icons`（@resvg/resvg-js 纯 CPU 渲染）重新生成各尺寸 PNG 与 ICO。
