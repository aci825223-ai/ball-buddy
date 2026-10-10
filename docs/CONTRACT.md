# 并行实现接口

## 0.3.0 视觉集成接口

用户已确认完整主题改版。当前布局/视觉以[THEME-REDESIGN-CONTRACT.md](THEME-REDESIGN-CONTRACT.md)为准，本文件所有状态、IPC、设置/AI/共学与动画行为合同继续有效。原顶栏主导航转到常驻侧栏，设置在底部；页头仅显示当前页名与常用动作。单个真实主球可在书桌与聊天之间移动，隐藏页面继续停帧。正文默认14px/辅助12px，大文字和导入字体按已有偏好适配。

## 0.2.0 扩展接口

用户已批准AI/聊天/任务拆解/跨网络共学。新服务、固定桥与事件见[AI-STUDY-CONTRACT.md](AI-STUDY-CONTRACT.md)。保留以下旧接口；AI请求和配置只在主面板，聊天正文/Key不进入全量state。app.study只包含公开房间状态、成员和计时，不含消息历史或重连token；完整房间消息通过主面板专用事件提供。

## 0.1.5 设置接口

新增settings默认字段：themeMode='system'（light/dark/system）、closeBehavior='tray'（tray/quit）、fontFamily='system'（system/yahei/segoe/custom）、textSize='normal'（small/normal/large，对应0.9/1/1.15）、importedFont=null或{id,name}、petAlwaysOnTop=true、petHints='hover'（hover/always）、openPanelOnLaunch=true、notificationsEnabled=true。沿用focusMinutes、motionMode、petScale。未知字段继续保留。

settings.update原子更新上述普通偏好；importedFont不能通过公共command任意赋值，fontFamily=custom仅在已有合法导入字体描述时可选。settings.reset恢复已知偏好默认值，保留petPosition、importedFont描述、业务数据和未知设置；大小恢复100%时保持当前桌宠左上角，工作区放不下时才约束位置，普通大小调整仍尽量固定中心。字体切回system但可再次选择已有导入字体。内部字体提交命令不可经公共buddy:command调用。

app快照新增resolvedTheme='light'|'dark'、version、notificationsSupported、fontRevision（本进程字体成功导入的递增序号，不持久化）。系统主题变化广播两窗；状态保存成功后才设置nativeTheme.themeSource、原生背景与置顶等副作用。成功重新导入同一字体也递增fontRevision，让另一窗从缺失回退中重新加载；字体请求失败不能永久缓存失败Promise。

受限桥接新增：
- importFont()，仅面板主frame：原生选择单个字体，返回{ok:true,cancelled:true}或{ok:true,pendingId,font:{id,name},bytes:Uint8Array}或{ok:false,error}。
- confirmFontImport(pendingId)，仅面板主frame：确认本次候选并返回常规{ok:true,state}|{ok:false,error}；保存成功后使用custom。
- cancelFontImport(pendingId)，仅面板主frame：释放本次候选，返回{ok:true}；不删除文件。
- getActiveFont()，两窗主frame、无参数：返回{ok:true,font:null}或{ok:true,font:{id,name},bytes:Uint8Array}或{ok:false,error}；只读取当前已保存资产。
- resetPetPosition()，仅面板主frame、无参数：回到小球当前所在显示器工作区右下角并保存，返回常规CommandResult，保持大小。

字体资产id为SHA-256加合法扩展名，name为不包含路径或控制字符的展示名，最多160个完整Unicode字符。候选只保留在内存，FontFace解码成功后才确认落盘；文件范围32MiB，签名校验与实际解码都通过方可启用。两窗字体应用需处理异步竞争和缺失回退，不在每次状态广播重复读取字体。恢复默认和切换字体不删除资产。

稳定设置选择器：settings-open、settings-back、settings-page；导航data-settings-section=appearance/window/pet/focus；settings-theme内data-theme-mode=light/dark/system；settings-font-family、settings-font-import、settings-font-reset、settings-text-size内data-text-size=small/normal/large；settings-close-behavior、settings-open-panel-launch、settings-pet-always-on-top、settings-pet-hints、settings-pet-scale、settings-pet-motion内data-settings-motion、settings-pet-position-reset、settings-focus-minutes、settings-notifications、settings-reset。原工作台testid/ID保持。

分组滚动导航后，settings-back与settings-save-status及失败说明仍在当前视口内可见，作为左侧常驻导航的一部分；不能让正在保存/已保存/没有保存反馈只出现在滚出视口的页顶。大字体任务添加按钮标签保持一行，输入区域可缩，不允许“添加”垂直拆字。

## 状态（可序列化 JSON）
```js
{
  version: 1,
  tasks: [{ id, title, createdAt, completedAt: null }],
  selectedTaskId: null,
  session: null, // 或 { id, taskId, status: 'running'|'paused', durationMs, remainingMs, endAt }
  stats: { energy: 0, completedTasks: 0, focusSessions: 0, totalFocusMs: 0 },
  decorations: [], // 'lamp', 'plant', 'books'
  settings: { focusMinutes: 25, motionMode: 'full', petScale: 100 }, // motion: full / gentle / static; scale: 70–150 integer percent
  lastEvent: null // 或 { id, kind, message, at }，用于有期限的庆祝反馈
}
```
`endAt` 为 Unix 毫秒时间戳；运行时剩余时间由 `Math.max(0, endAt - Date.now())` 推导。running remainingMs 是当前活跃片段开始时的余额，仅用于累计时间核算；暂停时 remainingMs 是冻结剩余时间。标题最多 140 字；默认任务为空，不放伪装为用户任务的示例数据。

