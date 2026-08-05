// asm.js 运行时 - 协程支持
// 实现类似 goroutine 的协程系统
// 使用栈切换和上下文保存

import { VReg } from "../../vm/index.js";

// 协程状态
const CORO_STATUS_CREATED = 0; // 刚创建
const CORO_STATUS_RUNNING = 1; // 运行中
const CORO_STATUS_SUSPENDED = 2; // 挂起
const CORO_STATUS_COMPLETED = 3; // 已完成

// 协程对象内存布局 (ARM64/x64):
// +0:   type (8 bytes) = TYPE_COROUTINE (10)
// +8:   status (8 bytes)
// +16:  stack_base (8 bytes) - 协程栈基址
// +24:  stack_size (8 bytes) - 栈大小
// +32:  saved_sp (8 bytes) - 保存的栈指针
// +40:  saved_fp (8 bytes) - 保存的帧指针
// +48:  saved_lr (8 bytes) - 保存的返回地址 (ARM64) / RIP (x64)
// +56:  func_ptr (8 bytes) - 协程函数指针
// +64:  arg (8 bytes) - 函数参数
// +72:  result (8 bytes) - 返回值
// +80:  next (8 bytes) - 链表下一个
// +88:  promise (8 bytes) - 关联的 Promise
// +96:  closure_ptr (8 bytes)
// +104: resumer (8 bytes) - 恢复本协程者(resumer 链,支持嵌套 resume);yield/return
//                           回到此协程而非硬编码主协程 → yield*/生成器套生成器可用
// +112: arg1 (8 bytes) - 第 2 个实参(A1);多实参生成器由 stub 写、_coroutine_entry 恢复
// +120: arg2 (8 bytes) - 第 3 个实参(A2)
// +128: arg3 (8 bytes) - 第 4 个实参(A3)
// +136: arg4 (8 bytes) - 第 5 个实参(A4)

const CORO_RESUMER = 104;
const CORO_ARG1 = 112;
const CORO_ARG2 = 120;
const CORO_ARG3 = 128;
const CORO_ARG4 = 136;
// +144: this(A5;方法约定的接收者)。生成器 stub 写、_coroutine_entry 恢复 → 生成器方法
// `*m(){ yield this.x }` 的 this 绑定(此前协程不保存 A5,生成器体内 this=垃圾/undefined)。
const CORO_THIS = 144;
// +152: exc_ctx_top —— 本协程的异常上下文链头(挂起期间停泊于此)。异常链是**栈作用域**
// 的:协程有独立栈,故链必须随 resume/yield 与 SP/FP 一起切换,否则协程体内 try 压的帧
// 与调用方帧在全局链上交错 —— 恢复点 emitExcCtxRestore 会把调用方后压的 catch 帧一并
// 甩掉(gen.throw 进 finally-only try 后调用方 catch 失联的根因)。
const CORO_EXC_TOP = 152;
// +160: argc —— 创建点的 _call_argc 快照;_coroutine_entry 首次进入体前恢复到全局,
// 使协程体(生成器/async)的 arguments 构建读到真实实参个数(而非陈旧值)。
const CORO_ARGC = 160;

const TYPE_COROUTINE = 10;
const COROUTINE_SIZE = 168;
const COROUTINE_STACK_SIZE = 65536; // 64KB 栈

// 闭包魔数（与编译器保持一致）
// async 闭包在协程入口需要把 closure_ptr 放到 S0

export class CoroutineGenerator {
    constructor(vm) {
        this.vm = vm;
        this.arch = vm.arch;
        this.os = vm.os;
    }

    // 生成 write 系统调用
    emitWriteCall() {
        const vm = this.vm;
        if (this.os === "windows") {
            vm.callWindowsWriteConsole();
        } else if (this.os === "wasi") {
            vm.syscall(1); // wasi 号名空间 = linux-x64
        } else if (this.arch === "arm64") {
            vm.syscall(this.os === "linux" ? 64 : 4);
        } else {
            vm.syscall(this.os === "linux" ? 1 : 0x2000004);
        }
    }

    generate() {
        this.generateCoroutineCreate();
        this.generateCoroutineResume();
        this.generateCoroutineYield();
        this.generateCoroutineReturn();
        this.generateSchedulerData();
        this.generateSchedulerInit();
        this.generateSchedulerRun();
        this.generateSchedulerSpawn();
        this.generateSpawnTramp(); // [方言] js f(x) 派发蹦床
        // [批次D] 生成器(function*/yield)运行时,骑在协程调度器上
        this.generateGeneratorNew();
        this.generateGeneratorNext();
        this.generateGeneratorReturn();
        this.generateGeneratorThrow();
        this.generateGeneratorSelf();
        this.generateGeneratorMakeResult();
        // [async generator] 复用协程+Promise:next() 返回 Promise<{value,done}>,体可 yield 也可 await
        this.generateAsyncGeneratorNew();
        this.generateAsyncGeneratorNext();
    }

    // ==================== [批次D] 生成器运行时 ====================
    // 生成器对象 = 普通 JS 对象(0x7ffd),带两个属性:
    //   "next"            → 闭包 [0xc105, _generator_next, coro裸指针]
    //   "Symbol.iterator" → 闭包 [0xc105, _generator_self](返回 this,使对象自迭代,
    //                        for-of 通用 iterator 分支零改动直通)
    // 内部槽即 next 闭包的 +16 捕获槽(裸 coro 指针);done 标志复用协程状态字(coro+8)。
    // GC:保守扫描链 genobj(属性区)→ next闭包 → coro → 协程栈块,全程无需精确根。

