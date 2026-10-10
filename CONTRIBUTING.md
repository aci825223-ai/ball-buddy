# 参与开发

提交问题、功能建议或 Pull Request 前，请阅读 [AGENTS.md](AGENTS.md)、[README.md](README.md) 与 [LICENSE](LICENSE)。项目当前面向 Windows，保持基础功能本地可用，联网需由用户主动触发。

## 环境与运行

使用 Node.js 22.12.0 或以上与 npm，在项目根目录执行：

```powershell
npm ci
npm --prefix server ci
npm start
```

所有依赖只安装在项目中。`src/main/` 负责窗口、受限 IPC、保存与网络，`src/shared/` 负责业务状态，`src/renderer/` 负责界面；独立共学服务位于 `server/`。业务状态以主进程为唯一来源，不在 renderer 中自行结算奖励。

## 提交前检查

```powershell
npm run check
npm test
npm run server-test
```

按实际影响选择 GUI 验证，而非为文档修改重跑整套交互测试：

| 变更 | 推荐验证 |
| --- | --- |
| 任务、计时或持久化 | `npm run smoke` |
| 布局、主题或字号 | `npm run theme-smoke` |
| 桌宠动画、注视、缩放或悬停 | 对应 `motion-smoke` / `interaction-smoke` / `size-smoke` / `hover-smoke` |
| 设置、字体或原生窗口偏好 | `npm run settings-smoke -- --packaged` |
| AI、拆解或双人共学 | `npm run ai-study-smoke -- --packaged` |
| 打包内容 | `npm run package` 后核对包内源码、服务与第三方许可 |

带 `--packaged` 的验证需要先生成便携包。GUI 验证使用 `artifacts/` 下的隔离数据，不操作个人应用记录；顺序执行，避免共享系统鼠标干扰。GIF 生成需已有 Python / Pillow，可通过 `BALL_BUDDY_PYTHON` 指定 Python 路径，脚本不会自动安装全局依赖。

`theme-audit.cjs`、`theme-finalize.cjs` 和 `theme-upgrade.cjs` 是维护者的本机历史交付 / 恢复节点工具，依赖未公开的本机存档和旧包，不能当作全新克隆后的通用检查。可复现验证从上方命令开始，细节见 [docs/VALIDATION.md](docs/VALIDATION.md)。

## Issue 与 Pull Request

问题反馈请说明版本、Windows 版本、复现步骤、预期与实际行为。截图只保留相关应用窗口，遮住真实聊天、任务、服务认证信息和密钥。功能建议请描述想完成的事与目前卡在哪里。

Pull Request 应说明具体行为变化与实际运行的检查；未完成的真实厂商 / 公网 / 设备验证应明确写出。保持修改范围集中，新目录先写职责约定，不夹带无关格式化或自动清理。

- 不提交 `node_modules/`、`dist/`、`artifacts/`、服务数据、`.env`、字体资产或个人记录。
- 不将真实 API 密钥、token、密码写入源码、测试、日志、截图或提交；测试凭据需清楚标为 fixture。
- 不通过关闭断言、注释报错或增加绕过标记使检查变绿。
- 保持 Electron 的 `contextIsolation`、`sandbox` 与关闭 `nodeIntegration`，只暴露校验后的明确 IPC。
- 新增联网、全局监听、系统修改或数据迁移需先说明其必要性与数据边界。

## 贡献许可

原创应用部分采用 MIT，新增原创代码沿用该部分许可。引入第三方代码或资源时应标明来源、固定版本和适用许可，并保留授权原文。

`vendor/emotion-ball/` 保留 sam70361 的固定版本与原始非商业社区许可；不要修改其授权或将其重标为 MIT。当前球形角色禁止商业用途。衍生视觉、截图与应用分发必须继续尊重上游限制，完整说明见根 [NOTICE](NOTICE.md)。