## 核心模块 src/shared/state.cjs
导出 createInitialState(now)、normalizeState(raw, now)、applyCommand(state, command, now)、reconcileState(state, now)、DECORATIONS。
applyCommand/reconcileState 返回 `{ state, effects: [] }`；失败抛出 Error（可带 code）；不可变更新。
DECORATIONS 为对象 `{ lamp: { name:'桌灯',cost:20 }, plant:{name:'盆栽',cost:30}, books:{name:'书本',cost:40} }`。
effects 为 `{ type: 'celebrate'|'focus-finished', message }` 等简单通知。lastEvent.kind 使用 'task-completed'、'focus-completed'、'decoration-unlocked'。

业务命令：
- task.add {title}、task.select {taskId}、task.complete {taskId}
- focus.start {taskId,minutes}（任务可为空；minutes 允许 1-180）
- focus.pause、focus.resume、focus.stop
- decoration.buy {decorationId}、settings.update {focusMinutes}

焦点完成奖励 5，任务完成奖励 10，任务完成与计时完成独立。执行重复任务完成、重复购买均报错且不变化；不暗自结束正在进行的计时来启动另一轮。

## preload bridge window.buddy
- getState(): Promise<State>
- command(command): Promise<{ok:true,state}|{ok:false,error}>
- onState(callback): () => void
- onCursor(callback): () => void，仅桌宠接收只读 `{x:number,y:number}` 相对原生窗口坐标，允许负值表示窗外鼠标；finite 校验，不进入业务快照或持久化。
- openPanel(): Promise<void>
- setPetVisible(visible): Promise<void>
- hidePanel(): Promise<void>
- quit(): Promise<void>
- getPetPosition(): Promise<{x:number,y:number}>，仅桌宠主 frame 可用
- movePet({x,y}): Promise<{x:number,y:number}>，仅桌宠主 frame，可见屏幕范围内移动

pet.play 可选 action: 'tap'|'spin'|'drop'（默认 tap），生成唯一 interaction.id，包含 effect 与短暂 emotion/message。两页动画按 ID 播放互动特效；业务状态不会被互动修改。settings.update 可分别更新 focusMinutes 或 motionMode（full/gentle/static），其余偏好保留。

settings.update 可更新 petScale（70–150整数百分比，默认100），支持与其他偏好一起原子校验；输入非法抛 INVALID_PET_SCALE。主进程保存成功后按百分比调整220×280原生窗口并广播；renderer .pet整体CSS缩放，不更改页面zoom。主面板大小滑杆ID/testid为pet-scale，输出pet-scale-value，恢复默认按钮pet-scale-reset；动作分组motion-mode，三个按钮data-motion=full/gentle/static与aria-pressed。

桥不提供文件路径/任意 IPC/执行脚本。主进程发送 buddy:state 更新，每秒按需要 reconcile；renderer 每 250ms 可更新读秒文本但不修改业务状态。

运行快照 app.petVisible / app.panelVisible 分别是桌宠显示设置与面板原生窗口实际可见性，show/hide 主动广播。Windows 上 document.hidden 可能不随 Electron hide 改变，动画适配必须同时读此原生可见性来停帧及清理特效。

buddy:cursor 每 40ms 最多采样一次，仅在桌宠可见且 motionMode 非 static、应用未退出时读取鼠标屏幕坐标并换算相对当前窗口位置；仅发给桌宠。近距眼神与颜色动画由 companion.js 负责，主面板只跟随其窗口内鼠标。隐藏和静止不读取鼠标，也不推进渐变相位。

## 页面
- 桌宠0.1.4：`#pet-speech`为含尾巴的气泡外层，内部`#pet-speech-text`单独负责消息与两行截断；保留外层aria-live/title和既有ID。`.pet-controls`与气泡默认opacity=0、visibility=hidden、pointer-events=none；`.pet:hover`或`data-keyboard-reveal=true`且内部`:focus-visible`揭示，鼠标移出后延迟收起。pet.js只在本窗口pointerdown/keydown中更新当前输入方式的布尔门禁，失去窗口焦点清掉键盘揭示；不记录按键，鼠标click产生的programmatic focus不能使提示常驻。球体始终可见；没有新增IPC、全局采样或持久化字段。
- src/renderer/index.html + app.js + styles.css：面板
- src/renderer/pet.html + pet.js + pet.css：桌宠
- src/renderer/companion.js：两页共同的角色动画适配与消息
- vendor/emotion-ball/{rings,emotions,ball,engine}.js：上游原文
脚本引入以 relative path 指向 ../../vendor/emotion-ball/，之后加载 companion.js，再加载页面脚本。

## 交互验证稳定选择器
data-testid：task-input、task-add、task-list、task-complete（每行）、focus-start、focus-pause、focus-resume、focus-stop、focus-minutes、focus-timer、energy-count、decoration-lamp/plant/books、pet-toggle、pet-ball、pet-open-panel。
任务行带 data-task-id；完成按钮 aria-label 含任务标题。
