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
