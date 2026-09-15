# asm.js.cn 官网与品牌资产

这是 `asm.js`（`asm.js.cn`）的官方静态网站与品牌资产目录。

对外数字（版本、fixtures、test262 官方样本）必须与 [`../docs/FACTS.md`](../docs/FACTS.md) 一致；不要写不带官方样本限定的「test262 100%」。

- **视觉与文案规范**：详见 [`../docs/VIS.md`](../docs/VIS.md)
- **品牌矢量资产目录**：[`assets/brand/`](./assets/brand/)
  - `asmjs-mark.svg`：跃迁之门独立图形标
  - `asmjs-mark-mono.svg`：单色黑白矢量标
  - `asmjs-wordmark-dark.svg`：深色横版组合标志
  - `asmjs-wordmark-light.svg`：浅色横版组合标志
  - `asmjs-stacked-dark.svg`：方形/头像居中组合标
  - `asmjs-banner.svg`：官方横幅大图（1200×630）
  - `../assets/favicon.svg`：浏览器高清图标

## 本地预览

```bash
cd website
python3 -m http.server 4173
```

在浏览器中打开 `http://localhost:4173`。

## 部署

本项目为纯静态构建，零编译步骤。`CNAME` 为 `asm.js.cn`。

**当前生产路径（与 qorm.com 同机）**：

| 项 | 值 |
| --- | --- |
| 服务器 | `66.154.102.182`（hostname `qorm.com`） |
| OpenResty | `/usr/local/openresty/nginx/sbin/nginx` |
| docroot | `/var/www/asmjs`（勿用 `/var/www/qorm`） |
| vhost | `server_name asm.js.cn www.asm.js.cn`（独立于 qorm 的 `default_server`） |
| 前端 | Cloudflare 代理；源站仅监听 80，SSL 模式需为 Flexible（或等价：CF→源站 80） |

发布步骤（在本机、使用 qorm 的 `web_server/deploy_key`）：

```bash
# 1. 同步静态资产
rsync -az -e 'ssh -i ~/github/qorm/web_server/deploy_key -o UserKnownHostsFile=~/github/qorm/web_server/known_hosts' \
  website/ root@66.154.102.182:/var/www/asmjs/

# 2. 源站按 Host 验证（勿只测 IP，default_server 是 qorm）
curl -sI -H 'Host: asm.js.cn' http://66.154.102.182/
curl -s -H 'Host: asm.js.cn' http://66.154.102.182/ | head
# 3. 确认 qorm 未被误伤
curl -sI https://qorm.com
```

### 与 qorm 同机部署时的 OpenResty 注意事项

1. **按 `server_name` 严格分流**：`asm.js.cn` 必须有独立 `server` 块；qorm 保持 `default_server`。禁止把 asm.js 挂进 qorm 的 `root`。
2. **改配置先 `nginx -t`，再 `nginx -s reload`**，避免整机（含 qorm/tapripe）中断。
3. **本仓库不托管服务器配置**：OpenResty vhost 不要提交到 `website/`；服务器侧 conf 有备份在 `qorm/web_server/server-config/`（运维参考）。
4. **HTTPS 521 排查顺序**：先 `curl -H 'Host: asm.js.cn' http://源站IP` 看源站内容是否正确，再查 Cloudflare SSL 模式是否为 Full/Full-strict（源站无 443 时必须 Flexible）。
