# asm.js 视觉识别系统（VIS）规范

版本：3.0（最终定稿版：跃迁之门 &amp; 纯正现代几何字标系统）  
适用域名：`asm.js.cn` · 官方仓库：`github.com/qorm/asm.js`

---

## 1. 品牌核心与设计初衷（Brand Mission &amp; Origin）

### 项目存在意义与设计初衷
JavaScript 诞生之初是一门高层脚本语言，历来依赖庞大笨重的 VM（V8/Node.js）运行时与海量解释层。

**asm.js 的根本初衷**：
- **打破运行时枷锁**：做一个完全自主研发、零第三方依赖的 JavaScript → Native AOT 编译器；
- **跨越高级语法与裸机硬件的鸿沟**：把动态代码语法直接在编译期淬火转换为独立单静态二进制文件（Mach-O / ELF / PE）；
- **自举数学确定性**：自己编译自己（gen2 ≡ gen3），实现逐字节相同的固定点（Fixed Point）。

### 品牌主张（Slogan）
- **中文**：把 JavaScript，铸成原生二进制。
- **英文**：JavaScript. Forged native.

### 品牌性格
- **硬核工业力量（Industrial Precision）**：立足于微架构、机器指令与编译器管线，拒绝无意义的浮华渐变；
- **诚实且精确（Honest &amp; Exact）**：以 Proof Green 标注经过逐字节验证的事实，保持技术严谨性；
- **纯正统一的排版规范（Pure Unified Typography）**：字标统一采用国际顶级现代几何标准字体族（Inter 800 ExtraBold），消除任何生硬拼凑，确保跨平台像素级纯正呈现。

---

## 2. 标志系统（The Logo System）

### 核心概念：跃迁之门（The Quantum Gateway）与纯正字标（Pure Wordmark）

标志由 **JavaScript 语法花括号 `{`**、**直接 AOT 隧穿通道** 与 **底层离散机器指令比特 / 固定点方块** 构成，右侧配合纯正的 **Inter ExtraBold** 现代几何字标：

```
      ┌─┐
      │ └─┐  ┌─┐  ┌─┐ (Machine Instruction Bit)
      │ ┌─┘  │ │  └─┘
      │ └─┐  │ │  ■   (Proof Green Fixed Point Byte)   asm.js
      └─┘    └─┘
    [JS语法] [AOT通道] [原生机器码]                     [Inter ExtraBold]
```

1. **左侧（语法世界）**：由 JavaScript 代表性语法花括号 `{` 构成，采用品牌主色 **Signal Orange (`#FF5A1F`)**；
2. **中间（编译隧穿）**：AOT 零依赖直接编译通道，象征无 VM、无解释层的极致跃迁；
3. **右侧（裸机比特）**：离散的机器指令字，其中高亮绿方块采用 **Proof Green (`#B7F34A`)**，既代表自举验证固定点（gen2 ≡ gen3），也精准呼应 `asm.js` 中的核心点号（Dot）；
4. **字标排版**：统一采用标准 **Inter 800 ExtraBold**，负字距 `letter-spacing: -2px / -0.05em`，字符饱满舒展，浑然天成。

---

### 标志资产清单（Asset Matrix）

| 资产文件名 | 类型 | 尺寸规格 | 适用场景 |
|---|---|---|---|
| [`asmjs-mark.svg`](../website/assets/brand/asmjs-mark.svg) | 独立图形标 | 80×80 (Vector) | 网站 Favicon、头像、App 图标、局部徽标 |
| [`asmjs-mark-mono.svg`](../website/assets/brand/asmjs-mark-mono.svg) | 单色图形标 | 80×80 (Vector) | 单色印刷、终端 ASCII/SVG、黑白文档、刻蚀 |
| [`asmjs-wordmark-dark.svg`](../website/assets/brand/asmjs-wordmark-dark.svg) | 横版组合标（深底） | 320×80 (Vector) | 官网页眉、深色背景 Hero、PPT 演示 |
| [`asmjs-wordmark-light.svg`](../website/assets/brand/asmjs-wordmark-light.svg) | 横版组合标（浅底） | 320×80 (Vector) | 浅色文档、白底打印、浅色网页 |
| [`asmjs-stacked-dark.svg`](../website/assets/brand/asmjs-stacked-dark.svg) | 居中上下组合标 | 200×200 (Vector) | 社交媒体头像、方形卡片、海报居中展示 |
| [`asmjs-banner.svg`](../website/assets/brand/asmjs-banner.svg) | 宣传横幅 / OG Banner | 1200×630 (Vector) | GitHub Readme 头部、社交网络分享卡片 |
| [`favicon.svg`](../website/assets/favicon.svg) | 浏览器图标 | 64×64 (Vector) | 浏览器 Tab、PWA 图标、桌面快捷方式 |

---

## 3. 色彩系统（Color Palette）

| 角色 | 色彩名称 | Hex | RGB | 用途与语义 |
|---|---|---|---|---|
| **主背景** | Forge Black | `#0B0D0C` | `11, 13, 12` | 深色主画布、页眉底色、CLI 终端底色 |
| **主前景** | Bone | `#F1EEE4` | `241, 238, 228` | 深底正文、主标字形、浅色高光 |
| **品牌主色** | Signal Orange | `#FF5A1F` | `255, 90, 31` | 语法花括号、编译通道、主要 CTA |
| **验证事实** | Proof Green | `#B7F34A` | `183, 243, 74` | **固定点**、验证通过徽标、机器指令验证点 |
| **深绿备用** | Deep Proof Green | `#1F7A38` | `31, 122, 56` | 浅色背景下的固定点（保障 WCAG AA 对比度） |
| **次级文本** | Alloy Gray | `#8D938E` | `141, 147, 142` | 辅助说明、版本号、等宽元数据 |
| **结构分割** | Carbon Line | `#2B2F2C` | `43, 47, 44` | 精密网格线、卡片边框、架构拓扑 |

---

## 4. 字体与排版标准

- **字标（Wordmark）**：统一采用 `Inter 800 ExtraBold`，点号为 `Proof Green`，字距紧凑微缩 `letter-spacing: -0.05em`。
- **界面正文**：`Inter`, `'PingFang SC'`, `'Noto Sans CJK SC'`, `'Microsoft YaHei'`, sans-serif。
- **代码与数据**：`'IBM Plex Mono'`, `'SFMono-Regular'`, Consolas, Menlo, monospace。
