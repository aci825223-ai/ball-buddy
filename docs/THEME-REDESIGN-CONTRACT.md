# 0.3.0 完整主题改版合同

用户已确认独立Apple桌面工具式预览。以docs/THEME-REDESIGN-PLAN.md和artifacts/design-previews/apple-workspace-2026-10-10/screenshots/revision-2/为视觉方向，正式版使用真实现有数据与行为，不导入示例。

## 框架与布局
- `.app-shell`：160px左侧`.app-sidebar`与可缩`.app-content`；880最小窗侧栏约144px。body为客户区大小，不产生横向溢出。
- 主导航仍为`.page-nav`中的原data-page=desk/chat/study与testid；设置`#settings-open`位于侧栏底部，标题、当前选中态和可访问名称清楚。设置返回原页面并恢复焦点。
- `.app-header`位于内容区顶部，高度64px；`#app-page-title`可显示当前页名。原桌宠显示切换与回到桌面入口保持可达，不新增伪macOS窗钮。
- 页内容占剩余高度。书桌`#desk-page.workspace`继续代表初始状态加载完成，任务面和约256px伙伴栏相邻，布置在其下；默认任务空态仍真实为空，最小窗口可纵向滚动。
- `.work-side`与`.companion-side`采用连续画布/安静次级表面，减少大卡片。任务原选择/完成语义、长title换行、已完成折叠保留，不增加任务描述字段。
- `#main-ball`只有一个动画实例。书桌插入在明确直接子节点`.desk-store`之前；聊天放`#chat-companion-slot`并采用紧凑布局，仍可控制个人专注。不得复制ID或实例。
- 聊天正文独立滚动；模型选择、历史入口、附带任务、停止/发送均保留，输入区默认/最小、大字号首屏可达。拆解为连续编辑行，确认入库仍需选择。
- 共学真实空房间/等待/离线状态保留；房间邀请条、双球共同计时/准备控制、右侧聊天形成统一框架。最小窗口房间输入/发送及计时主要动作完整可见，消息内容内部滚动。
- 设置左二级分组、右连续偏好行；保存状态与返回入口保持可见，AI组明确手动保存/测试。分组/字体busy/键盘导航原语义保留。

## 视觉与主题
- 浅：canvas #F5F5F7、paper #FFFFFF、secondary #EFEFF2、sidebar #EEEEF1、scene #F7F6F3、ink #1D1D1F、muted #626267、primary #0066CC、on-primary #FFFFFF、line #E4E4E8、field-line #D2D2D8、selected #E4EFFC。
- 深：canvas #171719、paper #202023、secondary #2B2B30、sidebar #1C1C1F、scene #252526、ink #F3F3F5、muted #A8A8AF、primary #78B1FF、on-primary #122038、line #37373C、field-line #515158、selected #283B55。
- 现有CSS变量`--green`等名字可保留作为兼容别名，不影响业务。按钮前景与表面分开。控件8px、分组12px、气泡16px，装饰和实时角色保持既有配色。
- 默认正文14px、辅助12px、标题25px、分组17px，时钟48–52px；按既有text-scale和导入字体适配。用户字号三档小/标准/大继续为0.9/1/1.15，不重设偏好。
- 桌宠根/body始终transparent，气泡和操作条采用新主题；悬停、键盘门禁、延迟收起、70%–150%不裁切、两行正文与尾巴分层合同保留。
- 原生主窗背景色若必须与renderer同步，允许仅更新颜色常量并单独列出hash差异；不能借此改窗口/存储/网络行为。

## 协作与验证
- UI框架负责人：index.html、styles.css、extensions.js。设置/主题负责人：appearance.css、settings.css、pet.css、必要的settings.js。扩展页面负责人：extensions.css。root负责文档、版本、元数据、验收脚本、集成、打包、必要原生背景常量。
- 所有人不得覆盖其他负责人的文件；接口变化主动同步。所有GUI验收由root串行执行。
- 布局验证继续检查任务左、伙伴右、底部横排布置；进展页脚按已审预览放在任务区底部并保持默认可见，不再要求位于布置之后。新增侧栏、页头与内容边界。辅助文字要求按默认12px更新，消息/球体仍保持清楚间距；不能放宽真实行为断言。
- 跑test/check/server-test及真实smoke/settings/AI-study/hover。实际连续帧验证仍必需。未提供API或公网服务器时只报告本地协议fixture与两个Electron客户端。
- 保留旧节点与失败结果，不删除、不修改真实凭据、不改schema。最终包逐项与源码比对，再正常退出旧软件并打开新版，升级前后个人状态只记录hash及非敏感计数。

## 验收发现的 Windows 置顶兼容修复
- 0.2.0与0.3.0隔离实例均复现Electron44默认floating层级在当前任务栏状态下返回非置顶；显式pop-up-menu层级返回置顶。上游Windows实现会将floating放到任务栏后。
- main只在用户开启置顶、默认层级实际未生效时使用Electron支持的pop-up-menu兜底；显示桌宠后重新应用偏好。关闭置顶仍使用默认关闭路径，不修改系统任务栏/设置或持久化schema。
- 这是除浅深窗口背景外唯一新增主进程差异，必须在最终包基础和设置回归中验证并在审计中明确。

## 共学重连状态的视觉文案修复
- 独立图审发现断网后中央提示沿用缓存running状态，与页头重连信息冲突。study.js仅在连接未恢复时将中央文字显示为等待重连；服务端轮次、时间、IPC、按钮权限及结算保持。
- 加入重连/恢复暂停状态文字断言，最终包真实两客户端复验；该文件列为明确的显示层差异。
