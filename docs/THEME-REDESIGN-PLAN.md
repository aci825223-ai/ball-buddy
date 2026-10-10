# 小球同桌 · 整体主题重新设计方案

状态：**已实施并交付**。用户回复“按这版实施”后完成0.3.0改版、真实包验收与独立视觉收尾；已正常退出0.2.0并打开新版书桌和桌宠，个人状态与资产哈希保持。预览与正式版验收分别记录，详见docs/VALIDATION.md及artifacts/theme-0.3.0/。

用户要求先保留当前节点，再参考 Apple 等成熟产品重新设计软件。按照用户提供的 AGENTS.md 约定：“大改动前先在 Plan Mode 出方案，我确认后再动手”，本阶段先完成存档和可交互视觉稿，确认后修改正式界面。

## 恢复节点

目录：[0.2.0 存档](../artifacts/checkpoints/0.2.0-2026-10-10T14-40-00Z/README.md)。以其中 checkpoint.json 的 verified 状态和 ZIP 校验结果为准。

- project.zip 保存改版前源码、依赖锁定清单、规则与原有设计文档。
- portable.zip 保存完整已验证 Windows 软件与共学服务。
- evidence/ 保存精选原版验收依据；checkpoint.json 提供逐文件及 ZIP SHA-256。
- 恢复时解压到新目录，继续使用当前个人记录。本节点不打包个人任务、私聊、API 密钥、字体或房间凭据，不自动回滚个人记录，不覆盖或删除现有目录。

## 设计判断

采用 **Apple 桌面工具式的安静工作空间**。参考 Reminders 的任务列表、Notes 的阅读布局、System Settings 的设置分组；吸收对齐、内容主次、渐进展示和适量材质感。

旧界面的主要问题：大片空态与密集伙伴栏相邻，浅青在多个层级反复使用，辅助文字过碎，聊天、共学和设置的页面结构不一致。新设计同时改变框架、组件、信息层级与视觉系统。

产品特色仍是会持续动作、看向鼠标并回应互动的小球。用户打开窗口时先看清当前任务和主要动作，再感受到伙伴陪伴。

## 全应用框架

- 左侧约 160px 常驻导航：书桌、聊天、双人共学、设置；最小窗口收至约 144px。
- 内容区顶端统一约 64px 页头：页面名称、真实当前状态和本页动作。操作位置稳定。
- 白色或深灰连续内容面，以对齐、留白和细分隔线建立层级；圆角只用于实际控件、气泡和必要分组。
- 保持 Windows 窗口行为，不使用伪 macOS 红黄绿按钮、Apple 标识或未经授权的 SF 字体。
- 默认 1040×780、最小 880×680，按实际客户区检查；长内容内部滚动，输入和主要动作保持可达。

## 页面结构

| 页面 | 新版结构与主要动作 |
| --- | --- |
| 书桌 | 左侧连续任务列表与添加行；右侧约 250–260px 伙伴栏，依次是计时、开始/暂停、实时小球、两条紧凑动作/大小设置；底部布置保留。默认空任务仍为空，不写入演示数据。 |
| 聊天 | 正文占据主要空间，AI 输出自然排版、用户消息用淡中性色气泡；模型信息放页头，历史按需展开；输入固定可达，保留停止、重试、复制及附带任务行为。 |
| 任务拆解 | 连续编辑列表，勾选、标题、时间对齐；底部明确“加入选中任务”，生成、失败和部分选择状态均可见。 |
| 双人共学 | 紧凑房间码/邀请栏，双球与共同计时形成一个学习空间；右侧房间聊天，准备/暂停/继续放在计时旁；真实等待、离线、重连状态紧邻昵称。 |
| 设置 | 同一应用框架内的二级分类导航，右侧连续偏好行；外观、窗口、桌宠、专注及 AI 配置统一排版；普通偏好保存状态常驻，AI 仍显式保存和测试。 |
| 桌宠 | 透明窗口和实时动画保留；消息气泡与操作条统一新主题的表面、轮廓和阴影，仍默认悬停显示并适配 70%–150%。 |

## 视觉基础

| 语义 | 浅色 | 深色 |
| --- | --- | --- |
| 画布 | #F5F5F7 | #171719 |
| 内容表面 | #FFFFFF | #202023 |
| 次级表面 | #EFEFF2 | #2B2B30 |
| 主文字 | #1D1D1F | #F3F3F5 |
| 辅助文字 | #626267 | #A8A8AF |
| 主要操作 | #0066CC | #78B1FF |
| 主按钮文字 | #FFFFFF | #122038 |

