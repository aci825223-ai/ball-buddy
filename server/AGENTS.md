# 双人共学服务规则

- 继承上级AGENTS.md；只处理两人房间、消息、互动、权威计时与终态回执，不读取个人任务/AI数据。
- server/src/存源码，server/tests/存测试，README/package为独立启动与配置；服务数据目录可显式指定，默认server/data/。测试数据仅放上级artifacts/。
- 不自动删除文件，不改env/系统/防火墙/密钥，不公开部署，仅安装本项目依赖。
- 输入校验、容量、身份/主持人权限、消息与动作限频、重连、持久化恢复和奖励回执去重必须实测。
- 运行node --test server/tests/*.test.cjs，并从根执行npm run check；公网可达性未经真实环境验证不能声明。
- LICENSE保存原创共学服务的MIT许可，必须随独立服务源码和打包副本分发。发布源码继承根本次GitHub授权；公开部署服务仍需独立授权。
