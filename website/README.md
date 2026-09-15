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

本项目为纯静态构建，零编译步骤，直接部署 `website/` 目录即可。`CNAME` 已配置为 `asm.js.cn`，支持 GitHub Pages、Cloudflare Pages、Vercel 等静态托管平台。

### 与 qorm 同机部署时的 OpenResty 注意事项

若官网与 `~/github/qorm`（或其它仓库的站点）部署在同一台服务器上，共享同一 OpenResty / Nginx 实例时必须：

1. **按 `server_name` 严格分流**：`asm.js.cn` 与 qorm 的域名各写独立 `server` 块，禁止用一个 catch-all `server` 混路由；默认 `server` 应显式返回 444/404，避免误吞对方域名。
2. **`root` 路径互不重叠**：官网 `root` 指向 `website/`（或其 rsync 目标），不要指向仓库根或 `~/github`；qorm 的 root 同理。禁止两个站点共用同一 `root` 再靠 `location` 拆。
3. **改配置先 `nginx -t` / `openresty -t`，再 reload**；不要在未测配置时直接 reload，避免整机（含 qorm）站点中断。
4. **证书与 ACME**：若用 Let's Encrypt webroot，两站共享同一 `/.well-known/acme-challenge` 别名路径时写成独立、显式的 `location`，不要靠默认继承。
5. **本仓库不托管服务器配置**：OpenResty vhost 不要提交到 `website/`；服务器侧变更走运维配置库或独立 conf 目录，避免与静态资产部署互相覆盖。