- 使用系统字体栈和用户导入字体；默认正文 14px、辅助 12px、分组 17px、标题 25–28px、时钟约 48–52px，数字等宽。
- 统一 4px 间距基础；通常 24px 内容边距、最小窗口约 20px；控件圆角 8px、分组 12px、气泡 16px。
- 蓝色用于主要操作、选中、链接和焦点，语义状态使用对应颜色。连接状态也有文字，不仅依赖颜色。
- 侧栏和临时浮层可有轻微材质感；内容区清楚稳定。减少动画偏好仍有效，无等待式入场动画。
- 焦点清楚可见，图标有可访问名称，普通动作目标约 40–44px；大文字和导入宽字体通过滚动及重排适配。

## 行为与代码边界

本次不增加功能，也不改变存储 schema、业务命令或网络协议。主题浅/深/跟随系统、用户字体、文字大小、关闭到托盘/退出、动画偏好等现有设置继续生效。

- 原始任务、计时、奖励、布置、未知偏好和 AI/房间状态保留，版本升级不得覆盖个人数据。
- main/shared/preload/server/vendor 原则上保持哈希一致。网络仍只在主进程和独立服务，renderer 的 connect-src none 保留。
- renderer 以 index.html 与 CSS 为主，必要时只调整 extensions.js 的布局集成；主球仍单实例，在书桌/聊天之间搬移，隐藏页面继续停帧。
- 稳定 ID、data-testid、form 归属与脚本初始化顺序保留。设置返回来源页、键盘焦点、草稿及计时不因切页丢失。
- 正式实施前更新 AGENTS.md、DESIGN.md、docs/SURFACE.md 与相关布局合同；之后按新合同更新几何验收，不删掉行为门禁来让测试通过。

## 实施顺序与验收

1. 用户确认本方案与交互预览。
2. 更新正式设计合同与元数据，再实现 shell、书桌、聊天/拆解、共学、设置、桌宠主题。
3. 跑应用和服务测试及 check；检查未改业务文件哈希。
4. 真实 Electron 默认/最小、浅/深、大文字/导入字体截图；检查长任务、长聊天、历史展开、输入和共学控制可达。
5. 真实验证任务、计时、设置、AI 流式/停止、拆解选中入库与两个共学客户端；动画依靠连续帧，气泡依靠真实 hover/键盘和缩放检查。
6. 独立视觉收尾审查，通过后打包；审计包与源码及授权一致，记录新版本升级前后个人状态哈希。

对应现有命令：npm test、npm run check、npm run server-test、npm run smoke、npm run settings-smoke -- --packaged、npm run ai-study-smoke -- --packaged、npm run hover-smoke -- --packaged、npm run package。GUI 检查串行执行。

预览检查只验证设计本身。真实厂商 API 和实际公网共学仍须另有外部连接，不能用预览或本地 fixture 代替。

## 当前可评审材料

[交互预览](../artifacts/design-previews/apple-workspace-2026-10-10/proposal.html)可切页和深浅主题，常驻标明“设计预览 · 示例内容”，不读取真实个人记录或连接 AI/共学服务。浏览器截图与检查见该目录 screenshots/ 和 preview-report.json。

预览 revision-2 已通过 103 项浏览器检查并保存 23 张页面截图；默认/最小 × 浅/深四页布局、最小大字与历史展开、主要操作可达已检查。现有小球运行时采样到 12 个主球与 8 个伙伴不同连续 SVG 帧，附近眼神与点击互动实际响应。首轮最小共学消息输入裁切已修复，失败证据保留。此结果仅属于提案，不把它记为正式软件验证。

## 官方参考

- [Apple HIG · Layout](https://developer.apple.com/design/human-interface-guidelines/layout)
- [Apple HIG · Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars)
- [Apple HIG · Typography](https://developer.apple.com/design/human-interface-guidelines/typography)
- [Apple HIG · Materials](https://developer.apple.com/design/human-interface-guidelines/materials)
- [Reminders](https://support.apple.com/guide/reminders/welcome/mac)、[Notes](https://support.apple.com/guide/notes/welcome/mac)、[System Settings](https://support.apple.com/guide/mac-help/change-system-settings-mh15217/mac)
