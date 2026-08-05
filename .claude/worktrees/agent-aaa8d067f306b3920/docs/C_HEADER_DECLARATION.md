# C 头文件(.h)声明层设计 — 取代 .jslib 格式

> 版本:v0.1 决策(2026-07-19,维护者指令:"jslib 格式不需要了,直接使用 c 格式的")。
> 地位:**取代** `docs/C_INTEROP_DESIGN.md` §3.1(.jslib schema v2);该文档其余部分
> (§3.2 ABI 调用层、§3.3 链接层、§3.4 运行层、§3.5 封送层、§3.6 安全层、§4 阶段)**不变**——
> 本设计只是同一份内部签名表的不同生产者:解析器产出 signatures,下游一律复用。
> 动机:库厂商本就发布 .h——zlib/libcrypto/sqlite 的签名事实源就是头文件本身;
> 手写 .jslib 是第二份需要人工维护的声明,注定漂移。schema v2 的 `signatures` 表
> 恰好就是 C 原型所声明的内容,.h 即声明。

---

## 1. 总体形态

```c
// 用户侧:C 库自带或随包附带的头文件(无需任何改写)
// /usr/include/zlib.h:  ZEXTERN uLong ZEXPORT crc32 OF((uLong crc, const Bytef *buf, uInt len));
```
```js
// 消费:`import * from` 接 .h 路径(语法与 .jslib 时代一致)
import * from "./zlib.h";
const n = crc32(0n, abuf, len);   // uLong→BigInt、Bytef*→ptr(ArrayBuffer 取 data_ptr)
```
```sh
# 链接:--lib/--lib-path(C 惯例,C0 的 B5 修复使该通路生效)
node cli.js app.js --lib z            # → DT_NEEDED/LC_LOAD libz
node cli.js app.js --lib /opt/lib/libz.dylib
```

- **.h 负责声明**(符号 + 类型),**`--lib` 负责链接**(库二进制检索,检索规则见
  C_INTEROP_DESIGN §3.3-4:`-lfoo` → `libfoo.a`/`libfoo.dylib`/`foo.lib` 按 --lib-path 顺序)。
- `.jslib` 解析器保留(存量 fixture 不破),文档一律指向 .h;`--emit` 产出侧改为生成 .h
  (C6 本就规划了"签名 → .h 声明"的生成,消费侧 .h 解析是其镜像)。

## 2. 解析子集(v1)

编译期**手写 tokenizer + 递归下降**,禁用正则(自举 §1 铁律,同 .jslib 字符串扫描的约束)。
解析产物 = 签名表 `{ name: { params: [类型词…], returns: 类型词 } }`,与 schema v2 同构。

### 2.1 收进 v1 的构造

| C 构造 | 处理 |
|---|---|
| 函数原型 `rettype name(params);` | 主要输入;进签名表 |
| `#define NAME 整数/负整数/十六进制` | 常量表(可按名引用,如 `Z_NO_FLUSH`) |
| `typedef <标量/指针> alias;` | 别名表(如 `uLong`→u64、`Byte`→u8、`size_t`→u64) |
| `enum E { A, B=5, C }` | 枚举类型→i32;枚举常量进常量表 |
| struct/union **指针**用法 | 一律 `ptr`(不透明,不解体) |

### 2.2 类型映射(→ 封送层类型词,§3.5)

`char/signed char→i8`,`unsigned char→u8`,`short→i16`,`unsigned short→u16`,
`int→i32`,`unsigned int→u32`,`long long→i64`,`unsigned long long→u64`,
`size_t→u64`,`ssize_t→i64`,`float→f32`,`double→f64`,`void→void`,
`bool/_Bool→u8`,`任意指针(含 struct*)→ptr`,`const char *→cstring`。
**`long` 平台相关**:LP64(macos/linux)→i64;LLP64(windows)→i32——按编译目标映射,
在文档中显著标注(这是消费真实 .h 时最大的平台陷阱)。
**`buffer=(ptr,len)` 双参数糖不做**(C 原型里无法可靠推断哪两个参数配对;
v1 就是两个独立参数,用户按 ABI 传 ptr 与长度)。

