# DSH Desktop

基于 DeepSeek Harness 的桌面客户端（Electron）：双击即用 —— 自动拉起 `dsh web`
本地服务并在原生窗口中打开，不再需要终端和浏览器。界面为 **Codex 桌面端风格**。

## 界面特性

- **无边框窗口**：Windows 原生窗口按钮（右上角系统绘制）+ Mica 毛玻璃材质 + 圆角阴影
  （Windows 11 22H2+；旧系统自动回退纯色）
- **Codex 深色皮肤**：深色主题下近黑底色、暖琥珀强调色、收敛圆角（外观设置可切换
  浅色/深色，浅色回到 DSH 原版）
- **顶部拖拽条**：32px 透明 caption，可拖动窗口、双击最大化（弹窗打开时自动让路）
- **右下角「在浏览器中打开」**：低调浮动按钮，一键在系统浏览器打开 Harness
- **启动页**：Codex 风格加载动画（透出 Mica）

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
- 退出时自动清理自己拉起的服务进程；对已存在的外部实例不产生任何影响
- 关闭窗口即退出（无系统托盘）

## 配置

| 方式 | 示例 |
| --- | --- |
| 参数 | `npm start -- --port 3099 --dsh-root D:\deepseek-harness` |
| 环境变量 | `DSH_DESKTOP_DSH_ROOT`（检出目录）、`DSH_DESKTOP_NODE_PATH`（node 路径） |

## 结构

```
dsh-desktop/
├── src/
│   ├── main.js                # 主进程：探测/拉起服务 + 窗口（原生控件 + Mica）+ 退出清理
│   ├── preload.cjs            # 注入 caption 拖拽条 + 右下角浏览器打开按钮 + 窗口控制桥
│   └── renderer/
│       ├── loading.html       # 启动页（Codex 风格）
│       └── codex-theme.css    # Codex 深色主题（insertCSS 注入，仅深色主题生效）
├── build/                     # 应用图标（icon.svg 为源，PNG/ICO 由 npm run icons 生成）
├── electron-builder.yml       # 打包配置（NSIS + 便携版）
└── package.json
```

## 图标

应用图标使用 DeepSeek 官方鲸鱼：蓝渐变圆角方块 + 白色鲸鱼。源文件 `build/icon.svg`，
用 `npm run icons`（@resvg/resvg-js 纯 CPU 渲染）重新生成各尺寸 PNG 与 ICO。
