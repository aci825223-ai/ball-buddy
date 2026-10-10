# 开发与运行

当前桌面版本为 0.3.0，实际开发和 GUI 验收平台为 Windows。需要 Node.js 22.12.0 或更高版本及 npm；Git 用于克隆源码。所有依赖安装到项目，不需要全局 Electron 或全局 Playwright。

## 启动桌面应用

克隆仓库后，在仓库根目录执行：

```powershell
npm ci
npm --prefix server ci
npm start
```

根安装脚本准备项目内 Electron；Windows 备用下载路径会校验官方校验和。共学服务依赖单独安装，根 `npm ci` 不会替 `server/` 安装依赖。

打开后任务列表为空。在书桌添加任务，再开始专注；设置里可调整主题、字体、文字大小、桌宠大小和关闭行为。默认关闭主窗口是隐藏到托盘，托盘“退出小球同桌”会彻底退出。正常使用应用会写入自己的 Electron `userData`；验收脚本使用隔离数据。

## 配置 AI

1. 打开“设置 → AI 连接”，添加服务名、协议、API 地址、模型 ID 和自己的密钥。
2. 明确保存连接；保存成功不代表网络连通，可以再主动测试或读取模型列表。
3. 在聊天页发送文字，或通过“帮我拆解”生成步骤，编辑/选择后确认加入任务。

支持 OpenAI 兼容 Chat Completions、Anthropic Messages 和 Gemini 文本协议。模型与服务地址必须匹配所选协议，兼容程度需用自己的实际服务测试。请求可能按服务商规则计费。本仓库不提供密钥，不需要把密钥写入源码或 `.env`。

密钥在系统加密可用时加密保存；不可用时只在当次运行使用。聊天文字会本地保存，停止或重启不会自动重发中断请求。当前记录的三协议验收使用本机 HTTP/SSE fixture，尚不能替代真实厂商连接结果。

## 本机共学服务

先完成 `server/` 依赖安装，然后从仓库根执行：

```powershell
npm run study-server
```

默认房间数据写入 `server/data/`，该目录不提交。桌面应用填写 `ws://127.0.0.1:8787/study`，一方创建房间，另一客户端连接同一个服务并输入六位邀请码。日常软件采用单实例；自动化两客户端验证由隔离烟测脚本负责启动多个实例。

需要改变服务数据位置时，直接调用服务项目并指定目录：

```powershell
$studyDataDirectory = Join-Path (Get-Location) 'server/data'
npm --prefix server start -- --host 127.0.0.1 --port 8787 --data-directory $studyDataDirectory
```

以上命令从仓库根启动，并将仓库内 `server/data/` 解析为绝对目录传给服务，避免 npm 切换工作目录造成路径差异。实际运维也可为 `--data-directory` 提供自己选择的绝对目录。服务数据与备份包含房间消息，需要自行保管；程序不会自动删除旧数据。

跨网络时，两台电脑需要能访问同一个自建服务。生产环境应配置支持 WebSocket 升级的 TLS 反向代理，客户端使用 `wss://你的域名/study`。邀请码不提供网络穿透，软件不会自动部署服务器或修改防火墙。详细配置、容量和崩溃恢复边界见 [server/README.md](../server/README.md)。当前已验两个本机真实 Electron 客户端；实际公网连通需要另行测试。

## 验证

根目录的基本检查：

```powershell
npm run check
npm test
npm run server-test
```

修改 UI、原生窗口或互动时运行相应的真实 Electron 验收：

```powershell
npm run smoke
npm run theme-smoke
npm run settings-smoke
npm run ai-study-smoke
npm run hover-smoke
```

报告、隔离状态、截图和动画采样写入 `artifacts/`。涉及鼠标的脚本会短暂移动系统指针，请依次运行并让鼠标闲置，避免多个 GUI 验收互相干扰。AI/共学验收使用本机测试接口，不要求真实 API 密钥。

生成实际动画帧的 GIF 预览时，`motion-smoke`、`interaction-smoke`、`hover-smoke` 和 `ai-study-smoke` 还需要已有的 Python 解释器及 Pillow（能执行 `import PIL`）。可用 `BALL_BUDDY_PYTHON` 指定该解释器，例如已有项目虚拟环境时：

```powershell
$env:BALL_BUDDY_PYTHON = (Resolve-Path '.venv/Scripts/python.exe').Path
& $env:BALL_BUDDY_PYTHON -c 'import PIL'
npm run hover-smoke
```

这只为当前 PowerShell 会话选择运行时；验收脚本不会自动安装 Python、Pillow 或任何全局依赖。普通应用运行、核心测试和打包不需要 Python。

`theme-audit.cjs`、`theme-finalize.cjs`、`theme-upgrade.cjs` 保留的是维护者本机 0.2.0→0.3.0 存档/升级工具，依赖不进入仓库的本机恢复节点或历史报告；新克隆不应把它们当作通用启动或必需检查步骤。

## 打包 Windows 便携目录

```powershell
npm run package
```

输出位于 `dist/BallBuddy-<version>-win-<arch>`；已有同名目录时使用时间后缀，不覆盖旧包。最新输出索引在 `artifacts/package.json`。双击输出内 `BallBuddy.exe`，保留整个文件夹。包内 `study-server/` 是独立服务，运行仍需要 Node.js。

某些 GUI 验收可以使用 `--packaged` 检查最新输出，例如：

```powershell
npm run settings-smoke -- --packaged
npm run ai-study-smoke -- --packaged
npm run hover-smoke -- --packaged
```

当前交付没有代码签名或安装器。运行数据与程序目录独立；共享源码或程序包时不要附带 `userData`、导入字体、私人会话、房间数据或 API 凭据。

## 授权

原创应用部分的授权见根 [LICENSE](../LICENSE)。角色动画来自 **sam70361** 的 [EmotionBall](https://github.com/sam70361/emotion-ball)，上游代码与视觉仍受 [原许可](../vendor/emotion-ball/LICENSE) 和 [NOTICE](../vendor/emotion-ball/NOTICE.md) 约束，球形角色视觉禁止商业用途。公开源码不代表整个仓库拥有无商用限制的 MIT 授权。