### 2.3 宏映射(真实头文件存活的关键)

真实 .h(zlib.h、sqlite3.h)大量装饰宏与条件编译,不做全预处理器,做**可配置宏映射**:

- **装饰宏表**(内置默认 + 头部内顺扫补充):`ZEXTERN/ZEXPORT/WINAPI/CALLBACK/APIENTRY/
  WINAPIV/EXPORT/EXTERN_C` 等 → 展开为空或 `extern`;`__declspec(...)` → 空。
- **原型包裹宏**:`OF((args))`/`ARGS((args))`/`_ANSI_ARGS_((args))` 形态 → 去壳取参数表。
- **条件编译**:`#if/#ifdef/#ifndef/#elif/#else/#endif` 只支持**常量可判**的少数谓词
  (`#if 0`、`#ifdef 已见宏名`),其余整块跳过并在解析日志记录(响亮,不静默);
  `#include` 一律跳过(不递归,文档建议喂库的主头文件)。
- 其余未知构造(函数指针参数、数组参数、位域、struct by-value、可变参 `...`)→
  **响亮编译错**,带 文件:行号(反静默退化原则;`...` 在 C4 variadic 落地前恒报错)。

## 3. 解析器落点与改造面

- 新模块 `compiler/output/cheader.js`(~600-800 行,含 tokenizer/原型文法/宏映射/typedef
  与 enum 折叠);`parseJslibFile` 旁挂 `parseCHeaderFile`,产出同一签名表结构。
- `lang/parser/modules.js:19-38`:`.h` 与 `.jslib` 并列识别;`import * from` 的错误文案
  同步("requires .h or .jslib file")。
- 符号注册进 `ctx.functions` 带签名(C0/B2 的静态路消断路依赖此项,不变)。
- 找不到文件/语法错/类型词未知 → 编译期显式报错(同 schema v2 的响亮失败要求)。

## 4. 分阶段影响(对 C_INTEROP_DESIGN §4 的替换项)

- **C0 不变**(六 bug 照旧;B5 `--lib` 接线成为硬前置——.h 只有声明没有库路径)。
- **C1 内容替换**:"schema v2 解析" → "`.h` 子集解析 + 宏映射 + 类型映射表";
  验收加一条:消费**真实系统 zlib.h** 声明 crc32/compressBound 并调通(macOS arm64
  `/usr/lib/libz.dylib`),与 C 参考逐值一致。工作量同估 15-25 人日(tokenizer 比
  字符串扫描重,但免去 schema 演进与 v1 兼容层)。
- **C2-C6 不变**;C6 产出侧 .h 生成与消费侧共享类型词表(一份映射表两个方向)。

## 5. v1 明确不做

全预处理器;`#include` 递归;struct/union 定义体(只收指针);函数指针;
数组形式参数(按指针退化规则不保证);`...` variadic(C4);位域;`long double`;
`buffer` 配对糖;C 回调 JS(§3.6 初期禁止不变)。

## 6. 风险

| 风险 | 对策 |
|---|---|
| 真实 .h 宏花活比预想多(如 K&R 原型、宏拼符号) | 先以 zlib.h/sqlite3.h 为验收靶;宏映射表可经头部 `#define` 顺扫自补充;解析失败一律响亮 |
| `long` 的 LP64/LLP64 分歧 | 按目标映射 + 文档显著标注 + windows 侧 fixture 覆盖 |
| 用户拿 .h 声明了库里没有的符号 | 链接期/加载期自然报错(dyld undefined symbol),文档写明 |
| asm.js 自举闭包内手写解析器体积(+~800 行) | 布局悬崖纪律:小波次提交,每波全链定点回放 |
