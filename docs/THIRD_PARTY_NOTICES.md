# 第三方来源与许可

原创代码的 MIT 范围见根 [LICENSE](../LICENSE)。本页说明直接集成或依赖的项目，不替代各项目完整许可。

| 项目 | 版本或来源 | 许可与用途 |
| --- | --- | --- |
| [EmotionBall / sam70361](https://github.com/sam70361/emotion-ball) | 固定提交 `e3b6148c818da4a8e1966f2bc89cdb3cee473b73`，收录来源 `sam70361/aora-bot` | Emotion Ball Community License；非商业署名分享；球形角色视觉禁止商业使用。原始 JS 与完整条款保存在 `vendor/emotion-ball/`。 |
| [Electron](https://github.com/electron/electron) | 44.7.0 | MIT，桌面运行时；所含 Chromium、Node.js 等组件保留自己的许可。新包将 Electron 的原始 `LICENSE` 原样另存为 `LICENSE.electron.txt`，并保留 `LICENSES.chromium.html` 等文件，避免与应用根许可重名。 |
| [Playwright](https://github.com/microsoft/playwright) | 1.64.0 | Apache-2.0，本地开发与界面验证；不打包进应用运行代码。 |
| [ws](https://github.com/websockets/ws) | 8.18.3 | MIT，独立共学服务的 WebSocket 依赖；随服务打包时保留其许可。 |

`package-lock.json` 与 `server/package-lock.json` 固定直接及传递依赖，并保留包元数据中的许可标识。源码仓库不提交 `node_modules/`；通过 `npm ci` 安装后，各包的完整许可随包保存在本地。重新分发依赖或便携包时需保留相应声明。

EmotionBall 来源、作者、原始文件与完整限制也见根 [NOTICE.md](../NOTICE.md)。角色集成、衍生呈现、图标与公开截图不会因原创应用代码采用 MIT 而获得额外商业使用权。
