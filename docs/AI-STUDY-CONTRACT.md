# 0.2.0 并行实现接口

所有主面板扩展IPC返回 `{ok:true,data}` 或 `{ok:false,error,code}`，服务方法内部可throw，主进程统一包装。网络、Key、重连token仅主进程；不得通过state快照泄漏。

## AI

`createAiService({directory,fetch,encryptString,decryptString,isEncryptionAvailable,emit})`，directory为userData/ai；emit只发主面板，事件 `{requestId,chatId,kind,text?,error?,plan?}`，kind为started/delta/finished/stopped/error/plan。构造不联网。

服务方法及对应window.buddy桥：`getAiConfig()`、`saveAiProfile(profile)`、`testAiConnection({profileId})`、`listAiModels({profileId})`、`listChats()`、`createChat({profileId?})`、`getChat({chatId})`、`archiveChat({chatId})`、`sendChat({chatId,text,profileId?,taskTitle?})`、`stopChat({requestId})`、`decomposeTask({goal,minutes?,profileId?})`。服务对象方法使用相同名称；`onAiEvent(callback)`订阅。服务还提供close()退出取消请求。

配置 `{profiles:[{id,name,provider:'openai'|'anthropic'|'gemini',baseUrl,model,hasKey,keyStorage:'encrypted'|'session'|'none'}],activeProfileId}`；save输入可含id/name/provider/baseUrl/model/key/select=true。key未提供保留，空字符串显式清空；返回脱敏配置。新ID内部生成，客户端不能传路径。

会话 `{id,title,profileId,archived,updatedAt,messages:[{id,role:'user'|'assistant',text,status:'complete'|'generating'|'stopped'|'error'|'interrupted'}]}`；列表返回摘要。sendChat立即返回 `{requestId,chatId}`，之后通过事件和getChat恢复状态。拆解立即返回 `{requestId,planId}`，事件plan带 `{id,goal,steps:[{title,description,minutes}]}`，最多12步；失败走error。renderer选择后执行公共命令 `task.batch-add {planId,tasks:[{title,estimatedMinutes?}]}`，最多12个、标题140字、时长1–180，原子校验，防重复计划入库。

## 共学

`createStudyClient({directory,WebSocket,getState,settle,onUpdate,onGreeting,encryptString,decryptString,isEncryptionAvailable})`。directory为userData/study。方法 `getStudyConfig()`、`saveStudyConfig({serverUrl,nickname})`、`getStudyState()`、`connectStudy({mode:'create'|'join',code?,goal?})`、`studyCommand({type:'ready'|'start'|'pause'|'resume'|'stop'|'message'|'greet',ready?,minutes?,text?})`、`leaveStudy()`、close()。对应window.buddy固定桥及`onStudyState(callback)`；onUpdate也驱动两窗业务广播。

脱敏共学快照 `{connection:'disconnected'|'connecting'|'connected'|'reconnecting'|'error',error?,selfId?,serverOffsetMs,room:null|{code,hostId,members:[{id,nickname,online,ready,goal}],round:null|{id,status:'running'|'paused'|'completed'|'stopped',durationMs,remainingMs,endAt,activeMs},messages:[{id,memberId,text,at}],greeting?}}`。room.code不含凭据，token不出快照。服务端协议由共学worker在src/shared/study-protocol.cjs与server代码统一。

getState用于拒绝个人session冲突；root也拒绝在共学running/paused，或自己已准备的等待房间中focus.start/resume。settle接收服务端经已认证连接的终态 `{roomId,roundId,memberId,status:'completed'|'stopped',activeMs,durationMs}`，调用共享模块导出内部 `applyStudyReceipt(state,receipt,now)` 后commit；不能从公共command调用。去重键含roomId/roundId/memberId，保存同一state里的统计与studyReceipts。onGreeting接收经服务确认的招呼，root生成短interaction两窗播放；共学页可自行让同伴球播放同事件。

已认证终态回执先校验memberId与当前连接身份一致，再原子写入userData/study/receipts.json的 `{version:1,pending:[receipt]}` 待结算列表，然后串行调用settle保存业务state。业务state保存成功后，客户端原子移除本地待结算项，再通过同身份连接向服务端确认；本地日志或state保存失败均不能提前确认服务端回执。receipts.json不保存API密钥、重连token或聊天正文，不向renderer暴露。

state保存失败时已认证回执保留在receipts.json，即使用户主动离开或改加入其他房间也不清空。createStudyClient启动时读取并校验待结算回执，离线串行调用settle恢复统计；这一步不打开网络连接、不自动加入房间。若上次state已成功保存而本地日志清理或服务端确认失败，重启回放或服务端重发会由state.studyReceipts的同一去重键跳过统计及奖励，随后继续清理待结算项。该机制覆盖“结算保存失败→离开→重启离线恢复”，且完整轮次奖励仅计一次。

## 页面集成

renderer worker拥有全部renderer文件。现有app.js的公开业务ID/testid保留，新增window.BuddyExtensions.create({getState,runCommand,showMessage,companion})；初始化/渲染/设置返回来源由worker统一。根代理仅改main/preload及工程工具，不改renderer。study回调快照通过state.app.study提供桌宠安全状态（消息不必广播），AI只传简单presence，绝不广播聊天正文或key。客户端onStudyState主面板获得房间消息。
