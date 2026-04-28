# BW&SZ's space

一个中文私密 Web 工作台。当前支持两种模式：本地 SQLite 开发模式，以及 GitHub Pages + Firebase Auth/Firestore 的公网共享模式。重点模块包括总览、专注定时、项目与日程、投稿管理、健康管理、心灵关怀、向上管理导师、成就殿堂和宏观数据看板。

## 本地运行

本地服务器使用 Node 内置 `node:sqlite`。公网静态部署使用 GitHub Pages 和 Firebase。

```bash
npm start
```

然后访问：

```text
http://127.0.0.1:3077
```

当前本地开发默认关闭登录，打开页面会直接进入工作台。之后如果要恢复登录，把 `.env` 里的配置改成：

```text
LOGIN_DISABLED=false
```

第一次启动时，如果 `data/users.json` 不存在，服务器会自动创建 BW / SZ 本地账号。公网或 tunnel 暴露前必须设置强密码并开启登录。

## 常用命令

```bash
npm start     # 普通启动
npm run dev   # Node watch 模式，改 server.js 后自动重启
npm run check # 检查 server.js 和前端 JS 语法
```

## 本地数据库与自动备份

- 主数据库：`data/bwsz-space.sqlite`
- SQLite WAL：`data/bwsz-space.sqlite-wal` / `data/bwsz-space.sqlite-shm`
- 最新自动备份：`data/backups/bwsz-space-latest.sqlite`
- 兼容镜像：`data/app-state.json`，方便肉眼查看，不作为主存储

每次保存状态，包括专注记录、任务拖拽、任务拉伸、表单编辑，都会写入 SQLite，并自动刷新 latest 备份。不需要手动导出备份。

`data/*.json`、`data/*.sqlite*` 和 `data/backups/` 已加入 `.gitignore`，避免私密数据提交到仓库。

## 当前模块

- 总览首页：几个核心指标和快速入口。
- 专注定时：开始/结束计时、手动补录、日/周/月柱状图、最常专注时段。
- 项目与日程：长期项目、临时任务、Level、每日/每周任务、可拖动和拉伸的 Project Timeline。
- 投稿管理：轻量投稿流水线。
- 健康管理：习惯打卡、恢复/请假/健康记录。
- 心灵关怀：情绪、感谢和鼓励记录。
- 向上管理导师：导师会、问题池、会议与跟进。
- 成就殿堂：自动触发徽章 + 手动徽章任务。
- 数据看板：专注、任务、健康、导师和成就的宏观指标。

已删除：博士毕业论文进度、每日复盘、数据管理。

## API

默认本地开发模式下登录可关闭。任何公网、tunnel、反向代理场景都必须设置 `LOGIN_DISABLED=false`，此时 `/api/state` 与 `/api/modules/*` 接口需要登录 cookie。

```text
GET  /api/health          健康检查
POST /api/auth/login      登录
GET  /api/auth/me         当前用户
POST /api/auth/logout     退出
GET  /api/state           读取完整空间状态
PUT  /api/state           保存完整空间状态，自动写 DB + 自动备份
GET  /api/modules         模块注册表
GET  /api/modules/:key    读取单个模块数据
PUT  /api/modules/:key    更新单个模块数据，自动写 DB + 自动备份
GET  /api/backups         最近自动备份日志
```

## Public Repo 安全注意

- `data/`、`logs/`、`.env`、本地下载的 tunnel 二进制都不应该提交到 public repo。
- `public/firebase-config.js` 是 Firebase Web 客户端配置，不是服务端密钥；真正的安全边界是 Firebase Auth + Firestore Rules。
- GitHub Pages 上线后必须在 Firebase Console 把 BW / SZ 账号密码改成强密码，不要使用演示密码。
- 建议在 Google Cloud Console 给 Firebase Web API key 加 HTTP referrer 限制，只允许 `https://simon6501.github.io/*` 和本地开发地址。
- Firestore Rules 必须只允许两个授权账号访问 `spaces/bwsz-state`。

## 公网部署前建议

1. Firebase Auth 里给 BW / SZ 设置强密码。
2. Firestore Rules 只允许指定邮箱读写 `spaces/bwsz-state`。
3. 如果暴露本地 Node 服务器，设置 `LOGIN_DISABLED=false`、强 `BW_PASSWORD` / `SZ_PASSWORD` 和随机 `SESSION_SECRET`。
4. 将 `HOST` 保留为 `127.0.0.1`，前面用 Cloudflare Tunnel / Caddy / Nginx 做 HTTPS。
5. 给 `data/` 做系统级定期备份，应用内已有 latest 自动备份，但服务器层面仍建议做快照。
