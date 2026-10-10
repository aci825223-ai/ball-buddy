---
name: "小球同桌 / Ball Buddy"
description: "任务在前，伙伴在旁的安静学习空间。"
colors:
  primary: "#0066cc"
  primary-hover: "#005bb7"
  on-primary: "#ffffff"
  paper: "#ffffff"
  canvas: "#f5f5f7"
  scene: "#f7f6f3"
  secondary: "#efeff2"
  sidebar: "#eeeef1"
  ink: "#1d1d1f"
  muted: "#626267"
  scene-muted: "#626267"
  line: "#e4e4e8"
  field-line: "#d2d2d8"
  selected: "#e4effc"
  quiet-hover: "#f1f1f4"
  error: "#b53c43"
  dark-primary: "#78b1ff"
  dark-primary-hover: "#91bfff"
  dark-on-primary: "#122038"
  dark-paper: "#202023"
  dark-canvas: "#171719"
  dark-scene: "#252526"
  dark-secondary: "#2b2b30"
  dark-sidebar: "#1c1c1f"
  dark-ink: "#f3f3f5"
  dark-muted: "#a8a8af"
  dark-scene-muted: "#a8a8af"
  dark-line: "#37373c"
  dark-field-line: "#515158"
  dark-selected: "#283b55"
  dark-quiet-hover: "#2c2c31"
  dark-error: "#ffabb2"
rounded:
  text-action: "6px"
  preset: "7px"
  control: "8px"
  group: "12px"
  panel-bubble: "14px"
  bubble: "16px"
  tail: "3px"
  geometric-mark: "2px"
  sphere: "50%"
typography:
  body:
    fontFamily: '"Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", sans-serif'
    fontSize: "14px"
    lineHeight: 1.6
  heading:
    fontFamily: '"Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", sans-serif'
    fontSize: "25px"
    fontWeight: 600
  section:
    fontSize: "17px"
    fontWeight: 600
  caption:
    fontSize: "12px"
  timer:
    fontFamily: '"Segoe UI", "Microsoft YaHei UI", sans-serif'
    fontSize: "50px"
    fontWeight: 300
spacing:
  unit: "4px"
  content: "24px"
  compact: "20px"
---

# 安静学习空间 / 0.3.0

## 当前权威
用户已确认“按这版实施”。视觉参考已审四页交互预览及 revision-2 截图；正式版使用现有真实数据，预览不能作为样例导入。此文与 docs/THEME-REDESIGN-CONTRACT.md 取代历史青色/顶栏导航视觉约定。改版前源码、完整软件和设计已保存在0.2.0恢复节点，不覆盖旧档。

## 设计方向
Apple桌面工具式的安静工作空间，参考Reminders、Notes和System Settings的结构、内容主次与对齐。Operate、code-led，任务与真实操作优先；小球的实时彩色动画是识别特征。侧栏、连续内容面和少量蓝色强调建立统一语言；不使用Apple标识、SF字体或伪macOS窗钮。

## 版式与层级
左侧160px导航（最小约144px），内容64px页头；任务面与约256px伙伴栏相邻，底部横排布置。任务标题25px、正文14px、辅助12px；真实任务只有现有title，不增加描述。进展可位于任务区底部；任务添加、完成、选中和已完成折叠可达，长文字完整换行。

聊天正文独立滚动，模型选择和历史可达，输入固定；紧凑真实球/计时陪伴区保留个人专注。任务拆解先生成、编辑勾选，再确认入库。共学邀请条、双球/真实状态和共同计时、右侧房间聊天成为连续空间，消息内部滚动，输入固定可见。等待/离线/重连使用真实状态，无虚假成员。

设置采用二级分类与连续偏好行，返回来源页和保存反馈固定可见；普通偏好自动保存，AI配置明确手动保存/测试。字体、主题跟随系统、大小、关闭到托盘或退出等真实功能全部保持。

默认1040×780与最小880×680按实际Electron客户区验收（约1024×741与864×641）。大字号/导入宽字体使用内部纵向滚动和重排，不能通过缩小字体挤下主要操作。

## 组件规则
控件圆角8px、必要分组12px、气泡16px。开放列表与细分隔线优先；不堆叠巨型圆角卡片，不把次要说明铺满内容区。蓝色用于主要操作、焦点与选中，状态同时有文字。主要按钮前景与表面分离，深浅错误/提示均可读，键盘focus-visible清楚可见。

紧凑文字动作6px、计时档位7px、主面板消息14px、几何线条/标记2px为实际源码中的次级尺度；桌宠气泡仍16px。最后一次机械检测为0反模式，4项上述次级尺度建议已记录，不因此改动已审界面。

## 实时角色与桌宠
保持单个#main-ball，在书桌与聊天间移动。角色连续呼吸、眨眼、形变、五色渐变和近距鼠标眼神；点击弹跳、双击旋转彩带、拖动回弹与完成撒花沿用现有运行时，不改vendor。隐藏/离屏/静止停帧，轻柔减慢。球体自身米白/桃粉/薄荷/淡蓝/浅紫保持，不跟随UI蓝色替换。

透明桌宠root/body不着色，气泡/操作条更新中性表面与软阴影。hover/键盘揭示门禁、默认隐藏、延迟淡出、两行正文与独立尾巴保持；70%–150%缩放整组，无裁切。普通鼠标点击的焦点不能让提示常驻。

## 状态和数据
不增加业务功能、统计字段或设置，不改存储schema/网络协议。ID、testid、form与脚本顺序保持。个人记录、未知字段、字体文件与加密AI/房间数据不重置，示例内容仅在独立预览。原生背景若变更，只同步新主题颜色常量。

## 验证与交付
实际Electron检查任务/计时/设置/AI/共学，默认/最小、浅深、大字体/导入字体截图。动画采样连续帧，hover/键盘/70%–150%实测；两客户端验房间计时、消息、重连与奖励去重。独立视觉收尾后打包，源/包逐项哈希与许可审计。真实厂商API与公网连接需要外部环境，不能用本地fixture替代。事实结果写docs/VALIDATION.md，未完成阶段不能称通过。
