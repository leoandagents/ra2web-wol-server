# ra2web-wol-server

[RA2WEB（网页红警）](https://github.com/ra2web/ra2web.github.io) 的**自建联机对战服务端**：账号注册 + WOL 大厅（建房/聊天）+ gserv 游戏数据中继，单进程 Node.js 实现，依赖只有 `ws`。

配合增强 AI 站点部署使用：[leoandagents/ra2web-enhanced-ai](https://github.com/leoandagents/ra2web-enhanced-ai)

## 功能

- `POST /register` — 账号注册（JSON：`{locale,user,pass}`，密码加盐 SHA-256 存储于 `accounts.json`）
- `/wol`（WebSocket）— IRC 风格大厅协议：登录（MOTD）、房间列表、建房/加房（joingame/gameopt/topic 转发）、开局（startg）
- `/gserv`（WebSocket）— 游戏实例中继：创建/加入对局、地图分发、**帧同步（lockstep）回合聚合转发**、状态哈希校验（801）、调速广播（802）、聊天/嘲讽/掉线、断线重连
- 已用真实浏览器客户端双向验证：双人建房 → 加入 → 开局 → 完整对局

## 部署

需要 **Node.js 18+**。

```bash
git clone https://github.com/leoandagents/ra2web-wol-server.git /var/www/wol-server
cd /var/www/wol-server
npm install --omit=dev
```

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8901` | 监听端口（只绑定本机，由 Nginx 反代） |
| `GSERV_PUBLIC_URL` | `ws://127.0.0.1:8901/gserv` | **生产必填**：客户端连游戏用的公网地址，如 `wss://你的域名/gserv` |
| `GSERV_NET_RATE` | `50` | 网络回合毫秒数（调速广播 802 的初值） |
| `ALLOWED_ORIGINS` | 允许全部 | 逗号分隔的 Origin 白名单（可选） |
| `WOL_DEBUG` / `GSERV_DEBUG` | 关 | 设为 `1` 开启协议日志 |
| `GSERV_RECORD` | 关 | 设为 `1` 录制每一局到 `recordings/<gameId>.jsonl`（对局配置/地图/每回合每玩家操作/聊天/结果），用于 AI 分析与调优 |
| `GSERV_RECORD_DIR` | `./recordings` | 录制文件目录 |

### systemd

```ini
[Unit]
Description=ra2web self-hosted WOL lobby
After=network.target

[Service]
WorkingDirectory=/var/www/wol-server
Environment=PORT=8901
Environment=GSERV_PUBLIC_URL=wss://你的域名/gserv
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

### Nginx 反代

```nginx
location /wol {
    proxy_pass http://127.0.0.1:8901;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 7200s;
}
location /gserv {
    proxy_pass http://127.0.0.1:8901;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 7200s;
}
location = /register {
    proxy_pass http://127.0.0.1:8901;
}
```

站点 `servers.json` 加大区指向本服务（参考 ra2web-enhanced-ai 仓库的配置）：

```json
{
  "id": "SELFHOST",
  "label": "自建大厅",
  "available": true,
  "wolUrl": "wss://你的域名/wol",
  "apiRegUrl": "https://你的域名/register"
}
```

## 本地开发/测试

```bash
npm start                 # 启动服务（:8901）
node test/smoke.mjs <gameId> <user> <pass>   # 被动玩家协议烟测
```

`D:\code\red\supalosa-chronodivide-bot` 的 driver 支持 `ONLINE_MATCH=1 SERVER_URL=ws://127.0.0.1:8901/gserv`，可用无头 bot 联机自测。

## 免责

仅供个人学习交流，禁止商业用途。游戏素材版权归 EA / Chrono Divide 作者所有。