    // [方言] _spawn_tramp:js f(x) 派发协程的入口体。经 _coroutine_entry 进入:
    // A0=被调值(装箱/裸),A1-A4=实参 0-3,A5=this,S0=0;_call_argc 已按 CORO_ARGC 恢复。
    // 分派与调用点同构:_validate_callable(含 Proxy 合成闭包)→ magic 分派
    // (CLOSURE/ASYNC 取 [+8](async 值即 stub → 自建协程+Promise,天然支持 js asyncFn()),
    // 裸指针直调)→ 实参下移 A0..A3、A4=undefined → callIndirect。
    generateSpawnTramp() {
        const vm = this.vm;
        vm.label("_spawn_tramp");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);     // S0 = 被调值候选
        // 实参下移(此刻 A1-A5 仍完好;纯 A→A 搬运,无别名冲突)
        vm.mov(VReg.A0, VReg.A1);
        vm.mov(VReg.A1, VReg.A2);
        vm.mov(VReg.A2, VReg.A3);
        vm.mov(VReg.A3, VReg.A4);
        vm.movImm64(VReg.A4, 0x7ffb000000000000n); // 第 5 参恒 undefined(Stage-0 上限 4)
        vm.call("_validate_callable"); // in/out S0(裸可调用;不动 A0-A5)
        vm.load(VReg.S1, VReg.S0, 0);
        vm.cmpImm(VReg.S1, 0xa51c);   // ASYNC_CLOSURE_MAGIC
        vm.jeq("_spawn_tramp_closure");
        vm.cmpImm(VReg.S1, 0xc105);   // CLOSURE_MAGIC
        vm.jeq("_spawn_tramp_closure");
        vm.mov(VReg.S1, VReg.S0);     // 裸函数指针
        vm.movImm(VReg.S0, 0);
        vm.jmp("_spawn_tramp_call");
        vm.label("_spawn_tramp_closure");
        vm.load(VReg.S1, VReg.S0, 8);
        vm.label("_spawn_tramp_call");
        vm.callIndirect(VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1], 0);
    }

    // _generator_new(A0=体函数指针, A1=首参, A2=闭包指针或0) -> boxed 生成器对象
    // 由编译器在生成器函数标签处的 stub 尾跳进入:调用生成器函数不执行体,
    // 建 CREATED 态协程(首次 next 时经 _coroutine_entry 进入体)+ 返回生成器对象。
    generateGeneratorNew() {
        const vm = this.vm;

        vm.label("_generator_new");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2]);

        // 协程(CREATED 态,不入调度队列——由 .next() 手动 resume)
        vm.call("_coroutine_create"); // A0/A1/A2 透传
        vm.mov(VReg.S0, VReg.RET); // S0 = coro

        // 生成器对象
        vm.call("_object_new");
        vm.mov(VReg.S1, VReg.RET); // S1 = obj(裸)

        // 内部槽 obj["__gen_coro"] = coro 裸指针(诊断/GC 冗余根)
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.A1, this.vm.asm.addString("__gen_coro"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.mov(VReg.A2, VReg.S0);
        vm.call("_object_set");

        // next 闭包 [magic, func_ptr, coro]
        vm.movImm(VReg.A0, 24);
        vm.call("_alloc");
        vm.mov(VReg.S2, VReg.RET);
        vm.movImm(VReg.V1, 0xc105); // CLOSURE_MAGIC
        vm.store(VReg.S2, 0, VReg.V1);
        vm.lea(VReg.V1, "_generator_next");
        vm.store(VReg.S2, 8, VReg.V1);
        vm.store(VReg.S2, 16, VReg.S0); // 捕获槽 = coro 裸指针(内部槽)

        // obj["next"] = 闭包(函数 tag 0x7fff)
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.A1, this.vm.asm.addString("next"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.movImm64(VReg.V1, 0x7fff000000000000n);
        vm.or(VReg.A2, VReg.S2, VReg.V1);
        vm.call("_object_set");

        // Symbol.iterator 闭包 [magic, func_ptr]
        vm.movImm(VReg.A0, 16);
        vm.call("_alloc");
        vm.mov(VReg.S2, VReg.RET);
        vm.movImm(VReg.V1, 0xc105);
        vm.store(VReg.S2, 0, VReg.V1);
        vm.lea(VReg.V1, "_generator_self");
        vm.store(VReg.S2, 8, VReg.V1);

        // obj["Symbol.iterator"] = 闭包(与编译器 for-of 通用分支同 key 字面量)
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.A1, this.vm.asm.addString("Symbol.iterator"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.movImm64(VReg.V1, 0x7fff000000000000n);
        vm.or(VReg.A2, VReg.S2, VReg.V1);
        vm.call("_object_set");

        // obj["return"] = 闭包 [magic, _generator_return, coro]（gen.return(v)）
        vm.movImm(VReg.A0, 24);
        vm.call("_alloc");
        vm.mov(VReg.S2, VReg.RET);
        vm.movImm(VReg.V1, 0xc105);
        vm.store(VReg.S2, 0, VReg.V1);
        vm.lea(VReg.V1, "_generator_return");
        vm.store(VReg.S2, 8, VReg.V1);
        vm.store(VReg.S2, 16, VReg.S0); // 捕获槽 = coro 裸指针
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.A1, this.vm.asm.addString("return"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.movImm64(VReg.V1, 0x7fff000000000000n);
        vm.or(VReg.A2, VReg.S2, VReg.V1);
        vm.call("_object_set");

        // obj["throw"] = 闭包 [magic, _generator_throw, coro]（gen.throw(e)）
        vm.movImm(VReg.A0, 24);
        vm.call("_alloc");
        vm.mov(VReg.S2, VReg.RET);
        vm.movImm(VReg.V1, 0xc105);
        vm.store(VReg.S2, 0, VReg.V1);
        vm.lea(VReg.V1, "_generator_throw");
        vm.store(VReg.S2, 8, VReg.V1);
        vm.store(VReg.S2, 16, VReg.S0); // 捕获槽 = coro 裸指针
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.A1, this.vm.asm.addString("throw"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.movImm64(VReg.V1, 0x7fff000000000000n);
        vm.or(VReg.A2, VReg.S2, VReg.V1);
        vm.call("_object_set");

        // [诊断] GEN_DBG=1 编译时打印 coro/obj/closure 指针
        if (process.env.GEN_DBG) {
            vm.mov(VReg.A0, VReg.S0);
            vm.call("_print_hex");
            vm.mov(VReg.A0, VReg.S1);
            vm.call("_print_hex");
            vm.mov(VReg.A0, VReg.S2);
            vm.call("_print_hex");
        }

        // 返回 boxed 对象
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.RET, VReg.S1, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
    }

    // _generator_next: 生成器 .next(v)。闭包调用约定:S0=闭包裸指针, A0=v, A5=this。
    // 语义:
    //   coro 已 COMPLETED → {value: undefined, done: true}(重复 next)
    //   resume 后 COMPLETED → {value: 体返回值(裸0→undefined), done: true}
    //   resume 后 SUSPENDED → {value: yield 出的值(coro+72), done: false}
    // yield 值协议见编译器 compileYieldExpression:yield 侧先写 coro+72 再挂起;
    // 恢复侧 _coroutine_resume 把 v 写 coro+72,yield 续体读回作为表达式值。
    generateGeneratorNext() {
        const vm = this.vm;

        vm.label("_generator_next");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);

        vm.load(VReg.S1, VReg.S0, 16); // S1 = coro(闭包捕获槽)

        // [诊断] GEN_DBG=1 打印 closure/coro 指针
        if (process.env.GEN_DBG) {
            vm.mov(VReg.S2, VReg.A0);
            vm.mov(VReg.A0, VReg.S0);
            vm.call("_print_hex");
            vm.mov(VReg.A0, VReg.S1);
            vm.call("_print_hex");
            vm.mov(VReg.A0, VReg.S2);
        }

        // 已完成的生成器:恒 {undefined, true}
        vm.load(VReg.V1, VReg.S1, 8);
        vm.cmpImm(VReg.V1, CORO_STATUS_COMPLETED);
        vm.jeq("_gennext_exhausted");

        // resume(coro, v)
        vm.mov(VReg.A1, VReg.A0); // v
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_coroutine_resume");

        // 挂起(yield)还是完成(return)?
        vm.load(VReg.V1, VReg.S1, 8);
        vm.cmpImm(VReg.V1, CORO_STATUS_COMPLETED);
        vm.jeq("_gennext_completed");

        // yield: 值在 coro+72
        vm.load(VReg.A0, VReg.S1, 72);
        vm.lea(VReg.A1, "_js_false");
        vm.load(VReg.A1, VReg.A1, 0);
        vm.call("_generator_make_result");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);

        // return: 返回值在 coro+72(默认 return 的裸 0 归一成 undefined)
        vm.label("_gennext_completed");
        // [gen unwind] 体内未捕获异常经 returnLabel 完成协程(pending 保留,不再跨栈
        // _throw_unwind)→ 此处在调用方栈上向 next() 调用者传播。
        vm.lea(VReg.V0, "_exception_pending");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_gennext_completed_ok");
        vm.call("_throw_unwind"); // 不返回
        vm.label("_gennext_completed_ok");
        vm.load(VReg.A0, VReg.S1, 72);
        vm.cmpImm(VReg.A0, 0);
        vm.jne("_gennext_completed_val");
        vm.lea(VReg.A0, "_js_undefined");
        vm.load(VReg.A0, VReg.A0, 0);
        vm.label("_gennext_completed_val");
        vm.lea(VReg.A1, "_js_true");
        vm.load(VReg.A1, VReg.A1, 0);
        vm.call("_generator_make_result");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);

        vm.label("_gennext_exhausted");
        vm.lea(VReg.A0, "_js_undefined");
        vm.load(VReg.A0, VReg.A0, 0);
        vm.lea(VReg.A1, "_js_true");
        vm.load(VReg.A1, VReg.A1, 0);
        vm.call("_generator_make_result");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);
    }

    // _generator_return: gen.return(v)。闭包约定 S0=闭包裸指针, A0=v, A5=this。
    // 挂起中的协程:置 _gen_return_pending/_gen_return_value 后 resume——yield 恢复点
    // (emitYieldValue)消费注入,内联跑挂起点与出口间的 finalizer 再完成协程。
    //   resume 后 COMPLETED → {value: coro+72(即注入值,或 finalizer 自身 return 覆盖), done:true}
    //   resume 后 SUSPENDED(finalizer 里 yield)→ {value: coro+72, done:false}(spec 语义)
    //   resume 后 _exception_pending(finalizer 抛出)→ 在调用方栈上 _throw_unwind
    // 未启动/已完成:直接置 COMPLETED,返回 {value:v, done:true}(不跑体内任何代码,spec 一致)。
    generateGeneratorReturn() {
        const vm = this.vm;

        vm.label("_generator_return");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2]);

        vm.mov(VReg.S2, VReg.A0);        // S2 = v(跨 load/store 保命)
        vm.load(VReg.S1, VReg.S0, 16);   // S1 = coro(闭包捕获槽)

        // 仅挂起中的协程需要注入 resume(跑 finalizer);其余直接完成
        vm.load(VReg.V1, VReg.S1, 8);
        vm.cmpImm(VReg.V1, CORO_STATUS_SUSPENDED);
        vm.jne("_genret_direct");

        // 注入:_gen_return_value = v, _gen_return_pending = 1, resume(coro, undefined)
        vm.lea(VReg.V0, "_gen_return_value");
        vm.store(VReg.V0, 0, VReg.S2);
        vm.lea(VReg.V0, "_gen_return_pending");
        vm.movImm(VReg.V1, 1);
        vm.store(VReg.V0, 0, VReg.V1);
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.A1, "_js_undefined");
        vm.load(VReg.A1, VReg.A1, 0);
        vm.call("_coroutine_resume");

        // finalizer 抛出?(pending 保留至此)→ 调用方栈上传播
        vm.lea(VReg.V0, "_exception_pending");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_genret_exc");

        // COMPLETED → {coro+72, done:true};SUSPENDED(finalizer yield)→ {coro+72, done:false}
        vm.load(VReg.V1, VReg.S1, 8);
        vm.cmpImm(VReg.V1, CORO_STATUS_COMPLETED);
        vm.jne("_genret_suspended");
        vm.load(VReg.A0, VReg.S1, 72);
        vm.cmpImm(VReg.A0, 0);
        vm.jne("_genret_completed_val");
        vm.lea(VReg.A0, "_js_undefined");
        vm.load(VReg.A0, VReg.A0, 0);
        vm.label("_genret_completed_val");
        vm.lea(VReg.A1, "_js_true");
        vm.load(VReg.A1, VReg.A1, 0);
        vm.call("_generator_make_result");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);

        vm.label("_genret_suspended");
        vm.load(VReg.A0, VReg.S1, 72);
        vm.lea(VReg.A1, "_js_false");
        vm.load(VReg.A1, VReg.A1, 0);
        vm.call("_generator_make_result");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);

        vm.label("_genret_exc");
        vm.call("_throw_unwind"); // 不返回

        // 未启动/已完成:置 COMPLETED,{value:v, done:true}
        vm.label("_genret_direct");
        vm.movImm(VReg.V1, CORO_STATUS_COMPLETED);
        vm.store(VReg.S1, 8, VReg.V1);
        // 记住返回值,使后续对 coro 的直接观察一致(诊断用途)
        vm.store(VReg.S1, 72, VReg.S2);
        vm.mov(VReg.A0, VReg.S2);
        vm.lea(VReg.A1, "_js_true");
        vm.load(VReg.A1, VReg.A1, 0);
        vm.call("_generator_make_result");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
    }

    // _generator_throw: gen.throw(e)。闭包约定 S0=闭包裸指针, A0=e, A5=this。
    // 语义:把异常注入挂起点。置 _exception_value/_exception_pending 后 resume 协程,
    // 生成器体的 yield 恢复点(compileYieldExpression 已插入检查)见 pending 则跳本地
    // exceptionLabel(体内 try 的 catch)→ 捕获后续跑;无体内 try 则跳 returnLabel 完成
    // 协程(pending 保留)→ 回到这里向调用者传播(近似,记偏差)。
    //   coro 已 COMPLETED → 不 resume,直接把 e 作为未捕获异常向调用者传播。
    //   resume 后 SUSPENDED → {value: coro+72, done:false}(catch 里又 yield)。
    //   resume 后 COMPLETED:pending 清 → {value: coro+72(裸0→undefined), done:true};
    //                        pending 仍在 → 未捕获,向调用者传播。
    generateGeneratorThrow() {
        const vm = this.vm;

        vm.label("_generator_throw");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2]);

        vm.mov(VReg.S2, VReg.A0);        // S2 = e
        vm.load(VReg.S1, VReg.S0, 16);   // S1 = coro

        // 已完成的生成器:直接把 e 当未捕获异常向调用者传播
        vm.load(VReg.V1, VReg.S1, 8);
        vm.cmpImm(VReg.V1, CORO_STATUS_COMPLETED);
        vm.jeq("_genthrow_propagate");

        // 置异常状态,resume(coro, undefined)
        vm.lea(VReg.V0, "_exception_value");
        vm.store(VReg.V0, 0, VReg.S2);
        vm.lea(VReg.V0, "_exception_pending");
        vm.movImm(VReg.V1, 1);
        vm.store(VReg.V0, 0, VReg.V1);

        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.A1, "_js_undefined");
        vm.load(VReg.A1, VReg.A1, 0);
        vm.call("_coroutine_resume");

        // resume 返回后:SUSPENDED(catch 又 yield)还是 COMPLETED?
        vm.load(VReg.V1, VReg.S1, 8);
        vm.cmpImm(VReg.V1, CORO_STATUS_COMPLETED);
        vm.jeq("_genthrow_completed");

        // SUSPENDED:{value: coro+72, done:false}
        vm.load(VReg.A0, VReg.S1, 72);
        vm.lea(VReg.A1, "_js_false");
        vm.load(VReg.A1, VReg.A1, 0);
        vm.call("_generator_make_result");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);

        vm.label("_genthrow_completed");
        // 未捕获?(体内无 try 时 yield 恢复点跳 returnLabel 完成,pending 仍置)
        vm.lea(VReg.V0, "_exception_pending");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_genthrow_propagate_pending");

        // 已捕获且完成:{value: coro+72(裸0→undefined), done:true}
        vm.load(VReg.A0, VReg.S1, 72);
        vm.cmpImm(VReg.A0, 0);
        vm.jne("_genthrow_completed_val");
        vm.lea(VReg.A0, "_js_undefined");
        vm.load(VReg.A0, VReg.A0, 0);
        vm.label("_genthrow_completed_val");
        vm.lea(VReg.A1, "_js_true");
        vm.load(VReg.A1, VReg.A1, 0);
        vm.call("_generator_make_result");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);

        // 未捕获传播:置 pending/value(若尚未置),交给调用者的 catch 上下文链
        vm.label("_genthrow_propagate");
        vm.lea(VReg.V0, "_exception_value");
        vm.store(VReg.V0, 0, VReg.S2);
        vm.lea(VReg.V0, "_exception_pending");
        vm.movImm(VReg.V1, 1);
        vm.store(VReg.V0, 0, VReg.V1);
        vm.label("_genthrow_propagate_pending");
        vm.call("_throw_unwind");
        // _throw_unwind 不返回(跳到 catch 帧或退出);占位 epilogue 保栈平衡
        vm.lea(VReg.A0, "_js_undefined");
        vm.load(VReg.A0, VReg.A0, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
    }

    // _generator_self: obj[Symbol.iterator]() → this。
    // 方法约定 this 走 A5(compileMethodCall),生成器对象自迭代。
    generateGeneratorSelf() {
        const vm = this.vm;

        vm.label("_generator_self");
        vm.prologue(0, []);
        vm.mov(VReg.RET, VReg.A5);
        vm.epilogue([], 0);
    }

    // _generator_make_result(A0=value, A1=done布尔JSValue) -> boxed {value, done}
    generateGeneratorMakeResult() {
        const vm = this.vm;

        vm.label("_generator_make_result");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);

        vm.call("_object_new");
        vm.mov(VReg.S2, VReg.RET);

        vm.mov(VReg.A0, VReg.S2);
        vm.lea(VReg.A1, this.vm.asm.addString("value"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.mov(VReg.A2, VReg.S0);
        vm.call("_object_set");

        vm.mov(VReg.A0, VReg.S2);
        vm.lea(VReg.A1, this.vm.asm.addString("done"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.mov(VReg.A2, VReg.S1);
        vm.call("_object_set");

        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.RET, VReg.S2, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
    }

    // [async generator] _async_generator_new(A0=body func, A1=首参, A2=closure)
    // 与 _generator_new 同构:建协程(CREATED,不入队,由 .next() 手动 resume)+对象,但:
    //  - obj["next"] → _async_generator_next(返回 Promise<{value,done}>,而非直接 {value,done})
    //  - obj["Symbol.asyncIterator"] → _generator_self(自迭代,供 for await 消费)
    //  - obj["Symbol.iterator"] 也置 self(健壮)。协程 +88(promise 槽)复用为"当前挂起的
    //    next() Promise":async-yield 侧 resolve 它,.next() 侧在协程完成时 resolve 它 done:true。
    generateAsyncGeneratorNew() {
        const vm = this.vm;
        vm.label("_async_generator_new");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2]);
        vm.call("_coroutine_create"); // A0/A1/A2 透传
        vm.mov(VReg.S0, VReg.RET); // S0 = coro
        vm.call("_object_new");
        vm.mov(VReg.S1, VReg.RET); // S1 = obj(裸)
        // 内部槽 obj["__gen_coro"] = coro
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.A1, this.vm.asm.addString("__gen_coro"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.mov(VReg.A2, VReg.S0);
        vm.call("_object_set");
        // next 闭包 [magic, _async_generator_next, coro]
        vm.movImm(VReg.A0, 24);
        vm.call("_alloc");
        vm.mov(VReg.S2, VReg.RET);
        vm.movImm(VReg.V1, 0xc105);
        vm.store(VReg.S2, 0, VReg.V1);
        vm.lea(VReg.V1, "_async_generator_next");
        vm.store(VReg.S2, 8, VReg.V1);
        vm.store(VReg.S2, 16, VReg.S0);
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.A1, this.vm.asm.addString("next"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.movImm64(VReg.V1, 0x7fff000000000000n);
        vm.or(VReg.A2, VReg.S2, VReg.V1);
        vm.call("_object_set");
        // Symbol.asyncIterator 闭包 [magic, _generator_self]
        vm.movImm(VReg.A0, 16);
        vm.call("_alloc");
        vm.mov(VReg.S2, VReg.RET);
        vm.movImm(VReg.V1, 0xc105);
        vm.store(VReg.S2, 0, VReg.V1);
        vm.lea(VReg.V1, "_generator_self");
        vm.store(VReg.S2, 8, VReg.V1);
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.A1, this.vm.asm.addString("Symbol.asyncIterator"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.movImm64(VReg.V1, 0x7fff000000000000n);
        vm.or(VReg.A2, VReg.S2, VReg.V1);
        vm.call("_object_set");
        // 返回 boxed 对象
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.RET, VReg.S1, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 0);
    }

    // [async generator] _async_generator_next(A0=v)。闭包约定 S0=闭包裸指针, A0=v。
    // 建 Promise P、置 coro+88=P、resume 协程,返回 P:
    //  - 协程 async-yield → 已在 yield 侧 resolve P {value,done:false} 并清 +88;
    //  - 协程 await 挂起 → +88 仍=P,P pending;事件循环唤醒后其后的 yield 再 resolve;
    //  - 协程完成(return) → +88 仍=P,此处 resolve P {value:+72, done:true}。
    generateAsyncGeneratorNext() {
        const vm = this.vm;
        vm.label("_async_generator_next");
        vm.prologue(0, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.load(VReg.S1, VReg.S0, 16); // S1 = coro
        // 已完成的生成器:返回已 resolve 的 Promise {undefined, true}
        vm.load(VReg.V1, VReg.S1, 8);
        vm.cmpImm(VReg.V1, CORO_STATUS_COMPLETED);
        vm.jeq("_agn_completed_already");
        vm.mov(VReg.S2, VReg.A0); // S2 = v(next 传入值)
        // P = _promise_new(0)
        vm.movImm(VReg.A0, 0);
        vm.call("_promise_new");
        vm.mov(VReg.S3, VReg.RET); // S3 = P(boxed)
        vm.store(VReg.S1, 88, VReg.S3); // coro+88 = 当前挂起的 next Promise
        // resume(coro, v)
        vm.mov(VReg.A1, VReg.S2);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_coroutine_resume");
        // COMPLETED?
        vm.load(VReg.V1, VReg.S1, 8);
        vm.cmpImm(VReg.V1, CORO_STATUS_COMPLETED);
        vm.jne("_agn_return_p"); // SUSPENDED:yield 已 resolve 或 await pending → 直接返回 P
        // 完成:若 +88 仍非 0(无收尾 yield),resolve P {value:+72, done:true}
        vm.load(VReg.V1, VReg.S1, 88);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_agn_return_p");
        vm.load(VReg.A0, VReg.S1, 72); // 体返回值(默认 return 的裸 0 归一成 undefined)
        vm.cmpImm(VReg.A0, 0);
        vm.jne("_agn_retval_ok");
        vm.lea(VReg.A0, "_js_undefined");
        vm.load(VReg.A0, VReg.A0, 0);
        vm.label("_agn_retval_ok");
        vm.lea(VReg.A1, "_js_true");
        vm.load(VReg.A1, VReg.A1, 0);
        vm.call("_generator_make_result"); // RET = {value, done:true}
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S3); // P
        vm.call("_promise_resolve");
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.S1, 88, VReg.V1); // 清 +88
        vm.label("_agn_return_p");
        vm.mov(VReg.RET, VReg.S3);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);
        // 已耗尽:返回已 resolve 的 {undefined, true}
        vm.label("_agn_completed_already");
        vm.movImm(VReg.A0, 0);
        vm.call("_promise_new");
        vm.mov(VReg.S3, VReg.RET);
        vm.movImm64(VReg.A0, 0x7ffb000000000000n); // undefined
        vm.lea(VReg.A1, "_js_true");
        vm.load(VReg.A1, VReg.A1, 0);
        vm.call("_generator_make_result");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_promise_resolve");
        vm.mov(VReg.RET, VReg.S3);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 0);
    }

    // _coroutine_create: 创建新协程
    // A0 = 函数指针
    // A1 = 参数
    // A2 = closure 指针（可选，0 表示无）
    // 返回: 协程对象指针
    generateCoroutineCreate() {
        const vm = this.vm;
        const arch = this.arch;

        vm.label("_coroutine_create");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);

        vm.mov(VReg.S0, VReg.A0); // 函数指针
        vm.mov(VReg.S1, VReg.A1); // 参数
        // closure_ptr 须存 callee-saved:下方跨两次 _alloc,V4 会被
        // _alloc 内部调用链(_get_size_class 等)踩掉(实测踩成 0x2000),
        // 协程 +96 存入垃圾 → 生成器/async 闭包体读捕获槽段错误。
        vm.mov(VReg.S3, VReg.A2); // closure_ptr

        // 分配协程对象
        vm.movImm(VReg.A0, COROUTINE_SIZE);
        vm.call("_alloc");
        vm.mov(VReg.S2, VReg.RET); // S2 = 协程对象

        // 设置类型
        vm.movImm(VReg.V1, TYPE_COROUTINE);
        vm.store(VReg.S2, 0, VReg.V1);

        // 设置状态为 CREATED
        vm.movImm(VReg.V1, CORO_STATUS_CREATED);
        vm.store(VReg.S2, 8, VReg.V1);

        // 分配协程栈
        vm.movImm(VReg.A0, COROUTINE_STACK_SIZE);
        vm.call("_alloc");

        // 设置栈基址
        vm.store(VReg.S2, 16, VReg.RET);

        // 设置栈大小
        vm.movImm(VReg.V1, COROUTINE_STACK_SIZE);
        vm.store(VReg.S2, 24, VReg.V1);

        // 初始化栈指针 (栈顶 = 栈基址 + 栈大小，然后对齐到 16 字节)
        // ARM64 要求 SP 必须是 16 字节对齐的
        vm.addImm(VReg.V1, VReg.RET, COROUTINE_STACK_SIZE);
        // 对齐到 16 字节: sp = sp & ~0xF
        vm.movImm(VReg.V2, -16); // 0xFFFFFFFFFFFFFFF0
        vm.and(VReg.V1, VReg.V1, VReg.V2);
        vm.store(VReg.S2, 32, VReg.V1); // saved_sp

        // 初始化帧指针 = 栈指针
        vm.store(VReg.S2, 40, VReg.V1); // saved_fp

        // 设置入口地址为协程 trampoline
        vm.lea(VReg.V1, "_coroutine_entry");
        vm.store(VReg.S2, 48, VReg.V1); // saved_lr

        // 保存函数指针
        vm.store(VReg.S2, 56, VReg.S0);

        // 保存参数
        vm.store(VReg.S2, 64, VReg.S1);

        // 初始化 result = 0
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.S2, 72, VReg.V1);

        // next = null
        vm.store(VReg.S2, 80, VReg.V1);

        // promise = null
        vm.store(VReg.S2, 88, VReg.V1);

        // closure_ptr
        vm.store(VReg.S2, 96, VReg.S3);

        // resumer 链 + 多实参槽初始化为 0（async 协程不写实参槽,读得 0 = undefined 语义;
        // 生成器 stub 随后回填 arg1-4;resumer 由 _coroutine_resume 在 resume 时写入）
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.S2, CORO_RESUMER, VReg.V1);
        vm.store(VReg.S2, CORO_ARG1, VReg.V1);
        vm.store(VReg.S2, CORO_ARG2, VReg.V1);
        vm.store(VReg.S2, CORO_ARG3, VReg.V1);
        vm.store(VReg.S2, CORO_ARG4, VReg.V1);
        vm.store(VReg.S2, CORO_THIS, VReg.V1); // this=0(async 协程不写 → undefined 语义)
        vm.store(VReg.S2, CORO_EXC_TOP, VReg.V1); // 新协程异常链为空
        // [argc] 快照创建点 _call_argc(生成器 stub/async 调用点刚写,此处仍新鲜)
        vm.lea(VReg.V2, "_call_argc");
        vm.load(VReg.V2, VReg.V2, 0);
        vm.store(VReg.S2, CORO_ARGC, VReg.V2);

        // 生成器 stub 用:把刚建的协程裸指针留在 scratch 全局,stub 回填多实参时读取
        // (单线程、非重入:stub 建协程后立即读,期间无其它协程创建)
        vm.lea(VReg.V1, "_gen_last_coro");
        vm.store(VReg.V1, 0, VReg.S2);

        // [批次D] 分代写屏障:协程块可能已 old(本函数中途 64KB 栈分配常触发 GC,
        // 协程块在 GC 前分配则被标记翻旧),其后 +16 栈指针等裸写是 old→young 引用。
        // sticky minor 不重扫已标记旧块 → 栈块漏标被回收,下一协程复用同栈 →
        // 两个生成器共享栈互踩(实测 a.next() 吐出 b 的值)。记入 RS 使 minor 重扫。
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_gc_remember"); // 叶子函数,只毁 V0-V6,A0/S 寄存器不受影响

        vm.mov(VReg.RET, VReg.S2);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);

        // 协程入口 trampoline
        // 当协程首次被 resume 时执行
        vm.label("_coroutine_entry");
        // 加载当前协程指针
        vm.lea(VReg.V0, "_scheduler_current");
        vm.load(VReg.V0, VReg.V0, 0);

        // 注意：在 arm64 上 V0 与 A0 都映射到 X0。
        // 下面会把参数加载到 A0(X0)，因此先把协程指针复制到 callee-saved 寄存器作为 base。
        vm.mov(VReg.S1, VReg.V0);

        // 加载参数。多实参:A0=arg(coro+64),A1-A4=coro+112..136。
        // func_ptr 用 V6(R11 scratch)而非 V1——x64 上 V1=RCX=A3,若用 V1 存 func 会被
        // 下面 A3 的加载踩掉。A0-A4 加载不碰 V6,故 V6 末尾加载再 callIndirect 安全。
        vm.load(VReg.A0, VReg.S1, 64); // arg (A0)
        vm.load(VReg.A1, VReg.S1, CORO_ARG1);
        vm.load(VReg.A2, VReg.S1, CORO_ARG2);
        vm.load(VReg.A3, VReg.S1, CORO_ARG3);
        vm.load(VReg.A4, VReg.S1, CORO_ARG4);
        vm.load(VReg.A5, VReg.S1, CORO_THIS); // this(方法接收者;后续 load S0/V6 不碰 A5)

        // 恢复 closure 指针到 S0（闭包函数会从 S0 读取捕获变量）
        vm.load(VReg.S0, VReg.S1, 96); // closure_ptr

        // [argc] 恢复创建点实参个数到全局(体内 arguments 构建读取)
        vm.load(VReg.V1, VReg.S1, CORO_ARGC);
        vm.lea(VReg.V2, "_call_argc");
        vm.store(VReg.V2, 0, VReg.V1);

        // 调用协程函数
        vm.load(VReg.V6, VReg.S1, 56); // func_ptr
        vm.callIndirect(VReg.V6);

        // 函数返回，保存结果并标记完成
        vm.lea(VReg.V1, "_scheduler_current");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.store(VReg.V1, 72, VReg.RET); // 保存返回值

        // 调用 _coroutine_return 处理完成
        vm.jmp("_coroutine_return");
    }

    // _coroutine_resume: 恢复协程执行
    // A0 = 协程对象指针
    // A1 = resume value（可选，0 表示无）
    generateCoroutineResume() {
        const vm = this.vm;
        const arch = this.arch;

        vm.label("_coroutine_resume");
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);

        vm.mov(VReg.S0, VReg.A0); // S0 = 目标协程

        // 检查状态
        vm.load(VReg.V1, VReg.S0, 8);
        vm.cmpImm(VReg.V1, CORO_STATUS_COMPLETED);
        const notCompletedLabel = "_coro_resume_not_completed";
        vm.jne(notCompletedLabel);

        // 已完成，返回结果
        vm.load(VReg.RET, VReg.S0, 72);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);

        vm.label(notCompletedLabel);

        // 写入 resume value（yield 恢复后会读这里作为返回值）
        vm.store(VReg.S0, 72, VReg.A1);

        // resumer 链:把「谁在 resume」(=当前协程)记为 target 的 resumer,并把本 resume
        // 调用帧的上下文停泊进 resumer 自己的槽 —— target yield/return 时据此回到 resumer。
        // 顶层(主协程 resume)时 resumer=主协程,行为与旧的硬编码 _scheduler_main 完全一致;
        // 生成器体内 resume 另一个生成器(yield*/嵌套)时 resumer=外层协程,天然支持任意嵌套深度。
        vm.lea(VReg.S1, "_scheduler_current");
        vm.load(VReg.S1, VReg.S1, 0); // S1 = resumer(当前协程)

        // 保存当前上下文到 resumer 槽
        // 注意: ARM64 的 STR 指令中 Rt=31 是 XZR 不是 SP,需先 mov SP 到通用寄存器再 store
        vm.mov(VReg.V0, VReg.SP);
        vm.store(VReg.S1, 32, VReg.V0); // resumer.saved_sp = 本 resume 帧 SP
        vm.store(VReg.S1, 40, VReg.FP); // resumer.saved_fp

        // 记录 target 的 resumer,供 yield/return 回跳
        vm.store(VReg.S0, CORO_RESUMER, VReg.S1);

        // [exc 链切换] 停泊 resumer 的异常链,安装 target 的(与 SP/FP 同步切换)
        vm.lea(VReg.V2, "_exc_ctx_top");
        vm.load(VReg.V3, VReg.V2, 0);
        vm.store(VReg.S1, CORO_EXC_TOP, VReg.V3);
        vm.load(VReg.V3, VReg.S0, CORO_EXC_TOP);
        vm.store(VReg.V2, 0, VReg.V3);

        // 设置当前协程
        vm.lea(VReg.V1, "_scheduler_current");
        vm.store(VReg.V1, 0, VReg.S0);

        // 设置状态为运行中
        vm.movImm(VReg.V1, CORO_STATUS_RUNNING);
        vm.store(VReg.S0, 8, VReg.V1);

        // 加载目标协程的上下文
        vm.load(VReg.V1, VReg.S0, 32); // saved_sp
        vm.load(VReg.V2, VReg.S0, 40); // saved_fp
        vm.load(VReg.V3, VReg.S0, 48); // saved_lr

        // 切换到目标协程
        vm.mov(VReg.SP, VReg.V1);
        vm.mov(VReg.FP, VReg.V2);

        // 跳转到目标协程
        vm.jmpIndirect(VReg.V3);

        // 从 yield/return 回来的 continuation
        // 这里运行在主协程（调度器）栈上，直接把控制权还给调用者（scheduler_run）
        vm.label("_coroutine_resume_cont");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 64);
    }

    // _coroutine_yield: 挂起当前协程
    // 恢复后：返回 resume value（由 _coroutine_resume 写入 coro.result/+72）
    generateCoroutineYield() {
        const vm = this.vm;
        const arch = this.arch;

        vm.label("_coroutine_yield");
        vm.prologue(32, [VReg.S0, VReg.S1]);

        // 获取当前协程
        vm.lea(VReg.S0, "_scheduler_current");
        vm.load(VReg.S0, VReg.S0, 0);

        // [批次D] 分代写屏障:协程块(+72 yield 值/上下文字段)与协程栈块都是
        // 被直接裸写的容器——挂起期间若 minor GC(主栈分配触发),old 容器里的
        // young 引用(挂起栈上的活值、yield 出的值)不经记忆集会被误收。
        // 每次挂起前把两块记入 RS(去重位图使重复记录 O(1))。
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_gc_remember"); // 协程对象块(叶子函数,只毁 V0-V6)
        vm.load(VReg.A0, VReg.S0, 16);
        vm.call("_gc_remember"); // 协程栈块(64KB,整块保守重扫)

        // 设置状态为挂起
        vm.movImm(VReg.V1, CORO_STATUS_SUSPENDED);
        vm.store(VReg.S0, 8, VReg.V1);

        // 保存当前上下文
        // ARM64: STR Rt=31 是 XZR，需要先 mov SP 到通用寄存器
        vm.mov(VReg.V0, VReg.SP);
        vm.store(VReg.S0, 32, VReg.V0);
        vm.store(VReg.S0, 40, VReg.FP);
        // 保存恢复地址：恢复时回到 _coroutine_yield_resume
        vm.lea(VReg.V1, "_coroutine_yield_resume");
        vm.store(VReg.S0, 48, VReg.V1);

        // 回到 resumer(谁 resume 了本协程)而非硬编码主协程 —— 支持嵌套
        vm.load(VReg.S1, VReg.S0, CORO_RESUMER); // S1 = resumer

        // [exc 链切换] 停泊本协程异常链,安装 resumer 的
        vm.lea(VReg.V2, "_exc_ctx_top");
        vm.load(VReg.V3, VReg.V2, 0);
        vm.store(VReg.S0, CORO_EXC_TOP, VReg.V3);
        vm.load(VReg.V3, VReg.S1, CORO_EXC_TOP);
        vm.store(VReg.V2, 0, VReg.V3);

        // 设置当前为 resumer
        vm.lea(VReg.V1, "_scheduler_current");
        vm.store(VReg.V1, 0, VReg.S1);

        // 恢复 resumer 上下文(其在 _coroutine_resume 停泊的 resume 调用帧)
        vm.load(VReg.V1, VReg.S1, 32); // saved_sp
        vm.load(VReg.V2, VReg.S1, 40); // saved_fp

        vm.mov(VReg.SP, VReg.V1);
        vm.mov(VReg.FP, VReg.V2);

        // 回到 _coroutine_resume 的 continuation
        vm.mov(VReg.RET, VReg.S0); // 返回刚刚 yield 的协程指针
        vm.jmp("_coroutine_resume_cont");

        // ===== resume continuation（在协程栈上执行） =====
        vm.label("_coroutine_yield_resume");
        // 从当前协程读回 resume value 作为 yield 的返回值
        vm.lea(VReg.S0, "_scheduler_current");
        vm.load(VReg.S0, VReg.S0, 0);
        vm.load(VReg.RET, VReg.S0, 72);
        vm.epilogue([VReg.S0, VReg.S1], 32);
    }

    // _coroutine_return: 协程完成时调用
    generateCoroutineReturn() {
        const vm = this.vm;

        vm.label("_coroutine_return");

        // [批次D] 写屏障:完成路径 +72 已被 _coroutine_entry 写入返回值(可能是
        // young 对象),协程块须入记忆集(_gc_remember 只毁 V0-V6,A0 原样保留)
        vm.lea(VReg.V0, "_scheduler_current");
        vm.load(VReg.A0, VReg.V0, 0);
        vm.call("_gc_remember");

        // 获取当前协程
        vm.mov(VReg.V0, VReg.A0);

        // 设置状态为完成
        vm.movImm(VReg.V1, CORO_STATUS_COMPLETED);
        vm.store(VReg.V0, 8, VReg.V1);

        // 回到 resumer(谁 resume 了本协程)而非硬编码主协程 —— 支持嵌套
        vm.load(VReg.V1, VReg.V0, CORO_RESUMER);

        // [exc 链切换] 协程已完成,其链废弃;安装 resumer 的链
        vm.lea(VReg.V4, "_exc_ctx_top");
        vm.load(VReg.V5, VReg.V1, CORO_EXC_TOP);
        vm.store(VReg.V4, 0, VReg.V5);

        // 设置当前为 resumer
        vm.lea(VReg.V2, "_scheduler_current");
        vm.store(VReg.V2, 0, VReg.V1);

        // 恢复 resumer 上下文
        vm.load(VReg.V2, VReg.V1, 32);
        vm.load(VReg.V3, VReg.V1, 40);

        vm.mov(VReg.SP, VReg.V2);
        vm.mov(VReg.FP, VReg.V3);

        // 返回到 _coroutine_resume 的 continuation
        vm.mov(VReg.RET, VReg.V0);
        vm.jmp("_coroutine_resume_cont");
    }

    // 调度器数据段
    generateSchedulerData() {
        // 这些在 data section 中生成
        // 由 generateDataSection 处理
    }

    // _scheduler_init: 初始化调度器
    generateSchedulerInit() {
        const vm = this.vm;

        vm.label("_scheduler_init");
        vm.prologue(16, [VReg.S0]);

        // 创建主协程对象
        vm.movImm(VReg.A0, COROUTINE_SIZE);
        vm.call("_alloc");
        vm.mov(VReg.S0, VReg.RET);

        // 设置类型
        vm.movImm(VReg.V1, TYPE_COROUTINE);
        vm.store(VReg.S0, 0, VReg.V1);

        // 设置状态为运行中
        vm.movImm(VReg.V1, CORO_STATUS_RUNNING);
        vm.store(VReg.S0, 8, VReg.V1);

        // 主协程使用当前栈
        // ARM64: STR Rt=31 是 XZR，需要先 mov SP 到通用寄存器
        vm.mov(VReg.V0, VReg.SP);
        vm.store(VReg.S0, 32, VReg.V0);
        vm.store(VReg.S0, 40, VReg.FP);

        // resumer/异常链/argc 槽清零(_alloc 不清零;主协程 resumer 恒空,
        // _throw_unwind 的协程判别与 exc 链切换读这些槽)
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.S0, CORO_RESUMER, VReg.V1);
        vm.store(VReg.S0, CORO_EXC_TOP, VReg.V1);
        vm.store(VReg.S0, CORO_ARGC, VReg.V1);

        // 设置为主协程和当前协程
        vm.lea(VReg.V1, "_scheduler_main");
        vm.store(VReg.V1, 0, VReg.S0);

        vm.lea(VReg.V1, "_scheduler_current");
        vm.store(VReg.V1, 0, VReg.S0);

        // 初始化就绪队列为空
        vm.movImm(VReg.V1, 0);
        vm.lea(VReg.V2, "_scheduler_ready_head");
        vm.store(VReg.V2, 0, VReg.V1);
        vm.lea(VReg.V2, "_scheduler_ready_tail");
        vm.store(VReg.V2, 0, VReg.V1);

        vm.epilogue([VReg.S0], 16);
    }

    // _scheduler_run: 运行调度器
    // 执行所有就绪的协程直到全部完成
    generateSchedulerRun() {
        const vm = this.vm;

        vm.label("_scheduler_run");
        vm.prologue(32, [VReg.S0, VReg.S1]);

        const loopLabel = "_sched_run_loop";
        const doneLabel = "_sched_run_done";

        vm.label(loopLabel);

        // 检查就绪队列是否为空
        vm.lea(VReg.V0, "_scheduler_ready_head");
        vm.load(VReg.S0, VReg.V0, 0);
        vm.cmpImm(VReg.S0, 0);
        vm.jeq(doneLabel);

        // 从队列取出协程
        vm.load(VReg.S1, VReg.S0, 80); // next
        vm.lea(VReg.V0, "_scheduler_ready_head");
        vm.store(VReg.V0, 0, VReg.S1);

        // 如果队列空了，更新 tail
        vm.cmpImm(VReg.S1, 0);
        const notEmptyLabel = "_sched_not_empty";
        vm.jne(notEmptyLabel);
        vm.lea(VReg.V0, "_scheduler_ready_tail");
        vm.store(VReg.V0, 0, VReg.S1);
        vm.label(notEmptyLabel);

        // 清除 next
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.S0, 80, VReg.V1);

        // 恢复执行该协程
        vm.mov(VReg.A0, VReg.S0);
        vm.movImm(VReg.A1, 0);
        vm.call("_coroutine_resume");

        // [方言/panic] 协程以未捕获异常完成(_exception_pending 保留至此,主栈上):
        // Go panic 语义 —— 打印后非零退出。async 体自带 reject 落点不会走到这,
        // 只有 js f(x) 派发体的未捕获异常(或运行时 helper 抛出)到达。
        vm.lea(VReg.V0, "_exception_pending");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_sched_run_no_panic");
        vm.lea(VReg.A0, this.vm.asm.addString("panic: uncaught exception in spawned coroutine:"));
        vm.call("_print_str_no_nl");
        vm.lea(VReg.A0, "_exception_value");
        vm.load(VReg.A0, VReg.A0, 0);
        vm.call("_valueToStr");   // 异常值 → 字符串(可能带 0x7FFC tag)
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.A0, VReg.RET, VReg.V1); // 去 tag 成裸内容指针(_print_str 走 _strlen)
        vm.call("_print_str");
        vm.movImm(VReg.A0, 1);
        if (this.os === "wasi") {
            vm.syscall(60);
        } else if (this.arch === "arm64") {
            vm.syscall(this.os === "linux" ? 93 : 1);
        } else {
            vm.syscall(this.os === "linux" ? 60 : 0x2000001);
        }
        vm.label("_sched_run_no_panic");

        // 继续循环
        vm.jmp(loopLabel);

        vm.label(doneLabel);
        vm.epilogue([VReg.S0, VReg.S1], 32);
    }

    // _scheduler_spawn: 添加协程到就绪队列
    // A0 = 协程对象指针
    generateSchedulerSpawn() {
        const vm = this.vm;

        vm.label("_scheduler_spawn");
        vm.prologue(16, [VReg.S0]);

        vm.mov(VReg.S0, VReg.A0);

        // [M3 step 2] GOMAXPROCS>1 → 派发到并行 P 运行队列(_par_spawn:计数+入本 M 的 P+唤醒),
        // 由第二个 M 窃取执行。默认 GOMAXPROCS=1(定点)→ jle 走既有全局链表串行路径,逐字节不变。
        // _par_spawn 在非 linux-arm64 为桩;仅 __par_smoke 显式开门时触达。
        vm.lea(VReg.V0, "_gomaxprocs");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, 1);
        vm.jle("_sched_spawn_serial");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_par_spawn");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0], 16);
        vm.label("_sched_spawn_serial");

        // 清除 next
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.S0, 80, VReg.V1);

        // 检查队列是否为空
        vm.lea(VReg.V0, "_scheduler_ready_tail");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, 0);
        const notEmptyLabel = "_spawn_not_empty";
        vm.jne(notEmptyLabel);

        // 队列为空，设置 head 和 tail
        vm.lea(VReg.V0, "_scheduler_ready_head");
        vm.store(VReg.V0, 0, VReg.S0);
        vm.lea(VReg.V0, "_scheduler_ready_tail");
        vm.store(VReg.V0, 0, VReg.S0);
        vm.jmp("_spawn_done");

        vm.label(notEmptyLabel);
        // 添加到队列尾部
        vm.store(VReg.V1, 80, VReg.S0); // tail.next = coro
        vm.lea(VReg.V0, "_scheduler_ready_tail");
        vm.store(VReg.V0, 0, VReg.S0); // tail = coro

        vm.label("_spawn_done");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0], 16);
    }

    // 生成数据段
    generateDataSection(asm) {
        // 调度器全局变量
        asm.addDataLabel("_scheduler_main");
        asm.addDataQword(0); // 主协程指针

        asm.addDataLabel("_scheduler_current");
        asm.addDataQword(0); // 当前运行的协程

        asm.addDataLabel("_scheduler_ready_head");
        asm.addDataQword(0); // 就绪队列头

        asm.addDataLabel("_scheduler_ready_tail");
        asm.addDataQword(0); // 就绪队列尾

        asm.addDataLabel("_gen_last_coro");
        asm.addDataQword(0); // 生成器 stub 回填多实参用的 scratch 协程指针
    }
}
