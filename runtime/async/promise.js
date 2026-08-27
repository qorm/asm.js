// asm.js 运行时 - Promise 支持
// Promise 对象为 NaN-boxed 对象值(tag 0x7ffd)，底层是堆对象。
// resolve/reject 以闭包对象的形式传给 executor；then/catch 在 promise 已 settled
// 时同步触发回调，pending 时挂到链表，settle 时统一触发。await 走协程挂起/恢复，
// 被 reject 时通过 _exception_pending/_exception_value 让编译期 try/catch 捕获。

import { VReg } from "../../vm/index.js";

// 闭包魔数（与编译器保持一致）
const CLOSURE_MAGIC = 0xc105;
const ASYNC_CLOSURE_MAGIC = 0xa51c;

// Promise 状态
const PROMISE_PENDING = 0;
const PROMISE_FULFILLED = 1;
const PROMISE_REJECTED = 2;

// Promise 对象内存布局:
// +0:  type (8 bytes) = TYPE_PROMISE (11)
// +8:  status (8 bytes) - pending/fulfilled/rejected
// +16: value (8 bytes) - resolved 值或 rejected 原因
// +24: then_handlers (8 bytes) - then 回调链表头
// +32: catch_handlers (8 bytes) - catch 回调链表头
// +40: waiting_coro (8 bytes) - 等待此 Promise 的协程
// +48: proto (8 bytes) - 子类 [[Prototype]](0 → Promise.prototype)

// Handler 节点(24 bytes):
// +0: callback (8 bytes) - 回调函数(tagged 闭包值)
// +8: next_promise (8 bytes) - then/catch 返回的 Promise(boxed)
// +16: next (8 bytes) - 下一个 handler

const TYPE_PROMISE = 11;
const PROMISE_SIZE = 56;
const HANDLER_SIZE = 24;

// resolve/reject 闭包(32B): {magic@0, _aref_generic@8, tramp@16, boxed promise@24}
// fnptr 走 _aref_generic 使 `new resolveFn()` 命中 compileDynamicNew 的非构造器守卫
// (reject-function-nonconstructor / resolve-function-nonconstructor)。
const RESOLVER_SIZE = 32;

const TAG_OBJECT = 0x7ffd000000000000n;
const TAG_STRING = 0x7ffc000000000000n;
const TAG_FUNCTION = 0x7fff000000000000n;
const MASK48 = 0x0000ffffffffffffn;
const JS_UNDEFINED = 0x7ffb000000000000n;

export class PromiseGenerator {
    constructor(vm) {
        this.vm = vm;
        this.arch = vm.arch;
        this.os = vm.platform;
        this._labelId = 0;
    }

    newLabel(prefix) {
        return `_${prefix}_${this._labelId++}`;
    }

    // 生成 NaN-boxed 字符串常量到 reg（lea + tag），使用 V4 作临时。
    emitStringConst(reg, str) {
        const vm = this.vm;
        vm.lea(reg, vm.asm.addString(str));
        vm.movImm64(VReg.V4, TAG_STRING);
        vm.or(reg, reg, VReg.V4);
    }

    // ==================== [test262] 运行时内联异常帧 ====================
    // 布局/压帧序列镜像 compilePromiseTry(compiler/functions/functions.js):
    //   {link@0, catchPC@8, SP@16, FP@24, S0@32..S4@64, S5@72} —— 80 字节。
    // 定址用 **SP 相对**:帧落在 prologue 分配的局部区内,函数体内 SP 恒定;
    // _throw_unwind 把 SP/FP/S0-S5 整体恢复到压帧时刻,故 catchPC 处同一 SP+off
    // 仍指向本帧、且 S 寄存器里的循环状态原样可用。
    // 用途:promise 回调/executor 体内的 throw 必须变成派生 promise 的 rejection,
    // 而不是穿透到 _throw_unwind 链空分支把整个进程 exit(1)。
    emitExcPush(off, catchLabel) {
        const vm = this.vm;
        vm.lea(VReg.V0, "_exc_ctx_top");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.store(VReg.SP, off + 0, VReg.V1);
        vm.lea(VReg.V1, catchLabel);
        vm.store(VReg.SP, off + 8, VReg.V1);
        vm.mov(VReg.V1, VReg.SP);
        vm.store(VReg.SP, off + 16, VReg.V1);
        vm.store(VReg.SP, off + 24, VReg.FP);
        vm.store(VReg.SP, off + 32, VReg.S0);
        vm.store(VReg.SP, off + 40, VReg.S1);
        vm.store(VReg.SP, off + 48, VReg.S2);
        vm.store(VReg.SP, off + 56, VReg.S3);
        vm.store(VReg.SP, off + 64, VReg.S4);
        vm.mov(VReg.V1, VReg.S5); // x64 上 S5 是栈槽,经 mov 取出
        vm.store(VReg.SP, off + 72, VReg.V1);
        vm.addImm(VReg.V1, VReg.SP, off); // 帧基址(arm64 上 add(dst,SP,imm) 认 SP)
        vm.store(VReg.V0, 0, VReg.V1);
    }

    // 弹帧:链头还原为 link。正常路径与 catch 路径都要走(catch 处帧已由 unwind
    // 恢复上下文但**未**出链——见 _throw_unwind 注释)。
    emitExcPop(off) {
        const vm = this.vm;
        vm.lea(VReg.V0, "_exc_ctx_top");
        vm.load(VReg.V1, VReg.SP, off + 0);
        vm.store(VReg.V0, 0, VReg.V1);
    }

    // 读并清 _exception_pending / 取 _exception_value -> dst
    emitTakeException(dst) {
        const vm = this.vm;
        vm.lea(VReg.V0, "_exception_pending");
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.V0, 0, VReg.V1);
        vm.lea(VReg.V0, "_exception_value");
        vm.load(dst, VReg.V0, 0);
    }

    // 调用方必须先把 RET 挪到 callee-saved:本检查用 V0,x64 上 V0 别名 RET。
    emitJumpIfPending(label) {
        const vm = this.vm;
        vm.lea(VReg.V0, "_exception_pending");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmpImm(VReg.V0, 0);
        vm.jne(label);
    }

    generate() {
        this.generatePromiseInvoke1();
        this.generatePromiseInvoke2();
        this.generateMakeResolver();
        this.generateThenableAdopt();
        this.generateReactionQueue();
        this.generateIsPromise();
        this.generateIsPromiseOrThenable();
        this.generateResolverTrampolines();
        this.generatePromiseNew();
        this.generatePromiseResolve();
        this.generatePromiseReject();
        this.generatePromiseThen();
        this.generatePromiseThen2();
        this.generateThenSpec();
        this.generatePromiseCatch();
        this.generatePromiseAwait();
        this.generatePromiseResolveStatic();
        this.generatePssCustomC();
        this.generatePromiseRejectStatic();
        this.generatePromiseTryStatic();
        this.generatePromiseWithResolvers();
        this.generateMakeSettledResult();
        this.generateNewCapability();
        this.generateCombinatorElem();
        this.generateAppendHandler();
        this.generateAggregateError();
        this.generateCombinatorGuard();
        this.generateCombinatorIter();
        this.generatePromiseAll();
        this.generatePromiseRace();
        this.generatePromiseAllSettled();
        this.generatePromiseAny();
        this.generatePromiseFinally();
        this.generateBoundTramp();
        this.generatePromiseCtorCall();
        this.generateArefGuards();
    }

    // _promise_invoke1(A0=cb, A1=arg) -> RET
    // 调用回调，支持 tagged 闭包值 / 裸闭包指针 / 裸函数指针。cb 为 0 时返回 undefined。
    generatePromiseInvoke1() {
        const vm = this.vm;

        // [D1b OrdinaryCallBindThis] _ordinary_bind_this(A0=code_ptr, A1=原 this) -> RET。
        // 规范 10.2.1.2 只作用于 ECMAScript 函数对象:未登记进 func_meta 的内建入口
        // (_aref_* 蹦床、runtime helper)按 [[Call]] 原样收 thisArgument —— 否则
        // `Object.prototype.hasOwnProperty.call(undefined)` 之类不再抛 TypeError。
        // 已登记且非严格 → globalThis;严格 → 原值(undefined/null)不动。
        vm.label("_ordinary_bind_this");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S1, VReg.A1);
        vm.call("_func_meta_entry"); // A0=code_ptr → RET = 条目 / 0
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_obt_keep");
        vm.load(VReg.RET, VReg.RET, 8); // kind@8
        vm.shrImm(VReg.RET, VReg.RET, 8);
        vm.andImm(VReg.RET, VReg.RET, 1);
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_obt_keep");
        vm.lea(VReg.V0, "_global_this");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_obt_keep");
        vm.movImm64(VReg.V1, TAG_OBJECT);
        vm.or(VReg.RET, VReg.V0, VReg.V1);
        vm.epilogue([VReg.S0, VReg.S1], 16);
        vm.label("_obt_keep");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1], 16);

        vm.label("_promise_invoke1");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S1, VReg.A1); // arg
        vm.call("_js_unbox"); // A0=cb -> RET 裸指针
        vm.mov(VReg.S0, VReg.RET);
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_pi1_undef");
        vm.load(VReg.V1, VReg.S0, 0); // magic
        vm.movImm(VReg.V2, CLOSURE_MAGIC);
        vm.cmp(VReg.V1, VReg.V2);
        vm.jeq("_pi1_closure");
        vm.movImm(VReg.V2, ASYNC_CLOSURE_MAGIC);
        vm.cmp(VReg.V1, VReg.V2);
        vm.jeq("_pi1_closure");
        // 裸函数指针：func=S0，闭包指针清 0
        vm.mov(VReg.V1, VReg.S0);
        vm.movImm(VReg.S0, 0);
        vm.jmp("_pi1_call");
        vm.label("_pi1_closure");
        vm.load(VReg.V1, VReg.S0, 8); // func_ptr，S0 保持为闭包指针
        vm.label("_pi1_call");
        // [test262] promise 反应回调按 Call(handler, undefined, «arg») 走,再经
        // OrdinaryCallBindThis:严格回调得 undefined、非严格回调得 globalThis
        // (rxn-handler-*-invoke-strict / -nonstrict)。helper 会毁 V1,先落栈。
        vm.store(VReg.SP, 0, VReg.V1);
        vm.mov(VReg.A0, VReg.V1);
        vm.movImm64(VReg.A1, JS_UNDEFINED);
        vm.call("_ordinary_bind_this");
        vm.store(VReg.SP, 8, VReg.RET);
        vm.load(VReg.V1, VReg.SP, 0);
        vm.mov(VReg.A0, VReg.S1); // arg
        vm.setCallArgcImm(1, VReg.V2, VReg.V3); // [argc ABI] callback(value)
        // V4 在 x64 上别名 A5,故写 A5 必须放在 V1(=A3,函数指针)之后、callIndirect 之前。
        vm.load(VReg.A5, VReg.SP, 8);
        vm.callIndirect(VReg.V1);
        vm.jmp("_pi1_done");
        vm.label("_pi1_undef");
        vm.movImm64(VReg.RET, JS_UNDEFINED);
        vm.label("_pi1_done");
        vm.epilogue([VReg.S0, VReg.S1], 16);
    }

    // _promise_invoke2(A0=fn, A1=thisVal, A2=arg0, A3=arg1, A4=argc) -> RET
    // 与 _promise_invoke1 同一分派(tagged 闭包 / 裸闭包 / 裸函数指针),但传 this +
    // 显式 argc(0/1/2)。用于 thenable 采纳的 then.call(thenable, res, rej)(argc=2)
    // 与 finally 的 onFinally()(argc=0,规范要求回调收到零个实参)。
    generatePromiseInvoke2() {
        const vm = this.vm;
        vm.label("_promise_invoke2");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        vm.mov(VReg.S1, VReg.A1); // this
        vm.mov(VReg.S2, VReg.A2); // arg0
        vm.mov(VReg.S3, VReg.A3); // arg1
        vm.mov(VReg.S4, VReg.A4); // argc
        vm.call("_js_unbox");     // A0=fn -> RET 裸指针
        vm.mov(VReg.S0, VReg.RET);
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_pi2_undef");
        vm.load(VReg.V1, VReg.S0, 0); // magic
        vm.movImm(VReg.V2, CLOSURE_MAGIC);
        vm.cmp(VReg.V1, VReg.V2);
        vm.jeq("_pi2_closure");
        vm.movImm(VReg.V2, ASYNC_CLOSURE_MAGIC);
        vm.cmp(VReg.V1, VReg.V2);
        vm.jeq("_pi2_closure");
        vm.mov(VReg.V1, VReg.S0); // 裸函数指针
        vm.movImm(VReg.S0, 0);
        vm.jmp("_pi2_call");
        vm.label("_pi2_closure");
        vm.load(VReg.V1, VReg.S0, 8); // func_ptr,S0 保持闭包指针
        vm.label("_pi2_call");
        // thisVal 为 undefined 时按 callee [[Strict]] 绑 globalThis(非严格)
        vm.movImm64(VReg.V2, JS_UNDEFINED);
        vm.cmp(VReg.S1, VReg.V2);
        vm.jne("_pi2_this_ok");
        vm.store(VReg.SP, 0, VReg.V1);
        vm.mov(VReg.A0, VReg.V1);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_ordinary_bind_this");
        vm.mov(VReg.S1, VReg.RET);
        vm.load(VReg.V1, VReg.SP, 0);
        vm.label("_pi2_this_ok");
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S3);
        vm.lea(VReg.V2, "_call_argc"); // [argc ABI] 由调用方指定
        vm.store(VReg.V2, 0, VReg.S4);
        vm.mov(VReg.A5, VReg.S1); // this(V4 别名 A5,置于 V1 之后)
        vm.callIndirect(VReg.V1);
        vm.jmp("_pi2_done");
        vm.label("_pi2_undef");
        vm.movImm64(VReg.RET, JS_UNDEFINED);
        vm.label("_pi2_done");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 32);
    }

    // _promise_make_resolver(A0=boxed promise, A1=0 resolve / 1 reject) -> RET boxed 一等函数
    // 闭包 {CLOSURE_MAGIC@0, _aref_generic@8, tramp@16, boxed promise@24}。
    // fnptr=_aref_generic → `new resolveFn()` 走 compileDynamicNew 非构造器守卫抛 TypeError。
    // 调用:aref 把用户实参右移、A0=this,tramp 从 A1 取结算值、S0+24 取 promise。
    generateMakeResolver() {
        const vm = this.vm;
        vm.label("_promise_make_resolver");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S1, VReg.A0); // boxed promise
        vm.mov(VReg.S2, VReg.A1); // kind
        vm.movImm(VReg.A0, RESOLVER_SIZE);
        vm.call("_alloc");
        vm.mov(VReg.S0, VReg.RET);
        vm.movImm(VReg.V1, CLOSURE_MAGIC);
        vm.store(VReg.S0, 0, VReg.V1);
        vm.lea(VReg.V1, "_aref_generic");
        vm.store(VReg.S0, 8, VReg.V1);
        vm.cmpImm(VReg.S2, 0);
        vm.jne("_pmk_rej");
        vm.lea(VReg.V1, "_promise_resolve_tramp");
        vm.jmp("_pmk_store");
        vm.label("_pmk_rej");
        vm.lea(VReg.V1, "_promise_reject_tramp");
        vm.label("_pmk_store");
        vm.store(VReg.S0, 16, VReg.V1);
        vm.store(VReg.S0, 24, VReg.S1);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_js_box_function");
        // 规范 27.2.1.3.1/3.2:Promise resolve/reject 函数 name=""、length=1。
        // Promise.all Invoke(p,"then",«resolveElement, reject») 测例读 b.length。
        vm.mov(VReg.S2, VReg.RET);
        vm.mov(VReg.A0, VReg.S2);
        vm.lea(VReg.A1, vm.asm.addString("name"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.lea(VReg.A2, vm.asm.addString(""));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A2, VReg.A2, VReg.V1);
        vm.call("_closure_prop_define");
        vm.mov(VReg.A0, VReg.S2);
        vm.lea(VReg.A1, vm.asm.addString("length"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.movImm(VReg.A2, 1);
        vm.scvtf(0, VReg.A2);
        vm.fmovToInt(VReg.A2, 0);
        vm.call("_closure_prop_define");
        vm.mov(VReg.RET, VReg.S2);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);
    }

    // ==================== [test262] thenable 采纳 ====================
    // _promise_thenable_adopt(A0=boxed 目标 promise, A1=thenable 值, A2=其 then 函数)
    // 规范 25.6.1.3.2 步骤 9 + NewPromiseResolveThenableJob:
    //   then.call(thenable, resolveFn, rejectFn);then 抛出 → 以抛出值 reject 目标。
    // then 的**查找**由调用方(_promise_resolve)只做一次并把结果经 A2 传入,故不会
    // 重复触发 getter。调用本身在本帧异常帧保护下,抛出不再穿透成进程级未捕获。
    generateThenableAdopt() {
        const vm = this.vm;
        const EXC = 0;
        vm.label("_promise_thenable_adopt");
        vm.prologue(112, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S0, VReg.A0); // boxed promise
        vm.mov(VReg.S1, VReg.A1); // thenable
        vm.mov(VReg.S2, VReg.A2); // then 函数
        // resolveFn -> S3、rejectFn -> V6 之前先建 resolve
        vm.mov(VReg.A0, VReg.S0);
        vm.movImm(VReg.A1, 0);
        vm.call("_promise_make_resolver");
        vm.mov(VReg.S3, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.movImm(VReg.A1, 1);
        vm.call("_promise_make_resolver");
        vm.mov(VReg.V6, VReg.RET); // rejectFn(caller-saved,紧接着就用)
        this.emitExcPush(EXC, "_pta_catch");
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A2, VReg.S3);
        vm.mov(VReg.A3, VReg.V6);
        vm.movImm(VReg.A4, 2);
        vm.call("_promise_invoke2");
        this.emitExcPop(EXC);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 112);
        vm.label("_pta_catch");
        this.emitExcPop(EXC);
        vm.mov(VReg.A0, VReg.S0);
        this.emitTakeException(VReg.A1);
        vm.call("_promise_reject");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 112);
    }

    // ==================== [#74] Promise 反应微任务队列 ====================
    // promise 结算(resolve/reject)后,已注册的 .then/.catch 回调不再同步直调,而是排入
    // 微任务队列,在本轮同步"job"结束后统一排空(_promise_drain_reactions 由入口在
    // _main → _scheduler_run 之后调用,先于 _ev_run)。这样 `Promise.resolve().then(cb)`
    // 里的 cb 排到后续同步代码之后 —— s1|s2|t。await 不走此队列(仍经协程挂起/唤醒),
    // 故 async-await 语义不受影响。一次 _promise_drain_reactions 内部循环排空整条链
    // (排空中新入队的反应追加到队尾、同循环内消费),故入口单次调用即可,不需外层循环。
    //
    // 反应节点(32 字节):+0 next(裸)、+8 callback(值)、+16 value、+24 next_promise(boxed,0=无)
    // 头尾指针 _promise_micro_head/_promise_micro_tail(GC 根扫描区,排队回调存活)。
    generateReactionQueue() {
        const vm = this.vm;

        // _promise_enqueue_reaction(A0=callback, A1=value, A2=next_promise)
        vm.label("_promise_enqueue_reaction");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.S2, VReg.A2);
        vm.movImm(VReg.A0, 32);
        vm.call("_alloc");
        vm.mov(VReg.S3, VReg.RET);
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.S3, 0, VReg.V1); // next = 0
        vm.store(VReg.S3, 8, VReg.S0);
        vm.store(VReg.S3, 16, VReg.S1);
        vm.store(VReg.S3, 24, VReg.S2);
        vm.lea(VReg.V0, "_promise_micro_tail");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_per_has_tail");
        vm.lea(VReg.V0, "_promise_micro_head");
        vm.store(VReg.V0, 0, VReg.S3);
        vm.lea(VReg.V0, "_promise_micro_tail");
        vm.store(VReg.V0, 0, VReg.S3);
        vm.jmp("_per_done");
        vm.label("_per_has_tail");
        vm.store(VReg.V1, 0, VReg.S3); // tail.next = node
        vm.lea(VReg.V0, "_promise_micro_tail");
        vm.store(VReg.V0, 0, VReg.S3);
        vm.label("_per_done");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);

        // _promise_drain_reactions() -> RET = 排空的反应数(0=队列已空)
        // 逐个弹出队首:invoke(callback,value)→result;有 next_promise 则 resolve(next,result)。
        //
        // [test262] 反应回调体内的 throw 必须**拒绝派生 promise**(PromiseReactionJob:
        // handler 抛出 → Call(promiseCapability.[[Reject]], undefined, «thrownValue»)),
        // 此前无本地异常帧 → _throw_unwind 链空 → 整个进程 exit(1),
        // `.then(f).then(onOk, onErr)` / `.catch` 这类恢复链全部失效。
        // 每轮迭代在本帧内压一个 80B 异常帧(SP+0),invoke + resolve 落在保护区内;
        // 抛出时 unwind 恢复 SP/FP/S0-S3(循环状态原样),落到 _pdr_catch。
        const EXC = 0; // 异常帧在局部区的偏移
        vm.label("_promise_drain_reactions");
        vm.prologue(112, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.movImm(VReg.S3, 0); // count
        vm.label("_pdr_loop");
        vm.lea(VReg.V0, "_promise_micro_head");
        vm.load(VReg.S0, VReg.V0, 0);
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_pdr_done");
        vm.load(VReg.S1, VReg.S0, 0); // next
        vm.lea(VReg.V0, "_promise_micro_head");
        vm.store(VReg.V0, 0, VReg.S1);
        vm.cmpImm(VReg.S1, 0);
        vm.jne("_pdr_notempty");
        vm.lea(VReg.V0, "_promise_micro_tail");
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.V0, 0, VReg.V1);
        vm.label("_pdr_notempty");
        this.emitExcPush(EXC, "_pdr_catch");
        vm.load(VReg.A0, VReg.S0, 8); // callback
        vm.load(VReg.A1, VReg.S0, 16); // value
        vm.call("_promise_invoke1");
        vm.mov(VReg.S2, VReg.RET); // result
        vm.load(VReg.A0, VReg.S0, 24); // next_promise
        vm.cmpImm(VReg.A0, 0);
        vm.jeq("_pdr_unprotect");
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_promise_resolve");
        vm.label("_pdr_unprotect");
        this.emitExcPop(EXC);
        vm.jmp("_pdr_next");

        // 回调(或其结果的 thenable 采纳)抛出:拒绝派生 promise 后继续排空。
        // 无派生 promise(next_promise==0,如 thenable job)时保持旧语义:回置
        // pending 位后 _throw_unwind 向外层(编译期 try/catch 或进程)传播。
        vm.label("_pdr_catch");
        this.emitExcPop(EXC);
        vm.load(VReg.V0, VReg.S0, 24); // next_promise
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_pdr_rethrow");
        vm.mov(VReg.A0, VReg.V0);
        this.emitTakeException(VReg.A1);
        vm.call("_promise_reject");
        vm.jmp("_pdr_next");
        vm.label("_pdr_rethrow");
        vm.call("_throw_unwind"); // 不返回

        vm.label("_pdr_next");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_pdr_loop");
        vm.label("_pdr_done");
        vm.mov(VReg.RET, VReg.S3);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 112);
    }

    // _is_promise(A0=value) -> RET 1/0
    generateIsPromise() {
        const vm = this.vm;
        vm.label("_is_promise");
        vm.prologue(16, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);
        vm.shrImm(VReg.V1, VReg.S0, 48);
        vm.movImm(VReg.V0, 0x7ffd);
        vm.cmp(VReg.V1, VReg.V0);
        vm.jne("_isp_no");
        vm.movImm64(VReg.V1, MASK48);
        vm.and(VReg.S0, VReg.S0, VReg.V1);
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_isp_no");
        vm.load(VReg.V1, VReg.S0, 0); // type
        vm.cmpImm(VReg.V1, TYPE_PROMISE);
        vm.jne("_isp_no");
        vm.movImm(VReg.RET, 1);
        vm.epilogue([VReg.S0], 16);
        vm.label("_isp_no");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0], 16);
    }

    // _is_promise_or_thenable(A0=value) -> RET 1/0
    // Promise 节点(0x7FFD+TYPE_PROMISE)或 thenable(对象 + 自有可调 then)。
    // await resolve/Promise.resolve 共用统一判定。
    generateIsPromiseOrThenable() {
        const vm = this.vm;
        vm.label("_is_promise_or_thenable");
        vm.prologue(16, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);
        // Promise 快路
        vm.shrImm(VReg.V1, VReg.S0, 48);
        vm.cmpImm(VReg.V1, 0x7ffd);
        vm.jne("_ipoth_obj");
        vm.movImm64(VReg.V1, MASK48);
        vm.and(VReg.V0, VReg.S0, VReg.V1);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_ipoth_obj");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, TYPE_PROMISE);
        vm.jne("_ipoth_obj");
        vm.movImm(VReg.RET, 1);
        vm.epilogue([VReg.S0], 16);
        // 对象:tag==0x7FFD 且 node 非 0,检自有可调 then。函数/prototype 链上 toString/
        // hasOwnProperty 等取不到 fn(非函数 tag)。
        vm.label("_ipoth_obj");
        vm.shrImm(VReg.V1, VReg.S0, 48); // 重新加载 tag(Promise 快路用过后 V1 已是 stale)
        vm.cmpImm(VReg.V1, 0x7ffd);
        vm.jne("_ipoth_no");
        vm.movImm64(VReg.V1, MASK48);
        vm.and(VReg.V0, VReg.S0, VReg.V1);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_ipoth_no");
        // then 查找不调 getter:await 的 PromiseResolve 会再 Get 一次。若此处解
        // 访问器,`get then()` thenable 会被读两次(yield-star async-next 族)。
        // TYPE_GETTER 标记视为可能 thenable,交给 _Promise_resolve 解一次。
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("then"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_object_get");
        vm.shrImm(VReg.V1, VReg.RET, 48);
        vm.cmpImm(VReg.V1, 0x7fff);
        vm.jeq("_ipoth_yes");
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_ipoth_boxed_obj");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_ipoth_no");
        vm.load(VReg.V2, VReg.RET, 0);
        vm.cmpImm(VReg.V2, 60); // TYPE_GETTER
        vm.jeq("_ipoth_yes");
        vm.cmpImm(VReg.V2, 0xc105);
        vm.jeq("_ipoth_yes");
        vm.cmpImm(VReg.V2, 0xa51c);
        vm.jeq("_ipoth_yes");
        vm.jmp("_ipoth_no");
        vm.label("_ipoth_boxed_obj");
        vm.cmpImm(VReg.V1, 0x7ffd);
        vm.jne("_ipoth_no");
        vm.movImm64(VReg.V1, MASK48);
        vm.and(VReg.V2, VReg.RET, VReg.V1);
        vm.load(VReg.V2, VReg.V2, 0);
        vm.movImm(VReg.V1, 0xc105);
        vm.cmp(VReg.V2, VReg.V1);
        vm.jeq("_ipoth_yes");
        vm.movImm(VReg.V1, 0xa51c);
        vm.cmp(VReg.V2, VReg.V1);
        vm.jne("_ipoth_no");
        vm.label("_ipoth_yes");
        vm.movImm(VReg.RET, 1);
        vm.epilogue([VReg.S0], 16);
        vm.label("_ipoth_no");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0], 16);
    }

    // resolve/reject 蹦床:经 _aref_generic 进入,A0=this(忽略), A1=值, S0=闭包裸指针。
    generateResolverTrampolines() {
        const vm = this.vm;

        vm.label("_promise_resolve_tramp");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S1, VReg.A1); // 值(aref 右移后)
        vm.load(VReg.A0, VReg.S0, 24); // boxed promise
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_promise_resolve");
        vm.movImm64(VReg.RET, JS_UNDEFINED);
        vm.epilogue([VReg.S0, VReg.S1], 16);

        vm.label("_promise_reject_tramp");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S1, VReg.A1);
        vm.load(VReg.A0, VReg.S0, 24);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_promise_reject");
        vm.movImm64(VReg.RET, JS_UNDEFINED);
        vm.epilogue([VReg.S0, VReg.S1], 16);
    }

    // _promise_new(A0=executor tagged 值或 0) -> boxed Promise
    generatePromiseNew() {
        const vm = this.vm;

        // [test262] executor 体内的同步 throw 必须 **reject 新建的 promise**
        // (25.6.3.1 步骤 10:completion 为 abrupt → Call(reject, undefined, «value»)),
        // 此前无异常帧 → _throw_unwind 链空 → 进程 exit(1)(reject-via-abrupt 等)。
        // 局部区扩到 128B:SP+0..79 异常帧,其余为原 48B 余量。
        const EXC = 0;
        vm.label("_promise_new");
        vm.prologue(128, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);

        vm.mov(VReg.S0, VReg.A0); // executor(tagged)

        // 分配 Promise 对象
        vm.movImm(VReg.A0, PROMISE_SIZE);
        vm.call("_alloc");
        vm.mov(VReg.S1, VReg.RET); // 裸 promise 指针

        vm.movImm(VReg.V1, TYPE_PROMISE);
        vm.store(VReg.S1, 0, VReg.V1);
        vm.movImm(VReg.V1, PROMISE_PENDING);
        vm.store(VReg.S1, 8, VReg.V1);
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.S1, 16, VReg.V1); // value
        vm.store(VReg.S1, 24, VReg.V1); // then_handlers
        vm.store(VReg.S1, 32, VReg.V1); // catch_handlers
        vm.store(VReg.S1, 40, VReg.V1); // waiting_coro
        vm.store(VReg.S1, 48, VReg.V1); // proto(0 → gPO 回落 Promise.prototype)

        // box promise -> S2
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_js_box_object");
        vm.mov(VReg.S2, VReg.RET);

        // 无 executor：直接返回
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_pn_done");

        // [test262] IsCallable(executor) 检查(25.6.3.1 步骤 2)。
        // 非可调用值(字符串/数字/null/undefined/对象等)一律抛 TypeError，不再
        // 经 _js_unbox 把任意 payload 当裸指针解引用(SIGBUS/SIGSEGV)。
        vm.shrImm(VReg.V1, VReg.S0, 48);
        vm.cmpImm(VReg.V1, 0x7FFF);
        vm.jeq("_pn_typeok");
        vm.cmpImm(VReg.V1, 0); // 裸指针
        vm.jne("_pn_notcallable");
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_pn_notcallable");
        vm.label("_pn_typeok");

        // resolve/reject 一等函数(唯一构造点 _promise_make_resolver)
        vm.mov(VReg.A0, VReg.S2);
        vm.movImm(VReg.A1, 0);
        vm.call("_promise_make_resolver");
        vm.mov(VReg.S3, VReg.RET); // tagged resolve
        vm.mov(VReg.A0, VReg.S2);
        vm.movImm(VReg.A1, 1);
        vm.call("_promise_make_resolver");
        vm.mov(VReg.S4, VReg.RET); // tagged reject

        // executor 调用全程置于本帧异常帧保护下
        this.emitExcPush(EXC, "_pn_exec_throw");

        // 解出 executor 裸指针与函数指针
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_js_unbox");
        vm.mov(VReg.S0, VReg.RET); // 裸 executor 指针
        vm.load(VReg.V1, VReg.S0, 0); // magic
        vm.movImm(VReg.V2, CLOSURE_MAGIC);
        vm.cmp(VReg.V1, VReg.V2);
        vm.jeq("_pn_exec_closure");
        vm.movImm(VReg.V2, ASYNC_CLOSURE_MAGIC);
        vm.cmp(VReg.V1, VReg.V2);
        vm.jeq("_pn_exec_closure");
        // 裸函数指针
        vm.mov(VReg.V5, VReg.S0); // func
        vm.movImm(VReg.S0, 0);
        vm.jmp("_pn_exec_call");
        vm.label("_pn_exec_closure");
        vm.load(VReg.V5, VReg.S0, 8); // func_ptr，S0 = 闭包指针
        vm.label("_pn_exec_call");
        // executor(resolve, reject)
        vm.mov(VReg.A0, VReg.S3);
        vm.mov(VReg.A1, VReg.S4);
        vm.setCallArgcImm(2, VReg.V1, VReg.V2); // [argc ABI] executor(resolve, reject)
        vm.movImm64(VReg.A5, JS_UNDEFINED);     // this = undefined(V4 别名 A5,置于 V5 之后)
        vm.callIndirect(VReg.V5);
        this.emitExcPop(EXC);
        vm.jmp("_pn_done");

        // executor 抛出:以抛出值 reject(已 settle 者 _promise_reject 自会忽略)
        vm.label("_pn_exec_throw");
        this.emitExcPop(EXC);
        vm.mov(VReg.A0, VReg.S2);
        this.emitTakeException(VReg.A1);
        vm.call("_promise_reject");
        vm.jmp("_pn_done");

        vm.label("_pn_notcallable");
        this.emitStringConst(VReg.A0, "Promise executor is not callable");
        vm.call("_throw_type_error"); // 不返回

        vm.label("_pn_done");
        vm.mov(VReg.RET, VReg.S2);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 128);

        // _promise_super_init(A0=boxed this, A1=executor)
        // `class C extends Promise { constructor(ex){ super(ex) } }` 把预分配
        // TYPE_OBJECT(56B, __proto__@16=C.prototype) 原地改写成 TYPE_PROMISE,
        // 再按 Promise 构造器调 executor(resolve, reject)。proto 挪到 +48。
        vm.label("_promise_super_init");
        vm.prologue(128, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        vm.mov(VReg.S0, VReg.A1); // executor
        vm.call("_js_unbox");     // A0=this → 裸指针
        vm.mov(VReg.S1, VReg.RET);
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_psi_new");
        vm.loadByte(VReg.V1, VReg.S1, 0);
        vm.cmpImm(VReg.V1, TYPE_PROMISE);
        vm.jeq("_psi_already");
        vm.load(VReg.S4, VReg.S1, 16); // 保存对象 __proto__
        vm.movImm(VReg.V1, TYPE_PROMISE);
        vm.store(VReg.S1, 0, VReg.V1);
        vm.movImm(VReg.V1, PROMISE_PENDING);
        vm.store(VReg.S1, 8, VReg.V1);
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.S1, 16, VReg.V1);
        vm.store(VReg.S1, 24, VReg.V1);
        vm.store(VReg.S1, 32, VReg.V1);
        vm.store(VReg.S1, 40, VReg.V1);
        vm.store(VReg.S1, 48, VReg.S4); // proto
        vm.jmp("_psi_box");
        vm.label("_psi_already");
        vm.jmp("_psi_box");
        vm.label("_psi_new");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_promise_new");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 128);
        vm.label("_psi_box");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_js_box_object");
        vm.mov(VReg.S2, VReg.RET);
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_psi_done");
        vm.shrImm(VReg.V1, VReg.S0, 48);
        vm.cmpImm(VReg.V1, 0x7FFF);
        vm.jeq("_psi_typeok");
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_psi_notcallable");
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_psi_notcallable");
        vm.label("_psi_typeok");
        vm.mov(VReg.A0, VReg.S2);
        vm.movImm(VReg.A1, 0);
        vm.call("_promise_make_resolver");
        vm.mov(VReg.S3, VReg.RET);
        vm.mov(VReg.A0, VReg.S2);
        vm.movImm(VReg.A1, 1);
        vm.call("_promise_make_resolver");
        vm.mov(VReg.S4, VReg.RET);
        this.emitExcPush(0, "_psi_exec_throw");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_js_unbox");
        vm.mov(VReg.S0, VReg.RET);
        vm.load(VReg.V1, VReg.S0, 0);
        vm.movImm(VReg.V2, CLOSURE_MAGIC);
        vm.cmp(VReg.V1, VReg.V2);
        vm.jeq("_psi_exec_closure");
        vm.movImm(VReg.V2, ASYNC_CLOSURE_MAGIC);
        vm.cmp(VReg.V1, VReg.V2);
        vm.jeq("_psi_exec_closure");
        vm.mov(VReg.V5, VReg.S0);
        vm.movImm(VReg.S0, 0);
        vm.jmp("_psi_exec_direct");
        vm.label("_psi_exec_closure");
        vm.load(VReg.V5, VReg.S0, 8);
        vm.lea(VReg.V0, "_aref_generic");
        vm.cmp(VReg.V5, VReg.V0);
        vm.jeq("_psi_exec_aref");
        vm.label("_psi_exec_direct");
        vm.mov(VReg.A0, VReg.S3);
        vm.mov(VReg.A1, VReg.S4);
        vm.setCallArgcImm(2, VReg.V1, VReg.V2);
        vm.movImm64(VReg.A5, JS_UNDEFINED);
        vm.callIndirect(VReg.V5);
        vm.jmp("_psi_exec_done");
        vm.label("_psi_exec_aref");
        // _aref_generic: A5=接收者, A0/A1=用户实参 → helper(A5, A0, A1,…)
        vm.movImm64(VReg.A5, JS_UNDEFINED);
        vm.mov(VReg.A0, VReg.S3); // resolve
        vm.mov(VReg.A1, VReg.S4); // reject
        vm.setCallArgcImm(2, VReg.V1, VReg.V2);
        vm.callIndirect(VReg.V5);
        vm.label("_psi_exec_done");
        this.emitExcPop(0);
        vm.jmp("_psi_done");
        vm.label("_psi_exec_throw");
        this.emitExcPop(0);
        vm.mov(VReg.A0, VReg.S2);
        this.emitTakeException(VReg.A1);
        vm.call("_promise_reject");
        vm.jmp("_psi_done");
        vm.label("_psi_notcallable");
        this.emitStringConst(VReg.A0, "Promise executor is not callable");
        vm.call("_throw_type_error");
        vm.label("_psi_done");
        vm.mov(VReg.RET, VReg.S2);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 128);
    }

    // _promise_resolve(A0=promise, A1=value)
    generatePromiseResolve() {
        const vm = this.vm;

        vm.label("_promise_resolve");
        // 局部区 112B:SP+0..79 是 then 查找期间的异常帧(见 _pr_then_throw)
        vm.prologue(112, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);

        vm.mov(VReg.S1, VReg.A1); // value
        vm.mov(VReg.S0, VReg.A0); // boxed promise(采纳路径要把它交给 resolver 闭包)
        vm.call("_js_unbox"); // A0=promise -> 裸指针
        vm.mov(VReg.S3, VReg.RET);

        // 已 settled 则忽略
        vm.load(VReg.V1, VReg.S3, 8);
        vm.cmpImm(VReg.V1, PROMISE_PENDING);
        vm.jeq("_pr_pending");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 112);

        vm.label("_pr_pending");
        // [test262] 自解析:resolve(p, p) 必须以 TypeError 拒绝 p(规范 25.6.1.3.2
        // 步骤 6)。旧实现走"采纳自身"路径 → 永远 pending,把测试挂死到超时。
        vm.cmp(VReg.S1, VReg.S0);
        vm.jne("_pr_notself");
        vm.mov(VReg.A0, VReg.S0);
        this.emitStringConst(VReg.A1, "Chaining cycle detected for promise");
        vm.call("_promise_reject_type_error");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 112);

        vm.label("_pr_notself");
        // value 若本身是 Promise：**订阅**其结算,而不是同步快照。
        // [test262] 旧实现读内层 status/value 一次就定案:内层还 pending 时把
        // value(=0)当 fulfilled 结果写进外层 —— `new Promise(r=>r(pendingP))`、
        // async 函数 `return pendingP`、组合器回填全部结算成裸 0。
        // [test262] 规范 27.2.1.3.2 步骤 8-9 对**任何**对象都是 Get(x,"then") +
        // PromiseResolveThenableJob,原生 promise 不例外 —— `p.then = custom` 之后
        // resolve(outer, p) 必须调用那个 custom then(resolve-prms-cstm-then 族,
        // finally 的 7 次派生也少了这一次)。故不再对 promise 直接内部采纳,而是把它
        // 一并送进 then 查找;仅当 then 取不到可调用值(Promise.prototype 尚未物化的
        // 语法快路)才退回品牌订阅 _pr_adopt_promise。SP+96 记住这个退路。
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.SP, 96, VReg.V1);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_is_promise");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_pr_tagchk");
        vm.movImm(VReg.V1, 1);
        vm.store(VReg.SP, 96, VReg.V1);
        vm.jmp("_pr_then_lookup");

        vm.label("_pr_tagchk");
        // 非 promise 的 thenable(带可调用 then 的普通对象/数组)必须被采纳:
        // 规范 25.6.1.3.2 步骤 8-9。数组(0x7FFE)也是 Object,Promise.all([]) 结算
        // 的 valuesArray 上 Array.prototype.then 污染依赖此路径
        // (resolve-thenable / resolve-poisoned-then)。
        vm.shrImm(VReg.V1, VReg.S1, 48);
        vm.movImm(VReg.V0, 0x7ffd);
        vm.cmp(VReg.V1, VReg.V0);
        vm.jeq("_pr_then_lookup");
        vm.movImm(VReg.V0, 0x7ffe);
        vm.cmp(VReg.V1, VReg.V0);
        vm.jne("_pr_settle");
        vm.label("_pr_then_lookup");
        // [test262] `then` 的**读取**本身可能抛(访问器 getter:resolve-poisoned-then),
        // 规范要求以抛出值 reject 而不是穿透成进程级未捕获 → 查找放在异常帧内。
        this.emitExcPush(0, "_pr_then_throw");
        vm.mov(VReg.A0, VReg.S1);
        this.emitStringConst(VReg.A1, "then");
        vm.call("_object_get");
        vm.mov(VReg.A1, VReg.S1);  // this = thenable
        vm.mov(VReg.A0, VReg.RET); // _object_get 返回的可能是 getter 标记对象
        vm.call("_maybe_getter");  // 解包访问器(数据属性原样返回)
        vm.mov(VReg.S2, VReg.RET); // 先保住 then,emitExcPop 可能冲 RET
        this.emitExcPop(0);
        vm.shrImm(VReg.V1, VReg.S2, 48);
        vm.movImm(VReg.V0, 0x7fff); // TAG_FUNCTION
        vm.cmp(VReg.V1, VReg.V0);
        vm.jeq("_pr_adopt_thenable");
        // 仅裸指针(高 16 位=0)才可解 magic;数字 then(如 39)的 payload 不是指针。
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_pr_settle");
        vm.movImm64(VReg.V0, MASK48);
        vm.and(VReg.V1, VReg.S2, VReg.V0);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_pr_settle");
        vm.load(VReg.V2, VReg.V1, 0);
        vm.movImm(VReg.V0, 0xc105);
        vm.cmp(VReg.V2, VReg.V0);
        vm.jeq("_pr_adopt_thenable");
        vm.movImm(VReg.V0, 0xa51c);
        vm.cmp(VReg.V2, VReg.V0);
        vm.jne("_pr_settle");
        vm.label("_pr_adopt_thenable");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_promise_thenable_adopt");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 112);

        vm.label("_pr_then_throw"); // then 的 getter 抛出 -> 以抛出值 reject
        this.emitExcPop(0);
        vm.mov(VReg.A0, VReg.S0);
        this.emitTakeException(VReg.A1);
        vm.call("_promise_reject");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 112);

        vm.label("_pr_adopt_promise");
        // inner.then(resolve(outer), reject(outer)) —— 外层保持 pending 直到内层结算。
        vm.mov(VReg.A0, VReg.S0);
        vm.movImm(VReg.A1, 0);
        vm.call("_promise_make_resolver");
        vm.mov(VReg.S2, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.movImm(VReg.A1, 1);
        vm.call("_promise_make_resolver");
        vm.mov(VReg.S3, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S2);
        vm.mov(VReg.A2, VReg.S3);
        vm.call("_promise_then2");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 112);

        vm.label("_pr_settle");
        vm.load(VReg.V1, VReg.SP, 96);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_pr_adopt_promise"); // 原生 promise 但 then 不可调用 → 品牌订阅
        vm.movImm(VReg.V1, PROMISE_FULFILLED);
        vm.store(VReg.S3, 8, VReg.V1);
        vm.store(VReg.S3, 16, VReg.S1);

        // 唤醒等待的协程(await)
        vm.load(VReg.S2, VReg.S3, 40);
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_pr_nowait");
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_scheduler_spawn");
        vm.label("_pr_nowait");

        // 触发 then handlers —— [#74] 排入微任务队列(本轮同步段末排空),不再同步直调
        vm.load(VReg.S2, VReg.S3, 24);
        vm.label("_pr_loop");
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_pr_done");
        vm.load(VReg.A0, VReg.S2, 0); // callback
        vm.mov(VReg.A1, VReg.S1); // value
        vm.load(VReg.A2, VReg.S2, 8); // next_promise
        vm.call("_promise_enqueue_reaction");
        vm.load(VReg.S2, VReg.S2, 16);
        vm.jmp("_pr_loop");
        vm.label("_pr_done");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 112);
    }

    // _promise_reject(A0=promise, A1=reason)：unbox 后交给 _promise_reject_raw
    // _promise_reject_raw(A0=裸 promise, A1=reason)
    generatePromiseReject() {
        const vm = this.vm;

        vm.label("_promise_reject");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S1, VReg.A1);
        vm.call("_js_unbox"); // A0=promise -> 裸
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_promise_reject_raw");
        vm.epilogue([VReg.S0, VReg.S1], 16);

        vm.label("_promise_reject_raw");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S3, VReg.A0); // 裸 promise
        vm.mov(VReg.S1, VReg.A1); // reason

        vm.load(VReg.V1, VReg.S3, 8);
        vm.cmpImm(VReg.V1, PROMISE_PENDING);
        vm.jeq("_prj_pending");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);

        vm.label("_prj_pending");
        vm.movImm(VReg.V1, PROMISE_REJECTED);
        vm.store(VReg.S3, 8, VReg.V1);
        vm.store(VReg.S3, 16, VReg.S1);

        // 唤醒等待协程(await 在 reject 后要恢复再抛)
        vm.load(VReg.S2, VReg.S3, 40);
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_prj_nowait");
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_scheduler_spawn");
        vm.label("_prj_nowait");

        // 触发 catch handlers —— [#74] 排入微任务队列,不再同步直调
        vm.load(VReg.S2, VReg.S3, 32);
        vm.label("_prj_loop");
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_prj_done");
        vm.load(VReg.A0, VReg.S2, 0); // callback
        vm.mov(VReg.A1, VReg.S1); // reason
        vm.load(VReg.A2, VReg.S2, 8); // next_promise
        vm.call("_promise_enqueue_reaction");
        vm.load(VReg.S2, VReg.S2, 16);
        vm.jmp("_prj_loop");
        vm.label("_prj_done");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);
    }

    // _promise_then(A0=promise, A1=cb) -> boxed next promise
    generatePromiseThen() {
        const vm = this.vm;

        vm.label("_promise_then");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S1, VReg.A1); // callback
        vm.call("_js_unbox"); // A0=promise -> 裸
        vm.mov(VReg.S0, VReg.RET);

        vm.movImm(VReg.A0, 0);
        vm.call("_promise_new");
        vm.mov(VReg.S2, VReg.RET); // boxed next

        vm.movImm(VReg.A0, HANDLER_SIZE);
        vm.call("_alloc");
        vm.mov(VReg.S3, VReg.RET);
        vm.store(VReg.S3, 0, VReg.S1); // callback
        vm.store(VReg.S3, 8, VReg.S2); // next promise
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.S3, 16, VReg.V1);

        vm.load(VReg.V1, VReg.S0, 8);
        vm.cmpImm(VReg.V1, PROMISE_FULFILLED);
        vm.jeq("_pt_ful");
        vm.cmpImm(VReg.V1, PROMISE_REJECTED);
        vm.jeq("_pt_rej");
        // pending：尾插到 then 链(FIFO 触发顺序,见 _promise_append_handler)
        vm.addImm(VReg.A0, VReg.S0, 24);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_promise_append_handler");
        // [test262] 拒绝透传:`.then(onFulfil)` 只挂了 fulfil 链,源 promise 后来
        // reject 时没有任何 handler 触发 → 派生 promise 永远 pending,整条
        // `.then(f).catch(g)` 链断掉。补挂一个 reject 侧 handler,回调就是绑定到
        // next 的 reject resolver(next_promise 置 0:由它自己结算 next)。
        vm.mov(VReg.A0, VReg.S2);
        vm.movImm(VReg.A1, 1);
        vm.call("_promise_make_resolver");
        vm.mov(VReg.S1, VReg.RET);
        vm.movImm(VReg.A0, HANDLER_SIZE);
        vm.call("_alloc");
        vm.mov(VReg.S3, VReg.RET);
        vm.store(VReg.S3, 0, VReg.S1);
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.S3, 8, VReg.V1);
        vm.store(VReg.S3, 16, VReg.V1);
        vm.addImm(VReg.A0, VReg.S0, 32);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_promise_append_handler");
        vm.mov(VReg.RET, VReg.S2);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);

        vm.label("_pt_ful");
        // [#74] 已 fulfilled 也排入微任务队列,不同步直调
        vm.mov(VReg.A0, VReg.S1); // callback
        vm.load(VReg.A1, VReg.S0, 16); // value
        vm.mov(VReg.A2, VReg.S2); // next promise(boxed)
        vm.call("_promise_enqueue_reaction");
        vm.mov(VReg.RET, VReg.S2);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);

        vm.label("_pt_rej");
        // [test262] 已 reject 且只提供 onFulfilled:缺省 onRejected 等价 thrower,
        // 仍要排一个 PromiseReactionJob 后才结算 next。同步 _promise_reject 会让
        // next 在 .then() 返回前就已 rejected,后续订阅者的反应因此插到队列更前面
        // (race/resolved-then-catch-finally 会选错 winner)。
        vm.mov(VReg.A0, VReg.S2);
        vm.movImm(VReg.A1, 1);
        vm.call("_promise_make_resolver");
        vm.mov(VReg.A0, VReg.RET);
        vm.load(VReg.A1, VReg.S0, 16);
        vm.movImm(VReg.A2, 0); // resolver 自行结算 next
        vm.call("_promise_enqueue_reaction");
        vm.mov(VReg.RET, VReg.S2);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);
    }

    // _promise_then2(A0=promise, A1=onF, A2=onR) -> boxed next promise。
    // then(onFulfilled, onRejected):onF 挂 fulfill 链(@24)、onR 挂 reject 链(@32),二者
    // 共享同一 next——settle 时只走对应一条链、触发一个回调、resolve 同一 next。复用既有
    // _promise_enqueue_reaction 与链字段,不动反应派发核心(_promise_drain/invoke1 保持)。
    //
    // [test262] 非可调用 handler 的**透传**(规范 27.2.5.4 步骤 3-4):`.then(f, undefined)`
    // 里 undefined 侧此前被当普通回调排队 —— _promise_invoke1 对空回调返 undefined,
    // 于是 next 被 fulfil 成 undefined,拒因(或兑现值)整个丢失。现在把不可调用的一侧
    // 换成绑定到 next 的 resolve/reject 蹦床、并把该 handler 的 next_promise 置 0
    // (由蹦床自己结算 next),语义上等价于 identity / thrower。
    // 可调用判据与 _promise_invoke1 的分派一致:装箱函数(0x7FFF)或非零裸指针。
    generatePromiseThen2() {
        const vm = this.vm;
        const SAVED = [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5];
        // 归一化一侧 handler:不可调用 → 换成 kind 向的 resolver;destSlot 记录该侧
        // handler 的 next_promise(可调用时 = next,透传时 = 0)。
        const normalize = (reg, kind, slot, okLabel) => {
            vm.store(VReg.SP, slot, VReg.S2); // 默认 next_promise = next
            vm.shrImm(VReg.V1, reg, 48);
            vm.movImm(VReg.V0, 0x7fff);
            vm.cmp(VReg.V1, VReg.V0);
            vm.jeq(okLabel);                  // 装箱函数 → 可调用
            vm.cmpImm(VReg.V1, 0);
            vm.jne(okLabel + "_sub");
            vm.cmpImm(reg, 0);
            vm.jne(okLabel);                  // 非零裸指针(闭包/函数)→ 可调用
            vm.label(okLabel + "_sub");
            vm.mov(VReg.A0, VReg.S2);
            vm.movImm(VReg.A1, kind);
            vm.call("_promise_make_resolver");
            vm.mov(reg, VReg.RET);
            vm.movImm(VReg.V1, 0);
            vm.store(VReg.SP, slot, VReg.V1);
            vm.label(okLabel);
        };

        vm.label("_promise_then2");
        vm.prologue(48, SAVED);
        vm.mov(VReg.S1, VReg.A1); // onF
        vm.mov(VReg.S4, VReg.A2); // onR
        vm.call("_js_unbox");     // A0=promise -> 裸
        vm.mov(VReg.S0, VReg.RET);
        vm.movImm(VReg.A0, 0);
        vm.call("_promise_new");
        vm.mov(VReg.S2, VReg.RET); // next(boxed)
        normalize(VReg.S1, 0, 0, "_pt2_okf"); // SP+0 = fulfill 侧 next_promise
        normalize(VReg.S4, 1, 8, "_pt2_okr"); // SP+8 = reject  侧 next_promise

        vm.load(VReg.V1, VReg.S0, 8); // state
        vm.cmpImm(VReg.V1, PROMISE_FULFILLED);
        vm.jeq("_pt2_ful");
        vm.cmpImm(VReg.V1, PROMISE_REJECTED);
        vm.jeq("_pt2_rej");
        // pending:两个 handler 分别挂两条链
        vm.movImm(VReg.A0, HANDLER_SIZE);
        vm.call("_alloc");
        vm.mov(VReg.S3, VReg.RET); // fulfill handler
        vm.store(VReg.S3, 0, VReg.S1); // onF
        vm.load(VReg.V1, VReg.SP, 0);
        vm.store(VReg.S3, 8, VReg.V1); // next
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.S3, 16, VReg.V1);
        vm.addImm(VReg.A0, VReg.S0, 24);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_promise_append_handler"); // 尾插 fulfill 链
        vm.movImm(VReg.A0, HANDLER_SIZE);
        vm.call("_alloc");
        vm.mov(VReg.S5, VReg.RET); // reject handler
        vm.store(VReg.S5, 0, VReg.S4); // onR
        vm.load(VReg.V1, VReg.SP, 8);
        vm.store(VReg.S5, 8, VReg.V1); // next
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.S5, 16, VReg.V1);
        vm.addImm(VReg.A0, VReg.S0, 32);
        vm.mov(VReg.A1, VReg.S5);
        vm.call("_promise_append_handler"); // 尾插 reject 链
        vm.mov(VReg.RET, VReg.S2);
        vm.epilogue(SAVED, 48);

        vm.label("_pt2_ful"); // 已 fulfilled → 排入 onF
        vm.mov(VReg.A0, VReg.S1);
        vm.load(VReg.A1, VReg.S0, 16);
        vm.load(VReg.A2, VReg.SP, 0);
        vm.call("_promise_enqueue_reaction");
        vm.mov(VReg.RET, VReg.S2);
        vm.epilogue(SAVED, 48);

        vm.label("_pt2_rej"); // 已 rejected → 排入 onR
        vm.mov(VReg.A0, VReg.S4);
        vm.load(VReg.A1, VReg.S0, 16);
        vm.load(VReg.A2, VReg.SP, 8);
        vm.call("_promise_enqueue_reaction");
        vm.mov(VReg.RET, VReg.S2);
        vm.epilogue(SAVED, 48);
    }

    // ==================== [test262] Promise.prototype.then 规范路径 ====================
    // 规范 27.2.5.4:C = SpeciesConstructor(this, %Promise%) → NewPromiseCapability(C)
    // → PerformPromiseThen(this, onF, onR, cap)。C 为默认(%Promise%/undefined 构造器/
    // species 缺省)时仍走原生快路 _promise_then2(零额外分配、微任务时序不变);
    // 只有自定义 C 才构造 capability 并把反应结果交给 cap.resolve/cap.reject。
    //
    // 涉及的测例族:then/ctor-*、then/capability-*、then/deferred-is-resolved-value、
    // finally/species-constructor、finally/subclass-*-count。
    generateThenSpec() {
        const vm = this.vm;
        const SAVED4 = [VReg.S0, VReg.S1, VReg.S2, VReg.S3];
        const SAVED6 = [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5];

        // ---- IsConstructor 近似(boxed 函数 / 裸闭包 / 裸 classinfo / boxed 对象内二者)
        // A0=value -> RET 0/1。_pnpc_is_callable 不认 classinfo,类值会被判成非构造器。
        vm.label("_pspc_is_ctor");
        vm.shrImm(VReg.V1, VReg.A0, 48);
        vm.cmpImm(VReg.V1, 0x7FFF);
        vm.jeq("_pspc_ic_yes");
        vm.cmpImm(VReg.V1, 0x7FFD);
        vm.jeq("_pspc_ic_obj");
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_pspc_ic_no");
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.A0, VReg.V1);
        vm.jlt("_pspc_ic_no");
        vm.load(VReg.V1, VReg.A0, 0);
        vm.movImm(VReg.V0, CLOSURE_MAGIC);
        vm.cmp(VReg.V1, VReg.V0);
        vm.jeq("_pspc_ic_yes");
        vm.loadByte(VReg.V1, VReg.A0, 0);
        vm.cmpImm(VReg.V1, 3); // classinfo type@0 = TYPE_FUNCTION
        vm.jeq("_pspc_ic_yes");
        vm.jmp("_pspc_ic_no");
        vm.label("_pspc_ic_obj");
        vm.movImm64(VReg.V1, MASK48);
        vm.and(VReg.V0, VReg.A0, VReg.V1);
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jlt("_pspc_ic_no");
        vm.loadByte(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, 3);
        vm.jeq("_pspc_ic_yes");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.movImm(VReg.V0, CLOSURE_MAGIC);
        vm.cmp(VReg.V1, VReg.V0);
        vm.jeq("_pspc_ic_yes");
        vm.label("_pspc_ic_no");
        vm.movImm(VReg.RET, 0);
        vm.ret();
        vm.label("_pspc_ic_yes");
        vm.movImm(VReg.RET, 1);
        vm.ret();

        // ---- _promise_species_ctor(A0=boxed promise) -> RET = C(0 表示默认 %Promise%)
        // 规范 7.3.22 SpeciesConstructor:constructor 只读一次(then/ctor-access-count)。
        vm.label("_promise_species_ctor");
        vm.prologue(32, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);
        this.emitStringConst(VReg.A1, "constructor");
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_maybe_getter");
        vm.mov(VReg.S1, VReg.RET); // C
        vm.shrImm(VReg.V0, VReg.S1, 48);
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jeq("_pspc_def"); // undefined → 默认
        vm.cmpImm(VReg.V0, 0x7FFA);
        vm.jeq("_pspc_badc"); // null → TypeError
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jeq("_pspc_obj");
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jeq("_pspc_obj");
        vm.cmpImm(VReg.V0, 0x7FFF);
        vm.jeq("_pspc_obj");
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_pspc_badc");
        vm.movImm64(VReg.V0, vm.ptrFloor);
        vm.cmp(VReg.S1, VReg.V0);
        vm.jlt("_pspc_badc");
        vm.label("_pspc_obj");
        vm.lea(VReg.A0, "_symwk_species");
        this.emitStringConst(VReg.A1, "Symbol.species");
        vm.call("_symbol_wellknown");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_maybe_getter");
        vm.mov(VReg.S0, VReg.RET); // S0 改作 species(this 之后不再用)
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jeq("_pspc_str");
        vm.cmpImm(VReg.V0, 0x7FFA);
        vm.jeq("_pspc_str");
        vm.jmp("_pspc_got");
        vm.label("_pspc_str");
        // 编译器把 `C[Symbol.species] = X` 归一成字符串键,符号键落空时再试一次
        this.emitStringConst(VReg.A1, "Symbol.species");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_maybe_getter");
        vm.mov(VReg.S0, VReg.RET);
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jeq("_pspc_maybe_sub");
        vm.cmpImm(VReg.V0, 0x7FFA);
        vm.jeq("_pspc_maybe_sub");
        vm.label("_pspc_got");
        vm.lea(VReg.V0, "_nsobj_promise");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmp(VReg.S0, VReg.V0);
        vm.jne("_pspc_chk"); // species 被显式改过(then/ctor-throws、ctor-custom)→ 照用
        // 本运行时把 Promise[@@species] 物化成指向 %Promise% 的数据属性,丢掉了规范里
        // 「getter 返回 this」的语义:子类继承到它时,species 应当是子类自己。
        vm.jmp("_pspc_maybe_sub");
        vm.label("_pspc_chk");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_pspc_is_ctor");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_pspc_badspec");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1], 32);

        // species 缺省但 C 继承自 %Promise%(`class X extends Promise`):规范里
        // Promise[@@species] 的 getter 返回 this,子类沿原型链拿到它 ⇒ 结果仍是 C。
        // 本运行时的 Promise 构造器对象没挂访问器,故在此按类的 __proto__ 链判定。
        vm.label("_pspc_maybe_sub");
        vm.lea(VReg.V0, "_nsobj_promise");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmp(VReg.S1, VReg.V0);
        vm.jeq("_pspc_def"); // C 就是 %Promise% 本身 → 原生快路
        vm.lea(VReg.V0, "_nsobj_promise_proto");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_pspc_def"); // Promise.prototype 未物化 ⇒ 不可能有子类
        vm.mov(VReg.A0, VReg.S1);
        this.emitStringConst(VReg.A1, "prototype");
        vm.call("_object_get");
        vm.mov(VReg.S0, VReg.RET); // C.prototype(S0 此时已不需保 this)
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.SP, 0, VReg.V0); // 步数上限(防环)
        vm.label("_pspc_walk");
        vm.movImm64(VReg.V1, MASK48);
        vm.and(VReg.V2, VReg.S0, VReg.V1);
        vm.cmpImm(VReg.V2, 0);
        vm.jeq("_pspc_def");
        vm.lea(VReg.V0, "_nsobj_promise_proto");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.and(VReg.V0, VReg.V0, VReg.V1);
        vm.cmp(VReg.V2, VReg.V0);
        vm.jeq("_pspc_sub");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_object_getPrototypeOf");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_pspc_def");
        vm.movImm64(VReg.V1, 0x7ffa000000000000n);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_pspc_def");
        vm.mov(VReg.S0, VReg.RET);
        vm.load(VReg.V0, VReg.SP, 0);
        vm.addImm(VReg.V0, VReg.V0, 1);
        vm.store(VReg.SP, 0, VReg.V0);
        vm.cmpImm(VReg.V0, 16);
        vm.jlt("_pspc_walk");
        vm.jmp("_pspc_def");
        vm.label("_pspc_sub");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1], 32);

        vm.label("_pspc_def");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 32);
        vm.label("_pspc_badc");
        this.emitStringConst(VReg.A0, "Promise constructor is not an object");
        vm.call("_throw_type_error");
        vm.label("_pspc_badspec");
        this.emitStringConst(VReg.A0, "object is not a constructor");
        vm.call("_throw_type_error");

        // ---- _pcap_make_handler(A0=userCb, A1=capResolve, A2=capReject) -> boxed fn
        // PromiseReactionJob 的 handler 包装:handler(value) 的结果交 cap.resolve,
        // 抛出交 cap.reject。闭包 48B:{magic,_aref_generic,tramp,userCb,capR,capJ}
        vm.label("_pcap_make_handler");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.S2, VReg.A2);
        vm.movImm(VReg.A0, 48);
        vm.call("_alloc");
        vm.mov(VReg.V0, VReg.RET);
        vm.movImm(VReg.V1, CLOSURE_MAGIC);
        vm.store(VReg.V0, 0, VReg.V1);
        vm.lea(VReg.V1, "_aref_generic");
        vm.store(VReg.V0, 8, VReg.V1);
        vm.lea(VReg.V1, "_pcap_handler_tramp");
        vm.store(VReg.V0, 16, VReg.V1);
        vm.store(VReg.V0, 24, VReg.S0);
        vm.store(VReg.V0, 32, VReg.S1);
        vm.store(VReg.V0, 40, VReg.S2);
        vm.mov(VReg.A0, VReg.V0);
        vm.call("_js_box_function");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);

        vm.label("_pcap_handler_tramp");
        vm.prologue(96, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S1, VReg.A1); // value
        this.emitExcPush(0, "_pcht_throw");
        vm.load(VReg.A0, VReg.S0, 24); // userCb
        vm.movImm64(VReg.A1, JS_UNDEFINED);
        vm.mov(VReg.A2, VReg.S1);
        vm.movImm64(VReg.A3, JS_UNDEFINED);
        vm.movImm(VReg.A4, 1);
        vm.call("_promise_invoke2");
        this.emitExcPop(0);
        vm.mov(VReg.S1, VReg.RET); // handlerResult
        vm.load(VReg.A0, VReg.S0, 32); // cap.resolve
        vm.movImm64(VReg.A1, JS_UNDEFINED);
        vm.mov(VReg.A2, VReg.S1);
        vm.movImm64(VReg.A3, JS_UNDEFINED);
        vm.movImm(VReg.A4, 1);
        vm.call("_promise_invoke2");
        vm.movImm64(VReg.RET, JS_UNDEFINED);
        vm.epilogue([VReg.S0, VReg.S1], 96);
        vm.label("_pcht_throw");
        this.emitExcPop(0);
        this.emitTakeException(VReg.S1);
        vm.load(VReg.A0, VReg.S0, 40); // cap.reject
        vm.movImm64(VReg.A1, JS_UNDEFINED);
        vm.mov(VReg.A2, VReg.S1);
        vm.movImm64(VReg.A3, JS_UNDEFINED);
        vm.movImm(VReg.A4, 1);
        vm.call("_promise_invoke2");
        vm.movImm64(VReg.RET, JS_UNDEFINED);
        vm.epilogue([VReg.S0, VReg.S1], 96);

        // ---- _promise_perform_then_cap(A0=boxed promise, A1=onF, A2=onR,
        //                                A3=cap.resolve, A4=cap.reject)
        // 规范 27.2.5.4.1:不可调用的 onF/onR 分别退化成 Identity/Thrower,
        // 直接把 cap.resolve/cap.reject 当 handler(与规范同 tick,无中间 promise)。
        vm.label("_promise_perform_then_cap");
        vm.prologue(64, SAVED6);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.S2, VReg.A2);
        vm.mov(VReg.S3, VReg.A3);
        vm.mov(VReg.S4, VReg.A4);
        vm.call("_js_unbox");
        vm.mov(VReg.S0, VReg.RET); // 裸 promise
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_pnpc_is_callable");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_pptc_f_id");
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S3);
        vm.mov(VReg.A2, VReg.S4);
        vm.call("_pcap_make_handler");
        vm.mov(VReg.S1, VReg.RET);
        vm.jmp("_pptc_f_done");
        vm.label("_pptc_f_id");
        vm.mov(VReg.S1, VReg.S3);
        vm.label("_pptc_f_done");
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_pnpc_is_callable");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_pptc_r_th");
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S3);
        vm.mov(VReg.A2, VReg.S4);
        vm.call("_pcap_make_handler");
        vm.mov(VReg.S2, VReg.RET);
        vm.jmp("_pptc_r_done");
        vm.label("_pptc_r_th");
        vm.mov(VReg.S2, VReg.S4);
        vm.label("_pptc_r_done");
        vm.load(VReg.V1, VReg.S0, 8);
        vm.cmpImm(VReg.V1, PROMISE_FULFILLED);
        vm.jeq("_pptc_ful");
        vm.cmpImm(VReg.V1, PROMISE_REJECTED);
        vm.jeq("_pptc_rej");
        vm.movImm(VReg.A0, HANDLER_SIZE);
        vm.call("_alloc");
        vm.mov(VReg.S5, VReg.RET);
        vm.store(VReg.S5, 0, VReg.S1);
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.S5, 8, VReg.V1); // next_promise=0:handler 自己结算 cap
        vm.store(VReg.S5, 16, VReg.V1);
        vm.addImm(VReg.A0, VReg.S0, 24);
        vm.mov(VReg.A1, VReg.S5);
        vm.call("_promise_append_handler");
        vm.movImm(VReg.A0, HANDLER_SIZE);
        vm.call("_alloc");
        vm.mov(VReg.S5, VReg.RET);
        vm.store(VReg.S5, 0, VReg.S2);
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.S5, 8, VReg.V1);
        vm.store(VReg.S5, 16, VReg.V1);
        vm.addImm(VReg.A0, VReg.S0, 32);
        vm.mov(VReg.A1, VReg.S5);
        vm.call("_promise_append_handler");
        vm.movImm64(VReg.RET, JS_UNDEFINED);
        vm.epilogue(SAVED6, 64);
        vm.label("_pptc_ful");
        vm.mov(VReg.A0, VReg.S1);
        vm.load(VReg.A1, VReg.S0, 16);
        vm.movImm(VReg.A2, 0);
        vm.call("_promise_enqueue_reaction");
        vm.movImm64(VReg.RET, JS_UNDEFINED);
        vm.epilogue(SAVED6, 64);
        vm.label("_pptc_rej");
        vm.mov(VReg.A0, VReg.S2);
        vm.load(VReg.A1, VReg.S0, 16);
        vm.movImm(VReg.A2, 0);
        vm.call("_promise_enqueue_reaction");
        vm.movImm64(VReg.RET, JS_UNDEFINED);
        vm.epilogue(SAVED6, 64);

        // ---- _promise_then_dispatch(A0=boxed 接收者, A1=onF, A2=onR)
        // `p.then(f,g)` 语法快路的入口:`then` 本是普通属性读,promise 实例上覆写过的
        // 自有 then 必须被调用(resolve/resolve-prms-cstm-then)。只查侧表自有属性:
        // 继承来的内建 then 落 _promise_then_spec,而内建实现本身**不**再做这次查找,
        // 否则 `p.then = function(){ Promise.prototype.then.apply(this, arguments) }`
        // 会自我递归到爆栈。
        vm.label("_promise_then_dispatch");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.S2, VReg.A2);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_is_promise");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_ptd_plain");
        vm.mov(VReg.A0, VReg.S0);
        this.emitStringConst(VReg.A1, "then");
        vm.call("_closure_prop_get");
        vm.mov(VReg.S3, VReg.RET);
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_pnpc_is_callable");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_ptd_plain");
        vm.mov(VReg.A0, VReg.S3);
        vm.mov(VReg.A1, VReg.S0);
        vm.mov(VReg.A2, VReg.S1);
        vm.mov(VReg.A3, VReg.S2);
        vm.movImm(VReg.A4, 2);
        vm.call("_promise_invoke2");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);
        vm.label("_ptd_plain");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_promise_then_spec");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);

        // ---- _promise_then_spec(A0=boxed this, A1=onF, A2=onR) -> boxed 结果
        vm.label("_promise_then_spec");
        vm.prologue(64, SAVED4);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.S2, VReg.A2);
        // 语法快路可能传裸 0(实参缺省)→ 归一成 undefined
        vm.cmpImm(VReg.S1, 0);
        vm.jne("_pts_f_ok");
        vm.movImm64(VReg.S1, JS_UNDEFINED);
        vm.label("_pts_f_ok");
        vm.cmpImm(VReg.S2, 0);
        vm.jne("_pts_r_ok");
        vm.movImm64(VReg.S2, JS_UNDEFINED);
        vm.label("_pts_r_ok");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_is_promise");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_pts_generic");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_promise_species_ctor"); // 可抛
        vm.mov(VReg.S3, VReg.RET);
        vm.cmpImm(VReg.S3, 0);
        vm.jeq("_pts_native");
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_promise_new_capability"); // 可抛
        vm.mov(VReg.S3, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A2, VReg.S2);
        vm.load(VReg.A3, VReg.S3, 8);
        vm.load(VReg.A4, VReg.S3, 16);
        vm.call("_promise_perform_then_cap");
        vm.load(VReg.RET, VReg.S3, 0);
        vm.epilogue(SAVED4, 64);
        vm.label("_pts_native");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_promise_then2");
        vm.epilogue(SAVED4, 64);
        vm.label("_pts_generic");
        // 非 promise 接收者:保留语法快路对 thenable 的宽容 —— Invoke(this,"then",«onF,onR»)
        vm.mov(VReg.A0, VReg.S0);
        this.emitStringConst(VReg.A1, "then");
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_maybe_getter");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.mov(VReg.A2, VReg.S1);
        vm.mov(VReg.A3, VReg.S2);
        vm.movImm(VReg.A4, 2);
        vm.call("_promise_invoke2");
        vm.epilogue(SAVED4, 64);
    }

    // _promise_catch(A0=promise, A1=cb) -> boxed next promise
    generatePromiseCatch() {
        const vm = this.vm;

        // _promise_catch_invoke(A0=this, A1=onRejected):规范 27.2.5.1 的
        // `Invoke(promise, "then", «undefined, onRejected»)`,用于非原生 promise 接收者。
        vm.label("_promise_catch_invoke");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.A0, VReg.S0);
        this.emitStringConst(VReg.A1, "then");
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_maybe_getter");
        vm.mov(VReg.S2, VReg.RET);
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_pnpc_is_callable");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_pci_notfn");
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S0);
        vm.movImm64(VReg.A2, JS_UNDEFINED);
        vm.mov(VReg.A3, VReg.S1);
        vm.movImm(VReg.A4, 2);
        vm.call("_promise_invoke2");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);
        vm.label("_pci_notfn");
        this.emitStringConst(VReg.A0, "undefined is not a function");
        vm.call("_throw_type_error");

        vm.label("_promise_catch");
        // Promise.prototype 已物化时按规范走 Invoke(this,"then",«undefined,cb»):接收者
        // 覆写过的 then 必须被尊重(catch/this-value-then-not-callable),内建 then 值会
        // 经守卫回到 _promise_then_spec。未物化(语法快路)时保留下面的品牌实现。
        vm.lea(VReg.V0, "_nsobj_promise_proto");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_promise_catch_invoke");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S1, VReg.A1);
        vm.call("_js_unbox");
        vm.mov(VReg.S0, VReg.RET);

        vm.movImm(VReg.A0, 0);
        vm.call("_promise_new");
        vm.mov(VReg.S2, VReg.RET);

        vm.movImm(VReg.A0, HANDLER_SIZE);
        vm.call("_alloc");
        vm.mov(VReg.S3, VReg.RET);
        vm.store(VReg.S3, 0, VReg.S1);
        vm.store(VReg.S3, 8, VReg.S2);
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.S3, 16, VReg.V1);

        vm.load(VReg.V1, VReg.S0, 8);
        vm.cmpImm(VReg.V1, PROMISE_REJECTED);
        vm.jeq("_pc_rej");
        vm.cmpImm(VReg.V1, PROMISE_FULFILLED);
        vm.jeq("_pc_ful");
        // pending：尾插到 catch 链(FIFO 触发顺序)
        vm.addImm(VReg.A0, VReg.S0, 32);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_promise_append_handler");
        // [test262] 兑现透传:`.catch(g)` 也要把源 promise 的 fulfil 值送给 next,
        // 否则 `.catch(g).then(h)` 在源成功时 h 永不触发(与 _promise_then 对偶)。
        vm.mov(VReg.A0, VReg.S2);
        vm.movImm(VReg.A1, 0);
        vm.call("_promise_make_resolver");
        vm.mov(VReg.S1, VReg.RET);
        vm.movImm(VReg.A0, HANDLER_SIZE);
        vm.call("_alloc");
        vm.mov(VReg.S3, VReg.RET);
        vm.store(VReg.S3, 0, VReg.S1);
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.S3, 8, VReg.V1);
        vm.store(VReg.S3, 16, VReg.V1);
        vm.addImm(VReg.A0, VReg.S0, 24);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_promise_append_handler");
        vm.mov(VReg.RET, VReg.S2);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);

        vm.label("_pc_rej");
        // [#74] 已 rejected 也排入微任务队列,不同步直调
        vm.mov(VReg.A0, VReg.S1); // callback
        vm.load(VReg.A1, VReg.S0, 16); // reason
        vm.mov(VReg.A2, VReg.S2); // next promise(boxed)
        vm.call("_promise_enqueue_reaction");
        vm.mov(VReg.RET, VReg.S2);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);

        vm.label("_pc_ful");
        // fulfilled：值经一个微任务透传给 next(同 _pt_rej,勿同步结算)
        vm.mov(VReg.A0, VReg.S2);
        vm.movImm(VReg.A1, 0);
        vm.call("_promise_make_resolver");
        vm.mov(VReg.A0, VReg.RET);
        vm.load(VReg.A1, VReg.S0, 16);
        vm.movImm(VReg.A2, 0);
        vm.call("_promise_enqueue_reaction");
        vm.mov(VReg.RET, VReg.S2);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);
    }

    // _promise_await(A0=promise) -> value
    // 已 settled:同步返回(普通 async 函数热路径)。pending:挂起等结算。
    // _promise_await_job:已 settled 也经微任务恢复(async generator 规范 Await)。
    generatePromiseAwait() {
        const vm = this.vm;

        vm.label("_promise_await");
        vm.prologue(32, [VReg.S0, VReg.S1]);
        vm.call("_js_unbox");
        vm.mov(VReg.S0, VReg.RET);

        vm.load(VReg.V1, VReg.S0, 8);
        vm.cmpImm(VReg.V1, PROMISE_FULFILLED);
        vm.jeq("_paw_ful_fast");
        vm.cmpImm(VReg.V1, PROMISE_REJECTED);
        vm.jeq("_paw_rej_fast");

        vm.lea(VReg.S1, "_scheduler_current");
        vm.load(VReg.S1, VReg.S1, 0);
        vm.store(VReg.S0, 40, VReg.S1);
        vm.call("_coroutine_yield");
        vm.load(VReg.V1, VReg.S0, 8);
        vm.cmpImm(VReg.V1, PROMISE_REJECTED);
        vm.jeq("_paw_rej_fast");

        vm.label("_paw_ful_fast");
        vm.load(VReg.RET, VReg.S0, 16);
        vm.epilogue([VReg.S0, VReg.S1], 32);

        vm.label("_paw_rej_fast");
        vm.load(VReg.S1, VReg.S0, 16);
        vm.lea(VReg.V0, "_exception_value");
        vm.store(VReg.V0, 0, VReg.S1);
        vm.lea(VReg.V0, "_exception_pending");
        vm.movImm(VReg.V1, 1);
        vm.store(VReg.V0, 0, VReg.V1);
        vm.movImm64(VReg.RET, JS_UNDEFINED);
        vm.epilogue([VReg.S0, VReg.S1], 32);

        vm.label("_promise_await_job");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2]);
        vm.call("_js_unbox");
        vm.mov(VReg.S0, VReg.RET);

        vm.lea(VReg.S1, "_scheduler_current");
        vm.load(VReg.S1, VReg.S1, 0);
        vm.store(VReg.S0, 40, VReg.S1);

        vm.load(VReg.V1, VReg.S0, 8);
        vm.cmpImm(VReg.V1, PROMISE_PENDING);
        vm.jeq("_pawj_yield");
        vm.call("_ensure_paw_resume_cb");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S1);
        vm.movImm(VReg.A2, 0);
        vm.call("_promise_enqueue_reaction");

        vm.label("_pawj_yield");
        vm.call("_coroutine_yield");
        vm.load(VReg.V1, VReg.S0, 8);
        vm.cmpImm(VReg.V1, PROMISE_REJECTED);
        vm.jeq("_pawj_rej");

        vm.load(VReg.RET, VReg.S0, 16);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);

        vm.label("_pawj_rej");
        vm.load(VReg.S1, VReg.S0, 16);
        vm.lea(VReg.V0, "_exception_value");
        vm.store(VReg.V0, 0, VReg.S1);
        vm.lea(VReg.V0, "_exception_pending");
        vm.movImm(VReg.V1, 1);
        vm.store(VReg.V0, 0, VReg.V1);
        vm.movImm64(VReg.RET, JS_UNDEFINED);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);

        vm.label("_paw_resume_tramp");
        vm.prologue(0, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);
        vm.movImm64(VReg.A1, 0x7ffb000000000000n);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_coroutine_resume");
        vm.epilogue([VReg.S0], 0);

        vm.label("_ensure_paw_resume_cb");
        vm.prologue(0, [VReg.S0]);
        vm.lea(VReg.V0, "_paw_resume_cb");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_epaw_done");
        vm.movImm(VReg.A0, 16);
        vm.call("_alloc");
        vm.mov(VReg.S0, VReg.RET);
        vm.movImm(VReg.V1, 0xc105);
        vm.store(VReg.S0, 0, VReg.V1);
        vm.lea(VReg.V1, "_paw_resume_tramp");
        vm.store(VReg.S0, 8, VReg.V1);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_js_box_function");
        vm.lea(VReg.V1, "_paw_resume_cb");
        vm.store(VReg.V1, 0, VReg.RET);
        vm.label("_epaw_done");
        vm.lea(VReg.V0, "_paw_resume_cb");
        vm.load(VReg.RET, VReg.V0, 0);
        vm.epilogue([VReg.S0], 0);
    }

    // Promise.resolve(value) -> boxed promise
    generatePromiseResolveStatic() {
        const vm = this.vm;
        vm.label("_Promise_resolve");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0); // value
        // this 值即构造器 C(`P.resolve = Promise.resolve; P.resolve(v)`,以及组合器
        // GetPromiseResolve 回调都以 C 作 this)。语法快路不设 A5,残留值可能是任意
        // 位模式,故先按 emitCombinatorPrologue 的判据归一:非构造器一律走 %Promise%。
        vm.mov(VReg.S2, VReg.A5);
        vm.lea(VReg.V0, "_nsobj_promise");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_prs_builtin");
        vm.cmp(VReg.S2, VReg.V0);
        vm.jeq("_prs_builtin");
        vm.shrImm(VReg.V1, VReg.S2, 48);
        vm.cmpImm(VReg.V1, 0x7FFF);
        vm.jeq("_prs_custom");
        vm.cmpImm(VReg.V1, 0x7FFD);
        vm.jeq("_prs_c_obj");
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_prs_builtin");
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.S2, VReg.V1);
        vm.jlt("_prs_builtin");
        vm.load(VReg.V1, VReg.S2, 0);
        vm.movImm(VReg.V0, CLOSURE_MAGIC);
        vm.cmp(VReg.V1, VReg.V0);
        vm.jeq("_prs_custom");
        vm.loadByte(VReg.V1, VReg.S2, 0);
        vm.cmpImm(VReg.V1, 3); // classinfo type@0 = TYPE_FUNCTION
        vm.jeq("_prs_custom");
        vm.jmp("_prs_builtin");
        vm.label("_prs_c_obj");
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.V0, VReg.S2, VReg.V1);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_prs_builtin");
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jlt("_prs_builtin");
        vm.loadByte(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, 3);
        vm.jeq("_prs_custom");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.movImm(VReg.V0, CLOSURE_MAGIC);
        vm.cmp(VReg.V1, VReg.V0);
        vm.jeq("_prs_custom");
        vm.jmp("_prs_builtin");

        // 自定义 C(27.2.4.7):IsPromise(x) 且 Get(x,"constructor")===C → 原样返回;
        // 否则 NewPromiseCapability(C) 后 Call(cap.resolve, undefined, «x»)。
        // cap.resolve 抛出原样传播,由调用方(组合器)转成 reject。
        vm.label("_prs_custom");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_is_promise");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_prs_cap");
        vm.mov(VReg.A0, VReg.S0);
        this.emitStringConst(VReg.A1, "constructor");
        vm.call("_object_get");
        vm.cmp(VReg.RET, VReg.S2);
        vm.jne("_prs_cap");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);
        vm.label("_prs_cap");
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_promise_new_capability");
        vm.mov(VReg.S1, VReg.RET); // cap ptr
        vm.load(VReg.A0, VReg.S1, 8); // capResolve
        vm.movImm64(VReg.A1, JS_UNDEFINED);
        vm.mov(VReg.A2, VReg.S0);
        vm.movImm64(VReg.A3, JS_UNDEFINED);
        vm.movImm(VReg.A4, 1);
        vm.call("_promise_invoke2");
        vm.load(VReg.RET, VReg.S1, 0); // cap.promise
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);
        vm.label("_prs_builtin");
        // 入参本身是 promise 时,规范 27.2.4.7 步骤 2 只在 Get(x,"constructor") === C
        // 时原样返回(resolve/arg-uniq-ctor 把 promise1.constructor 改成 null 后要求
        // 返回**新** promise)。%Promise% 未物化时无从比较,保留原样返回。
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_is_promise");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_prs_new");
        vm.lea(VReg.V0, "_nsobj_promise");
        vm.load(VReg.S2, VReg.V0, 0);
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_prs_same");
        vm.mov(VReg.A0, VReg.S0);
        this.emitStringConst(VReg.A1, "constructor");
        vm.call("_object_get");
        vm.cmp(VReg.RET, VReg.S2);
        vm.jne("_prs_new");
        vm.label("_prs_same");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);
        vm.label("_prs_new");
        vm.movImm(VReg.A0, 0);
        vm.call("_promise_new");
        vm.mov(VReg.S1, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_promise_resolve");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);
    }

    // Promise.reject(reason) -> boxed promise
    // _pss_custom_c(A0 = 静态方法收到的 this) -> RET = 自定义构造器 C,或 0 表示
    // "就是内建 %Promise%/语法快路残留值"。判据与 _Promise_resolve 的 _prs_* 块同源:
    // 装箱函数、裸闭包、裸/箱内 classinfo(type=3)算构造器,其余归一到内建快路。
    generatePssCustomC() {
        const vm = this.vm;
        vm.label("_pss_custom_c");
        vm.mov(VReg.V2, VReg.A0);
        vm.lea(VReg.V0, "_nsobj_promise");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmpImm(VReg.V2, 0);
        vm.jeq("_pscc_no");
        vm.cmp(VReg.V2, VReg.V0);
        vm.jeq("_pscc_no");
        vm.shrImm(VReg.V1, VReg.V2, 48);
        vm.cmpImm(VReg.V1, 0x7FFF);
        vm.jeq("_pscc_yes");
        vm.cmpImm(VReg.V1, 0x7FFD);
        vm.jeq("_pscc_obj");
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_pscc_no");
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.V2, VReg.V1);
        vm.jlt("_pscc_no");
        vm.load(VReg.V1, VReg.V2, 0);
        vm.movImm(VReg.V0, CLOSURE_MAGIC);
        vm.cmp(VReg.V1, VReg.V0);
        vm.jeq("_pscc_yes");
        vm.loadByte(VReg.V1, VReg.V2, 0);
        vm.cmpImm(VReg.V1, 3);
        vm.jeq("_pscc_yes");
        vm.jmp("_pscc_no");
        vm.label("_pscc_obj");
        vm.movImm64(VReg.V1, 0x0000ffffffffffffn);
        vm.and(VReg.V0, VReg.V2, VReg.V1);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_pscc_no");
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jlt("_pscc_no");
        vm.loadByte(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, 3);
        vm.jeq("_pscc_yes");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.movImm(VReg.V0, CLOSURE_MAGIC);
        vm.cmp(VReg.V1, VReg.V0);
        vm.jeq("_pscc_yes");
        vm.label("_pscc_no");
        vm.movImm(VReg.RET, 0);
        vm.ret();
        vm.label("_pscc_yes");
        vm.mov(VReg.RET, VReg.V2);
        vm.ret();
    }

    generatePromiseRejectStatic() {
        const vm = this.vm;
        vm.label("_Promise_reject");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0); // reason
        // 规范 27.2.4.6:C = this。自定义 C 走 NewPromiseCapability(C) +
        // Call(cap.reject, undefined, «r»)(reject/capability-*、ctx-ctor 族)。
        vm.mov(VReg.A0, VReg.A5);
        vm.call("_pss_custom_c");
        vm.mov(VReg.S2, VReg.RET);
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_prj_builtin");
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_promise_new_capability"); // 可抛
        vm.mov(VReg.S1, VReg.RET);
        vm.load(VReg.A0, VReg.S1, 16); // cap.reject
        vm.movImm64(VReg.A1, JS_UNDEFINED);
        vm.mov(VReg.A2, VReg.S0);
        vm.movImm64(VReg.A3, JS_UNDEFINED);
        vm.movImm(VReg.A4, 1);
        vm.call("_promise_invoke2");
        vm.load(VReg.RET, VReg.S1, 0); // cap.promise
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);

        vm.label("_prj_builtin");
        vm.movImm(VReg.A0, 0);
        vm.call("_promise_new");
        vm.mov(VReg.S1, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_promise_reject");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);
    }

    // [ES2025] Promise.try(fn, ...args) -> boxed promise
    // 规范 27.2.4.8:C = this → NewPromiseCapability(C) → Call(fn, undefined, args);
    // 正常返回走 cap.resolve、同步 throw 走 cap.reject,返回 cap.promise。
    // 实参转发到 fn(寄存器窗口 4 个,与全局 6 参 ABI 一致)。
    // 帧布局:SP+0 fn、SP+8..32 arg0..3、SP+40 argc、SP+48 cap、SP+56 fn 的 this;
    //         异常帧(80B)放 SP+80 之后,避免与上述槽重叠。
    generatePromiseTryStatic() {
        const vm = this.vm;
        const SAVED = [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5];
        const EXC = 80;
        vm.label("_Promise_try");
        vm.prologue(176, SAVED);
        vm.store(VReg.SP, 0, VReg.A0);
        vm.store(VReg.SP, 8, VReg.A1);
        vm.store(VReg.SP, 16, VReg.A2);
        vm.store(VReg.SP, 24, VReg.A3);
        vm.store(VReg.SP, 32, VReg.A4);
        vm.mov(VReg.S4, VReg.A5); // C
        vm.lea(VReg.V0, "_call_argc");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.store(VReg.SP, 40, VReg.V0);

        // fn 必须可调用(规范步骤 3 IsCallable)
        vm.load(VReg.A0, VReg.SP, 0);
        vm.call("_pnpc_is_callable");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_ptry_notfn");

        vm.mov(VReg.A0, VReg.S4);
        vm.call("_promise_new_capability"); // 可同步抛
        vm.store(VReg.SP, 48, VReg.RET);

        // fn 分派(与 _promise_invoke1 同一约定:S0=闭包指针、S2=入口)
        vm.load(VReg.A0, VReg.SP, 0);
        vm.call("_js_unbox");
        vm.mov(VReg.S2, VReg.RET);
        vm.movImm(VReg.S0, 0);
        vm.load(VReg.V1, VReg.S2, 0);
        vm.movImm(VReg.V0, CLOSURE_MAGIC);
        vm.cmp(VReg.V1, VReg.V0);
        vm.jeq("_ptry_clos");
        vm.movImm(VReg.V0, ASYNC_CLOSURE_MAGIC);
        vm.cmp(VReg.V1, VReg.V0);
        vm.jeq("_ptry_clos");
        vm.jmp("_ptry_ready");
        vm.label("_ptry_clos");
        vm.mov(VReg.S0, VReg.S2);
        vm.load(VReg.S2, VReg.S2, 8);
        vm.label("_ptry_ready");
        vm.mov(VReg.A0, VReg.S2);
        vm.movImm64(VReg.A1, JS_UNDEFINED);
        vm.call("_ordinary_bind_this");
        vm.store(VReg.SP, 56, VReg.RET);

        this.emitExcPush(EXC, "_ptry_throw");
        vm.load(VReg.V0, VReg.SP, 40);
        vm.subImm(VReg.V0, VReg.V0, 1); // fn 之后的实参数
        vm.cmpImm(VReg.V0, 0);
        vm.jge("_ptry_argc_ok");
        vm.movImm(VReg.V0, 0);
        vm.label("_ptry_argc_ok");
        vm.lea(VReg.V1, "_call_argc");
        vm.store(VReg.V1, 0, VReg.V0);
        vm.load(VReg.A0, VReg.SP, 8);
        vm.load(VReg.A1, VReg.SP, 16);
        vm.load(VReg.A2, VReg.SP, 24);
        vm.load(VReg.A3, VReg.SP, 32);
        vm.movImm64(VReg.A4, JS_UNDEFINED);
        vm.load(VReg.A5, VReg.SP, 56); // V4 别名 A5,置于 S2(入口)读取之后
        vm.callIndirect(VReg.S2);
        this.emitExcPop(EXC);
        vm.mov(VReg.S3, VReg.RET);
        vm.load(VReg.S1, VReg.SP, 48);
        vm.load(VReg.A0, VReg.S1, 8); // cap.resolve
        vm.movImm64(VReg.A1, JS_UNDEFINED);
        vm.mov(VReg.A2, VReg.S3);
        vm.movImm64(VReg.A3, JS_UNDEFINED);
        vm.movImm(VReg.A4, 1);
        vm.call("_promise_invoke2");
        vm.load(VReg.S1, VReg.SP, 48);
        vm.load(VReg.RET, VReg.S1, 0);
        vm.epilogue(SAVED, 176);

        vm.label("_ptry_throw");
        this.emitExcPop(EXC);
        this.emitTakeException(VReg.S3);
        vm.load(VReg.S1, VReg.SP, 48);
        vm.load(VReg.A0, VReg.S1, 16); // cap.reject
        vm.movImm64(VReg.A1, JS_UNDEFINED);
        vm.mov(VReg.A2, VReg.S3);
        vm.movImm64(VReg.A3, JS_UNDEFINED);
        vm.movImm(VReg.A4, 1);
        vm.call("_promise_invoke2");
        vm.load(VReg.S1, VReg.SP, 48);
        vm.load(VReg.RET, VReg.S1, 0);
        vm.epilogue(SAVED, 176);

        vm.label("_ptry_notfn");
        this.emitStringConst(VReg.A0, "Promise.try requires a callable first argument");
        vm.call("_throw_type_error");
    }

    // [ES2024] Promise.withResolvers() -> boxed { promise, resolve, reject }
    // pending promise + 两个绑定到它的 resolve/reject 一等函数(闭包布局
    // [CLOSURE_MAGIC@0, tramp@8, boxed_promise@16],复用既有 _promise_*_tramp)。
    // resolve/reject 走 #74 后的 _promise_resolve/reject,天然获得微任务延迟语义。
    generatePromiseWithResolvers() {
        const vm = this.vm;
        vm.label("_Promise_withResolvers");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);

        // 规范 27.2.4.9:C = this,经 NewPromiseCapability(C) 产出三元组
        // (withResolvers/ctx-ctor:`Promise.withResolvers.call(SubPromise)`)。
        vm.mov(VReg.A0, VReg.A5);
        vm.call("_pss_custom_c");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_pwr_builtin");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_promise_new_capability"); // 可抛
        vm.mov(VReg.S1, VReg.RET);
        vm.load(VReg.S2, VReg.S1, 0);
        vm.load(VReg.S3, VReg.S1, 8);
        vm.load(VReg.S4, VReg.S1, 16);
        vm.jmp("_pwr_pack");

        vm.label("_pwr_builtin");
        // pending promise（无 executor）-> S2(boxed)
        vm.movImm(VReg.A0, 0);
        vm.call("_promise_new");
        vm.mov(VReg.S2, VReg.RET);

        // resolve/reject 一等函数(唯一构造点 _promise_make_resolver)
        vm.mov(VReg.A0, VReg.S2);
        vm.movImm(VReg.A1, 0);
        vm.call("_promise_make_resolver");
        vm.mov(VReg.S3, VReg.RET);
        vm.mov(VReg.A0, VReg.S2);
        vm.movImm(VReg.A1, 1);
        vm.call("_promise_make_resolver");
        vm.mov(VReg.S4, VReg.RET);

        vm.label("_pwr_pack");
        // 结果对象 -> S0(boxed)
        vm.call("_object_new");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_js_box_object");
        vm.mov(VReg.S0, VReg.RET);

        vm.mov(VReg.A0, VReg.S0);
        this.emitStringConst(VReg.A1, "promise");
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_object_set");
        vm.mov(VReg.A0, VReg.S0);
        this.emitStringConst(VReg.A1, "resolve");
        vm.mov(VReg.A2, VReg.S3);
        vm.call("_object_set");
        vm.mov(VReg.A0, VReg.S0);
        this.emitStringConst(VReg.A1, "reject");
        vm.mov(VReg.A2, VReg.S4);
        vm.call("_object_set");

        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 48);
    }

    // _promise_make_settled_result(A0=value, A1=0 fulfilled / 1 rejected)
    //   -> boxed {status:"fulfilled", value} / {status:"rejected", reason}
    // [test262] 旧签名只收一个值,自己 _is_promise 快照状态 —— 那是同步 allSettled
    // 模型的残留(pending 元素被当 fulfilled、值为 0)。现在状态由订阅回调按其触发的
    // 那一条链决定,直接经 A1 传入。
    generateMakeSettledResult() {
        const vm = this.vm;
        vm.label("_promise_make_settled_result");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0); // value/reason
        vm.mov(VReg.S2, VReg.A1); // kind
        vm.call("_object_new");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_js_box_object");
        vm.mov(VReg.S1, VReg.RET); // boxed obj

        vm.cmpImm(VReg.S2, 0);
        vm.jne("_pmsr_rej");
        vm.mov(VReg.A0, VReg.S1);
        this.emitStringConst(VReg.A1, "status");
        this.emitStringConst(VReg.A2, "fulfilled");
        vm.call("_object_set");
        vm.mov(VReg.A0, VReg.S1);
        this.emitStringConst(VReg.A1, "value");
        vm.mov(VReg.A2, VReg.S0);
        vm.call("_object_set");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);

        vm.label("_pmsr_rej");
        vm.mov(VReg.A0, VReg.S1);
        this.emitStringConst(VReg.A1, "status");
        this.emitStringConst(VReg.A2, "rejected");
        vm.call("_object_set");
        vm.mov(VReg.A0, VReg.S1);
        this.emitStringConst(VReg.A1, "reason");
        vm.mov(VReg.A2, VReg.S0);
        vm.call("_object_set");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);
    }

    // ==================== [test262] NewPromiseCapability ====================
    // _promise_new_capability(A0=C) -> RET = cap 裸指针
    //   cap(48B): {promise@0, resolve@8, reject@16, unused@24, unused@32, unused@40}
    // 规范 27.2.1.5:Construct(C, «executor») 捕获 resolve/reject。
    // C===%Promise% 或 0 → 快路 _promise_new + make_resolver(不经 _fn_construct_call:
    //   Promise 构造器闭包 fnptr=_promise_ctor_call,无 new 会抛)。
    // 普通函数 C → _fn_construct_call。
    // classinfo(type=3,含 `class X extends Promise`)→ 类构造序列;super() 到 Promise
    //   是编译器 no-op,executor 常未被调用 → 回退 native promise + 补调 executor
    //   (让 Custom.resolve 订阅与 .then 链能工作;instanceof 子类仍偏差,见 members.js)。
    generateNewCapability() {
        const vm = this.vm;
        const SAVED = [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5];

        // _pnpc_is_callable(A0=value) -> RET 1/0
        vm.label("_pnpc_is_callable");
        vm.shrImm(VReg.V1, VReg.A0, 48);
        vm.cmpImm(VReg.V1, 0x7FFF);
        vm.jeq("_pnpc_ic_yes");
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_pnpc_ic_no");
        vm.cmpImm(VReg.A0, 0);
        vm.jeq("_pnpc_ic_no");
        vm.load(VReg.V1, VReg.A0, 0);
        vm.movImm(VReg.V0, CLOSURE_MAGIC);
        vm.cmp(VReg.V1, VReg.V0);
        vm.jeq("_pnpc_ic_yes");
        vm.movImm(VReg.V0, ASYNC_CLOSURE_MAGIC);
        vm.cmp(VReg.V1, VReg.V0);
        vm.jeq("_pnpc_ic_yes");
        vm.label("_pnpc_ic_no");
        vm.movImm(VReg.RET, 0);
        vm.ret();
        vm.label("_pnpc_ic_yes");
        vm.movImm(VReg.RET, 1);
        vm.ret();

        // GetCapabilitiesExecutor:经 _aref_generic 进入,A1=resolve, A2=reject, S0=闭包
        // cap 在 S0+24。已设置过则抛 TypeError。argc 不足的实参当 undefined。
        vm.label("_pnpc_exec");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.load(VReg.S1, VReg.S0, 24); // cap
        vm.lea(VReg.V0, "_call_argc");
        vm.load(VReg.S3, VReg.V0, 0); // 用户 argc(aref 不改)
        vm.movImm64(VReg.S2, JS_UNDEFINED);
        vm.cmpImm(VReg.S3, 1);
        vm.jlt("_pnpc_exec_args");
        vm.mov(VReg.S2, VReg.A1); // resolve
        vm.label("_pnpc_exec_args");
        vm.movImm64(VReg.S3, JS_UNDEFINED);
        vm.lea(VReg.V0, "_call_argc");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, 2);
        vm.jlt("_pnpc_exec_chk");
        vm.mov(VReg.S3, VReg.A2); // reject
        vm.label("_pnpc_exec_chk");
        vm.load(VReg.V1, VReg.S1, 8); // cap.resolve
        vm.movImm64(VReg.V0, JS_UNDEFINED);
        vm.cmp(VReg.V1, VReg.V0);
        vm.jne("_pnpc_exec_twice");
        vm.load(VReg.V1, VReg.S1, 16);
        vm.cmp(VReg.V1, VReg.V0);
        vm.jne("_pnpc_exec_twice");
        vm.store(VReg.S1, 8, VReg.S2);
        vm.store(VReg.S1, 16, VReg.S3);
        vm.movImm64(VReg.RET, JS_UNDEFINED);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);
        vm.label("_pnpc_exec_twice");
        this.emitStringConst(VReg.A0, "Promise executor already called with resolve/reject");
        vm.call("_throw_type_error");

        vm.label("_promise_new_capability");
        vm.prologue(64, SAVED);
        vm.mov(VReg.S0, VReg.A0); // C
        vm.lea(VReg.V0, "_nsobj_promise");
        vm.load(VReg.S1, VReg.V0, 0); // %Promise%
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_pnpc_fast");
        vm.cmp(VReg.S0, VReg.S1);
        vm.jeq("_pnpc_fast");

        // 慢路:alloc cap,造 executor,Construct(C, «executor»)
        vm.movImm(VReg.A0, 48);
        vm.call("_alloc");
        vm.mov(VReg.S2, VReg.RET); // cap
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.S2, 0, VReg.V1);
        vm.movImm64(VReg.V1, JS_UNDEFINED);
        vm.store(VReg.S2, 8, VReg.V1);
        vm.store(VReg.S2, 16, VReg.V1);
        vm.movImm(VReg.A0, 32);
        vm.call("_alloc");
        vm.mov(VReg.S3, VReg.RET); // executor 闭包
        vm.movImm(VReg.V1, CLOSURE_MAGIC);
        vm.store(VReg.S3, 0, VReg.V1);
        vm.lea(VReg.V1, "_aref_generic");
        vm.store(VReg.S3, 8, VReg.V1);
        vm.lea(VReg.V1, "_pnpc_exec");
        vm.store(VReg.S3, 16, VReg.V1);
        vm.store(VReg.S3, 24, VReg.S2);
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_js_box_function");
        vm.store(VReg.S2, 24, VReg.RET); // cap[24] = boxed executor(跨 Construct 保活)
        vm.mov(VReg.S4, VReg.RET);
        // args = [executor]
        vm.movImm(VReg.A0, 1);
        vm.call("_array_new_with_size");
        vm.movImm64(VReg.V1, MASK48);
        vm.and(VReg.V0, VReg.RET, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffe000000000000n);
        vm.or(VReg.S5, VReg.V0, VReg.V1);
        vm.mov(VReg.A0, VReg.S5);
        vm.movImm(VReg.A1, 0);
        vm.mov(VReg.A2, VReg.S4);
        vm.call("_array_set");
        // Construct:闭包 → _fn_construct_call;classinfo → 类构造
        vm.shrImm(VReg.V1, VReg.S0, 48);
        vm.cmpImm(VReg.V1, 0x7FFF);
        vm.jeq("_pnpc_fn");
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_pnpc_raw");
        vm.cmpImm(VReg.V1, 0x7FFD);
        vm.jeq("_pnpc_obj");
        this.emitStringConst(VReg.A0, "Promise resolve or reject function is not callable");
        vm.call("_throw_type_error");

        vm.label("_pnpc_raw");
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_pnpc_notctor");
        vm.load(VReg.V1, VReg.S0, 0);
        vm.movImm(VReg.V0, CLOSURE_MAGIC);
        vm.cmp(VReg.V1, VReg.V0);
        vm.jeq("_pnpc_fn");
        vm.loadByte(VReg.V1, VReg.S0, 0);
        vm.cmpImm(VReg.V1, 3); // TYPE_FUNCTION classinfo
        vm.jeq("_pnpc_fn"); // 与 new C(ex) 同路 _fn_construct_call;旧 _pnpc_class 未调 ctor
        vm.jmp("_pnpc_notctor");

        vm.label("_pnpc_obj");
        vm.movImm64(VReg.V1, MASK48);
        vm.and(VReg.V0, VReg.S0, VReg.V1);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_pnpc_notctor");
        vm.loadByte(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, 3);
        vm.jeq("_pnpc_fn");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.movImm(VReg.V2, CLOSURE_MAGIC);
        vm.cmp(VReg.V1, VReg.V2);
        vm.jeq("_pnpc_fn");
        vm.jmp("_pnpc_notctor");

        vm.label("_pnpc_fn");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S5);
        vm.movImm(VReg.A2, 0);
        vm.call("_fn_construct_call");
        vm.store(VReg.S2, 0, VReg.RET);
        vm.jmp("_pnpc_after_ctor");

        vm.label("_pnpc_class");
        // 镜像 _pcc_forward:object_new、__proto__=C.prototype、A0=this A1=executor
        vm.movImm64(VReg.V1, MASK48);
        vm.and(VReg.S3, VReg.S0, VReg.V1); // raw classinfo
        vm.mov(VReg.S1, VReg.S3); // 构造器序言:S1=classinfo(捕获盒@48)
        vm.call("_object_new");
        vm.mov(VReg.S4, VReg.RET); // 裸实例
        vm.load(VReg.V1, VReg.S3, 32); // props_ptr
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_pnpc_class_noproto");
        vm.load(VReg.V0, VReg.V1, 24); // prototype
        vm.store(VReg.S4, 16, VReg.V0);
        vm.load(VReg.S3, VReg.V1, 8); // ctor 地址
        vm.jmp("_pnpc_class_call");
        vm.label("_pnpc_class_noproto");
        vm.movImm(VReg.S3, 0);
        vm.label("_pnpc_class_call");
        vm.cmpImm(VReg.S3, 0);
        vm.jeq("_pnpc_class_box");
        vm.load(VReg.A1, VReg.S2, 24); // boxed executor
        vm.movImm64(VReg.V1, MASK48);
        vm.and(VReg.V0, VReg.S4, VReg.V1);
        vm.movImm64(VReg.V1, TAG_OBJECT);
        vm.or(VReg.A0, VReg.V0, VReg.V1); // this = 装箱实例(类构造约定 A0)
        vm.setCallArgcImm(1, VReg.V1, VReg.V2);
        vm.callIndirect(VReg.S3);
        // 规范 [[Construct]] 步骤 13:构造器显式 return 一个对象时,该对象即构造结果
        // (then/deferred-is-resolved-value、then/capability-executor-called-twice 里
        // `class extends Promise { constructor(){ …; return {} } }`)。
        vm.shrImm(VReg.V1, VReg.RET, 48);
        vm.cmpImm(VReg.V1, 0x7FFD);
        vm.jeq("_pnpc_class_ret");
        vm.cmpImm(VReg.V1, 0x7FFE);
        vm.jeq("_pnpc_class_ret");
        vm.cmpImm(VReg.V1, 0x7FFF);
        vm.jeq("_pnpc_class_ret");
        vm.jmp("_pnpc_class_box");
        vm.label("_pnpc_class_ret");
        vm.store(VReg.S2, 0, VReg.RET);
        vm.jmp("_pnpc_after_ctor");
        vm.label("_pnpc_class_box");
        vm.movImm64(VReg.V1, MASK48);
        vm.and(VReg.V0, VReg.S4, VReg.V1);
        vm.movImm64(VReg.V1, TAG_OBJECT);
        vm.or(VReg.RET, VReg.V0, VReg.V1);
        vm.store(VReg.S2, 0, VReg.RET);

        vm.label("_pnpc_after_ctor");
        vm.load(VReg.A0, VReg.S2, 8);
        vm.call("_pnpc_is_callable");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_pnpc_chk_rej");
        // resolve 未捕获:class extends Promise 的 super no-op → 补调 executor + native backing
        // [ctx-ctor] Promise.all.call(SubPromise,…) 传入的 C 是 0x7FFF 函数标签的类构造器
        // (非裸 classinfo / 0x7FFD 对象)。旧判据只放行 0x7FFD 与 type@0=3 裸指针 →
        // 落 _pnpc_notcallable「Promise resolve or reject function is not callable」。
        vm.shrImm(VReg.V1, VReg.S0, 48);
        vm.cmpImm(VReg.V1, 0x7FFD);
        vm.jeq("_pnpc_fallback");
        vm.cmpImm(VReg.V1, 0x7FFF); // 类/函数构造器形态
        vm.jeq("_pnpc_fallback");
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_pnpc_notcallable");
        vm.loadByte(VReg.V1, VReg.S0, 0);
        vm.cmpImm(VReg.V1, 3);
        vm.jeq("_pnpc_fallback");
        vm.jmp("_pnpc_notcallable");

        vm.label("_pnpc_fallback");
        // extends Promise 且 super() 未捕获 resolve:保留 Construct 已写入的实例
        // (ctx-ctor 的 instance.constructor / instanceof 子类),resolvers 绑到
        // 该实例(若已是 TYPE_PROMISE)或新建 native backing。
        vm.load(VReg.S1, VReg.S2, 0);
        vm.cmpImm(VReg.S1, 0);
        vm.jne("_pnpc_fb_have");
        vm.movImm(VReg.A0, 0);
        vm.call("_promise_new");
        vm.store(VReg.S2, 0, VReg.RET);
        vm.mov(VReg.S1, VReg.RET);
        vm.jmp("_pnpc_fb_res");
        vm.label("_pnpc_fb_have");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_is_promise");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_pnpc_fb_res");
        // Construct 产出子类实例但 super(ex) 未把 resolve/reject 写入 cap(常见:
        // __this 为裸指针、super 路径未调 _promise_super_init)。用 cap 里保存的
        // executor 补一次原地 Promise 化 + executor(resolve,reject)。
        vm.load(VReg.A1, VReg.S2, 24);
        vm.cmpImm(VReg.A1, 0);
        vm.jeq("_pnpc_notcallable");
        vm.call("_promise_super_init");
        vm.store(VReg.S2, 0, VReg.RET);
        vm.load(VReg.A0, VReg.S2, 8);
        vm.call("_pnpc_is_callable");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_pnpc_chk_rej");
        vm.jmp("_pnpc_notcallable");
        vm.label("_pnpc_fb_res");
        vm.mov(VReg.A0, VReg.S1);
        vm.movImm(VReg.A1, 0);
        vm.call("_promise_make_resolver");
        vm.store(VReg.S2, 8, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.movImm(VReg.A1, 1);
        vm.call("_promise_make_resolver");
        vm.store(VReg.S2, 16, VReg.RET);
        vm.jmp("_pnpc_done");

        vm.label("_pnpc_chk_rej");
        vm.load(VReg.A0, VReg.S2, 16);
        vm.call("_pnpc_is_callable");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_pnpc_notcallable");
        vm.jmp("_pnpc_done");

        vm.label("_pnpc_notctor");
        this.emitStringConst(VReg.A0, "object is not a constructor");
        vm.call("_throw_type_error");
        vm.label("_pnpc_notcallable");
        this.emitStringConst(VReg.A0, "Promise resolve or reject function is not callable");
        vm.call("_throw_type_error");

        vm.label("_pnpc_fast");
        vm.movImm(VReg.A0, 48);
        vm.call("_alloc");
        vm.mov(VReg.S2, VReg.RET);
        vm.movImm(VReg.A0, 0);
        vm.call("_promise_new");
        vm.store(VReg.S2, 0, VReg.RET);
        vm.mov(VReg.S1, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.movImm(VReg.A1, 0);
        vm.call("_promise_make_resolver");
        vm.store(VReg.S2, 8, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.movImm(VReg.A1, 1);
        vm.call("_promise_make_resolver");
        vm.store(VReg.S2, 16, VReg.RET);

        vm.label("_pnpc_done");
        vm.mov(VReg.RET, VReg.S2);
        vm.epilogue(SAVED, 64);
    }

    // ==================== [test262] 组合器的异步元素订阅 ====================
    // all/race/any/allSettled 此前是"同步 settled 快照"模型:遍历数组、直接读每个
    // 元素 promise 的 status/value 定案。凡输入含 pending promise(test262 里绝大多数
    // 用例都是先建 pending、稍后 resolve),结果就错到根上 —— all 回填裸 0、race 永远
    // 不结算、allSettled 把 pending 记成 fulfilled。
    //
    // 新模型按规范逐元素订阅:p = Call(C.resolve, C, «e»); Invoke(p, "then", …)。
    // 四个组合器共享一份状态记录与一个元素回调蹦床,靠 mode/kind 分派:
    //   state(48B): {boxed 结果 promise@0, boxed 结果数组@8, remaining@16, mode@24,
    //                capResolve@32, capReject@40}
    //     mode 0=all、1=allSettled、2=any
    //   elem 闭包(56B): {CLOSURE_MAGIC@0, _aref_generic@8, tramp@16, state@24,
    //                    index@32, kind@40, already@48}
    // remaining 初值 n+1(规范 remainingElementsCount):循环结束再减 1。
    generateCombinatorElem() {
        const vm = this.vm;

        // _pcomb_make_elem(A0=state 裸指针, A1=index, A2=kind) -> RET boxed 一等函数
        vm.label("_pcomb_make_elem");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S1, VReg.A0);
        vm.mov(VReg.S2, VReg.A1);
        vm.mov(VReg.S3, VReg.A2);
        vm.movImm(VReg.A0, 56);
        vm.call("_alloc");
        vm.mov(VReg.S0, VReg.RET);
        vm.movImm(VReg.V1, CLOSURE_MAGIC);
        vm.store(VReg.S0, 0, VReg.V1);
        vm.lea(VReg.V1, "_aref_generic");
        vm.store(VReg.S0, 8, VReg.V1);
        vm.lea(VReg.V1, "_pcomb_elem_tramp");
        vm.store(VReg.S0, 16, VReg.V1);
        vm.store(VReg.S0, 24, VReg.S1);
        vm.store(VReg.S0, 32, VReg.S2);
        vm.store(VReg.S0, 40, VReg.S3);
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.S0, 48, VReg.V1); // alreadyCalled
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_js_box_function");
        // [element-fn reflection] 规范:allSettled/any 的 resolve/reject 元素函数
        // name=""、length=1 且为 own 属性。_closure_prop_define 直落侧表(绕过
        // _closure_prop_set 的元数据守卫)。name 为空串、length=canonical 1。
        vm.mov(VReg.S3, VReg.RET);          // S3 = 装箱元素函数(原 S3=kind,已用毕)
        vm.mov(VReg.A0, VReg.S3);
        vm.lea(VReg.A1, vm.asm.addString("name"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.lea(VReg.A2, vm.asm.addString(""));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A2, VReg.A2, VReg.V1);
        vm.call("_closure_prop_define");
        vm.mov(VReg.A0, VReg.S3);
        vm.lea(VReg.A1, vm.asm.addString("length"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.movImm(VReg.A2, 1);
        vm.scvtf(0, VReg.A2);
        vm.fmovToInt(VReg.A2, 0);
        vm.call("_closure_prop_define");
        vm.mov(VReg.RET, VReg.S3);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);

        // 元素回调蹦床:S0 = elem 闭包裸指针。经 _aref_generic 进入:
        // A0=this(undefined), A1=结算值(invoke1 把 value 放 A0 再由 aref 右移)。
        vm.label("_pcomb_elem_tramp");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        vm.load(VReg.V1, VReg.S0, 48); // alreadyCalled
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_pce_first");
        vm.movImm64(VReg.RET, JS_UNDEFINED);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 48);
        vm.label("_pce_first");
        vm.movImm(VReg.V1, 1);
        vm.store(VReg.S0, 48, VReg.V1);
        vm.mov(VReg.S1, VReg.A1);     // value
        vm.load(VReg.S2, VReg.S0, 24); // state
        vm.load(VReg.S3, VReg.S0, 32); // index
        vm.load(VReg.S4, VReg.S0, 40); // kind
        vm.load(VReg.V1, VReg.S2, 24); // mode
        vm.cmpImm(VReg.V1, 1);
        vm.jeq("_pce_settled");
        // mode 0(all 的 fulfil)/ mode 2(any 的 reject):值原样落位
        vm.load(VReg.A0, VReg.S2, 8);
        vm.mov(VReg.A1, VReg.S3);
        vm.mov(VReg.A2, VReg.S1);
        vm.call("_array_set");
        vm.jmp("_pce_dec");

        vm.label("_pce_settled"); // allSettled:落 {status,value|reason}
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_promise_make_settled_result");
        vm.mov(VReg.S1, VReg.RET);
        vm.load(VReg.A0, VReg.S2, 8);
        vm.mov(VReg.A1, VReg.S3);
        vm.mov(VReg.A2, VReg.S1);
        vm.call("_array_set");

        vm.label("_pce_dec");
        vm.load(VReg.V1, VReg.S2, 16);
        vm.subImm(VReg.V1, VReg.V1, 1);
        vm.store(VReg.S2, 16, VReg.V1);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_pce_ret");
        vm.jmp("_pcomb_finish"); // remaining 归零 -> 定案(A0 传 state)

        vm.label("_pce_ret");
        vm.movImm64(VReg.RET, JS_UNDEFINED);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 48);

        // _pcomb_finish:remaining 归零后的定案。S2 = state(蹦床帧内),或经
        // _pcomb_release(A0=state) 从组合器主体进入。经 cap.resolve/reject 结算
        // (自定义 C 的 result 可能不是 native Promise)。
        vm.label("_pcomb_finish");
        vm.load(VReg.V1, VReg.S2, 24);
        vm.cmpImm(VReg.V1, 2);
        vm.jeq("_pce_fin_any");
        this.emitExcPush(0, "_pce_fin_throw");
        vm.load(VReg.A0, VReg.S2, 32); // capResolve
        vm.movImm64(VReg.A1, JS_UNDEFINED); // this
        vm.load(VReg.A2, VReg.S2, 8); // values
        vm.movImm64(VReg.A3, JS_UNDEFINED);
        vm.movImm(VReg.A4, 1);
        vm.call("_promise_invoke2");
        this.emitExcPop(0);
        vm.jmp("_pce_ret");
        vm.label("_pce_fin_throw");
        this.emitExcPop(0);
        this.emitTakeException(VReg.S1);
        vm.load(VReg.A0, VReg.S2, 40); // capReject
        vm.movImm64(VReg.A1, JS_UNDEFINED);
        vm.mov(VReg.A2, VReg.S1);
        vm.movImm64(VReg.A3, JS_UNDEFINED);
        vm.movImm(VReg.A4, 1);
        vm.call("_promise_invoke2");
        vm.jmp("_pce_ret");
        vm.label("_pce_fin_any"); // any 全 reject -> AggregateError(errors)
        vm.load(VReg.A0, VReg.S2, 8);
        vm.call("_promise_make_aggregate_error");
        vm.mov(VReg.S1, VReg.RET);
        vm.load(VReg.A0, VReg.S2, 40); // capReject
        vm.movImm64(VReg.A1, JS_UNDEFINED);
        vm.mov(VReg.A2, VReg.S1);
        vm.movImm64(VReg.A3, JS_UNDEFINED);
        vm.movImm(VReg.A4, 1);
        vm.call("_promise_invoke2");
        vm.jmp("_pce_ret");

        // _pcomb_release(A0 = state 裸指针):组合器主体挂完全部订阅后调用一次,
        // 抵消 remaining 的 +1 初值;归零则就地定案。复用上面的定案分支。
        vm.label("_pcomb_release");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        vm.mov(VReg.S2, VReg.A0);
        vm.load(VReg.V1, VReg.S2, 16);
        vm.subImm(VReg.V1, VReg.V1, 1);
        vm.store(VReg.S2, 16, VReg.V1);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_pce_ret");
        vm.jmp("_pcomb_finish");

        // _pcomb_make_safe_resolve(A0=capResolve, A1=capReject) -> RET boxed fn
        // Promise.any 用:capResolve 抛错时立刻以同 reason 调 capReject，避免结果 promise 悬挂。
        vm.label("_pcomb_make_safe_resolve");
        vm.prologue(32, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.movImm(VReg.A0, 40);
        vm.call("_alloc");
        vm.mov(VReg.V0, VReg.RET);
        vm.movImm(VReg.V1, CLOSURE_MAGIC);
        vm.store(VReg.V0, 0, VReg.V1);
        vm.lea(VReg.V1, "_aref_generic");
        vm.store(VReg.V0, 8, VReg.V1);
        vm.lea(VReg.V1, "_pcomb_safe_resolve_tramp");
        vm.store(VReg.V0, 16, VReg.V1);
        vm.store(VReg.V0, 24, VReg.S0);
        vm.store(VReg.V0, 32, VReg.S1);
        vm.mov(VReg.A0, VReg.V0);
        vm.call("_js_box_function");
        vm.mov(VReg.S0, VReg.RET);
        // 该包装对外仍是 resultCapability.[[Resolve]],须与规范一致:name=""、length=1
        // (built-ins/Promise/any/invoke-then 读 then 收到的 resolver.length)。
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("name"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.lea(VReg.A2, vm.asm.addString(""));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A2, VReg.A2, VReg.V1);
        vm.call("_closure_prop_define");
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("length"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.movImm(VReg.A2, 1);
        vm.scvtf(0, VReg.A2);
        vm.fmovToInt(VReg.A2, 0);
        vm.call("_closure_prop_define");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1], 32);

        vm.label("_pcomb_safe_resolve_tramp");
        vm.prologue(96, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S1, VReg.A1); // value
        this.emitExcPush(0, "_pcsr_throw");
        vm.load(VReg.A0, VReg.S0, 24); // capResolve
        vm.movImm64(VReg.A1, JS_UNDEFINED);
        vm.mov(VReg.A2, VReg.S1);
        vm.movImm64(VReg.A3, JS_UNDEFINED);
        vm.movImm(VReg.A4, 1);
        vm.call("_promise_invoke2");
        this.emitExcPop(0);
        vm.movImm64(VReg.RET, JS_UNDEFINED);
        vm.epilogue([VReg.S0, VReg.S1], 96);
        vm.label("_pcsr_throw");
        this.emitExcPop(0);
        this.emitTakeException(VReg.S1);
        vm.load(VReg.A0, VReg.S0, 32); // capReject
        vm.movImm64(VReg.A1, JS_UNDEFINED);
        vm.mov(VReg.A2, VReg.S1);
        vm.movImm64(VReg.A3, JS_UNDEFINED);
        vm.movImm(VReg.A4, 1);
        vm.call("_promise_invoke2");
        vm.movImm64(VReg.RET, JS_UNDEFINED);
        vm.epilogue([VReg.S0, VReg.S1], 96);
    }

    // _promise_append_handler(A0 = 链头槽地址, A1 = handler 节点)
    // [test262] handler 链此前是头插,结算时从头遍历 → 同一 promise 上多个 .then 的
    // 回调按**注册的逆序**触发(resolved-sequence 之类的顺序用例全错)。改为尾插:
    // 链短(通常 1-2 节点),遍历成本可忽略,换来 FIFO 触发顺序。
    generateAppendHandler() {
        const vm = this.vm;
        vm.label("_promise_append_handler");
        vm.prologue(0, []);
        vm.load(VReg.V1, VReg.A0, 0);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_pah_sethead");
        vm.label("_pah_walk");
        vm.load(VReg.V2, VReg.V1, 16);
        vm.cmpImm(VReg.V2, 0);
        vm.jeq("_pah_tail");
        vm.mov(VReg.V1, VReg.V2);
        vm.jmp("_pah_walk");
        vm.label("_pah_tail");
        vm.store(VReg.V1, 16, VReg.A1);
        vm.epilogue([], 0);
        vm.label("_pah_sethead");
        vm.store(VReg.A0, 0, VReg.A1);
        vm.epilogue([], 0);
    }

    // _promise_make_aggregate_error(A0 = boxed errors 数组) -> RET boxed 错误对象
    // {name:"AggregateError", message, errors, __asmjs_err:true}(与编译器 new Error
    // 同构,故 e instanceof Error / e.name / e.errors 成立)。
    generateAggregateError() {
        const vm = this.vm;
        vm.asm.registerRuntimeString("_str_agg_name", "AggregateError");
        vm.asm.registerRuntimeString("_str_agg_msg", "All promises were rejected");
        vm.asm.registerRuntimeString("_str_k_name", "name");
        vm.asm.registerRuntimeString("_str_k_message", "message");
        vm.asm.registerRuntimeString("_str_k_errors", "errors");
        vm.asm.registerRuntimeString("_str_k_asmjserr", "__asmjs_err");
        vm.label("_promise_make_aggregate_error");
        vm.prologue(32, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S1, VReg.A0); // boxed errors 数组
        vm.call("_object_new");
        vm.movImm64(VReg.V1, MASK48);
        vm.and(VReg.V0, VReg.RET, VReg.V1);
        vm.movImm64(VReg.V1, TAG_OBJECT);
        vm.or(VReg.S0, VReg.V0, VReg.V1);
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, "_str_k_name");
        vm.lea(VReg.V0, "_str_agg_name");
        vm.movImm64(VReg.V1, TAG_STRING);
        vm.or(VReg.A2, VReg.V0, VReg.V1);
        vm.call("_object_define");
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, "_str_k_message");
        vm.lea(VReg.V0, "_str_agg_msg");
        vm.movImm64(VReg.V1, TAG_STRING);
        vm.or(VReg.A2, VReg.V0, VReg.V1);
        vm.call("_object_define");
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, "_str_k_errors");
        vm.mov(VReg.A2, VReg.S1);
        vm.call("_object_define");
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, "_str_k_asmjserr");
        vm.movImm64(VReg.A2, 0x7ff9000000000001n);
        vm.call("_object_define");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_promise_attach_agg_proto");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1], 32);

        // _promise_attach_agg_proto(A0=errObj) -> RET=同一对象,挂 AggregateError.prototype
        vm.label("_promise_attach_agg_proto");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0);
        vm.lea(VReg.V0, "_errctorref_AggregateError");
        vm.load(VReg.S1, VReg.V0, 0);
        vm.cmpImm(VReg.S1, 0);
        vm.jne("_paap_have");
        vm.movImm(VReg.A0, 16);
        vm.call("_alloc");
        vm.mov(VReg.S2, VReg.RET);
        vm.movImm(VReg.V1, CLOSURE_MAGIC);
        vm.store(VReg.S2, 0, VReg.V1);
        vm.lea(VReg.V1, "_object_new");
        vm.store(VReg.S2, 8, VReg.V1);
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_js_box_function");
        vm.mov(VReg.S1, VReg.RET);
        vm.lea(VReg.V0, "_errctorref_AggregateError");
        vm.store(VReg.V0, 0, VReg.S1);
        vm.mov(VReg.A0, VReg.S1);
        this.emitStringConst(VReg.A1, "name");
        this.emitStringConst(VReg.A2, "AggregateError");
        vm.call("_closure_prop_set");
        vm.call("_object_new");
        vm.call("_box_obj_r");
        vm.mov(VReg.S2, VReg.RET);
        vm.mov(VReg.A0, VReg.S2);
        this.emitStringConst(VReg.A1, "constructor");
        vm.mov(VReg.A2, VReg.S1);
        vm.call("_object_set");
        vm.mov(VReg.A0, VReg.S1);
        this.emitStringConst(VReg.A1, "prototype");
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_closure_prop_set");
        vm.label("_paap_have");
        vm.mov(VReg.A0, VReg.S1);
        this.emitStringConst(VReg.A1, "prototype");
        vm.call("_closure_prop_get");
        vm.shrImm(VReg.V1, VReg.RET, 48);
        vm.cmpImm(VReg.V1, 0x7FFD);
        vm.jeq("_paap_set");
        vm.call("_object_new");
        vm.call("_box_obj_r");
        vm.mov(VReg.S2, VReg.RET);
        vm.mov(VReg.A0, VReg.S2);
        this.emitStringConst(VReg.A1, "constructor");
        vm.mov(VReg.A2, VReg.S1);
        vm.call("_object_set");
        vm.mov(VReg.A0, VReg.S1);
        this.emitStringConst(VReg.A1, "prototype");
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_closure_prop_set");
        vm.mov(VReg.RET, VReg.S2);
        vm.label("_paap_set");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_object_setPrototypeOf");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);
    }

    // 组合器公共序幕(S0=iterable 已就位,A5=this/C):
    //   NewPromiseCapability(C) → S1=promise, S4=state(48B);
    //   GetPromiseResolve(C) → SP+88(0=直调 _Promise_resolve);
    //   GetIterator 物化 → S0; n → S2。
    // NPC 失败同步抛(不进 catch)。GetPromiseResolve/GetIterator 抛 → catchLabel 拒绝。
    // 调用方 prologue ≥160(SP+0..79 = 异常帧;80=C,88=resolveFn)。
    emitCombinatorPrologue(mode, matCatchLabel) {
        const vm = this.vm;
        // 候选 C = A5;语法快路 A5 不可靠,非构造器形态回退 %Promise%。
        vm.mov(VReg.S5, VReg.A5);
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.SP, 144, VReg.V1); // 默认数组路径(GetIterator 失败时 catch 不 close)
        vm.lea(VReg.V0, "_nsobj_promise");
        vm.load(VReg.S1, VReg.V0, 0);
        vm.cmpImm(VReg.S5, 0);
        vm.jeq("_pcomb_c_def_" + mode);
        vm.cmp(VReg.S5, VReg.S1);
        vm.jeq("_pcomb_c_def_" + mode);
        vm.shrImm(VReg.V1, VReg.S5, 48);
        vm.cmpImm(VReg.V1, 0x7FFF);
        vm.jeq("_pcomb_c_use_" + mode);
        vm.cmpImm(VReg.V1, 0x7FFD);
        vm.jeq("_pcomb_c_obj_" + mode);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_pcomb_c_def_" + mode);
        vm.cmpImm(VReg.S5, 0);
        vm.jeq("_pcomb_c_def_" + mode);
        // 语法快路 A5 常是调用点残留(defineProperty 后常见 0x1000 小整数)。
        // 低于 ptrFloor 必非合法堆/TEXT 指针,回退 %Promise%,禁止 load magic。
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.S5, VReg.V1);
        vm.jlt("_pcomb_c_def_" + mode);
        vm.load(VReg.V1, VReg.S5, 0);
        vm.movImm(VReg.V0, CLOSURE_MAGIC);
        vm.cmp(VReg.V1, VReg.V0);
        vm.jeq("_pcomb_c_use_" + mode);
        vm.loadByte(VReg.V1, VReg.S5, 0);
        vm.cmpImm(VReg.V1, 3);
        vm.jeq("_pcomb_c_use_" + mode);
        vm.jmp("_pcomb_c_def_" + mode);
        vm.label("_pcomb_c_obj_" + mode);
        vm.movImm64(VReg.V1, MASK48);
        vm.and(VReg.V0, VReg.S5, VReg.V1);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_pcomb_c_def_" + mode);
        vm.movImm64(VReg.V1, vm.ptrFloor);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jlt("_pcomb_c_def_" + mode);
        vm.loadByte(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, 3);
        vm.jeq("_pcomb_c_use_" + mode);
        vm.load(VReg.V1, VReg.V0, 0);
        vm.movImm(VReg.V2, CLOSURE_MAGIC);
        vm.cmp(VReg.V1, VReg.V2);
        vm.jeq("_pcomb_c_use_" + mode);
        vm.label("_pcomb_c_def_" + mode);
        vm.mov(VReg.S5, VReg.S1); // %Promise%(可能 0)
        vm.label("_pcomb_c_use_" + mode);
        vm.store(VReg.SP, 80, VReg.S5); // C

        vm.mov(VReg.A0, VReg.S5);
        vm.call("_promise_new_capability"); // 可同步抛
        vm.mov(VReg.S3, VReg.RET); // cap(暂,稍后 S4=state)
        vm.load(VReg.S1, VReg.S3, 0); // result promise
        vm.load(VReg.V1, VReg.S3, 8);
        vm.store(VReg.SP, 120, VReg.V1); // capResolve 暂存
        vm.load(VReg.V1, VReg.S3, 16);
        vm.store(VReg.SP, 128, VReg.V1); // capReject 暂存
        vm.store(VReg.SP, 136, VReg.S3); // cap ptr

        this.emitExcPush(0, matCatchLabel);
        vm.load(VReg.V1, VReg.SP, 80);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_pcomb_res_direct_" + mode);
        vm.mov(VReg.A0, VReg.V1);
        this.emitStringConst(VReg.A1, "resolve");
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.load(VReg.A1, VReg.SP, 80);
        vm.call("_maybe_getter");
        vm.store(VReg.SP, 88, VReg.RET); // 先存,避免 is_callable 毁 RET;getter 只触发一次
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_pnpc_is_callable");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_pcomb_resok_" + mode);
        this.emitStringConst(VReg.A0, "Promise resolve function is not callable");
        vm.call("_throw_type_error");
        vm.label("_pcomb_res_direct_" + mode);
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.SP, 88, VReg.V1);
        vm.jmp("_pcomb_res_done_" + mode);
        vm.label("_pcomb_resok_" + mode);
        vm.label("_pcomb_res_done_" + mode);

        vm.mov(VReg.A0, VReg.S0);
        vm.call("_pcomb_materialize");
        vm.mov(VReg.S0, VReg.RET);
        this.emitExcPop(0);

        vm.shrImm(VReg.V1, VReg.S0, 48);
        vm.cmpImm(VReg.V1, 0x7FFE);
        vm.jeq("_pcomb_arr_" + mode);
        // 迭代器:remaining=1,空结果数组,SP+144=1
        vm.movImm(VReg.V1, 1);
        vm.store(VReg.SP, 144, VReg.V1);
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.movImm64(VReg.V1, MASK48);
        vm.and(VReg.V0, VReg.RET, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffe000000000000n);
        vm.or(VReg.S3, VReg.V0, VReg.V1);
        vm.movImm(VReg.S2, 0); // index
        vm.movImm(VReg.A0, 48);
        vm.call("_alloc");
        vm.mov(VReg.S4, VReg.RET);
        vm.store(VReg.S4, 0, VReg.S1);
        vm.store(VReg.S4, 8, VReg.S3);
        vm.movImm(VReg.V1, 1);
        vm.store(VReg.S4, 16, VReg.V1); // remaining=1
        vm.movImm(VReg.V1, mode);
        vm.store(VReg.S4, 24, VReg.V1);
        vm.load(VReg.V1, VReg.SP, 120);
        vm.store(VReg.S4, 32, VReg.V1);
        vm.load(VReg.V1, VReg.SP, 128);
        vm.store(VReg.S4, 40, VReg.V1);
        vm.jmp("_pcomb_pro_done_" + mode);

        vm.label("_pcomb_arr_" + mode);
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.SP, 144, VReg.V1);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.mov(VReg.S2, VReg.RET);
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_array_new_with_size");
        vm.movImm64(VReg.V1, MASK48);
        vm.and(VReg.V0, VReg.RET, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffe000000000000n);
        vm.or(VReg.S3, VReg.V0, VReg.V1);
        vm.movImm(VReg.A0, 48);
        vm.call("_alloc");
        vm.mov(VReg.S4, VReg.RET);
        vm.store(VReg.S4, 0, VReg.S1);
        vm.store(VReg.S4, 8, VReg.S3);
        vm.addImm(VReg.V1, VReg.S2, 1);
        vm.store(VReg.S4, 16, VReg.V1);
        vm.movImm(VReg.V1, mode);
        vm.store(VReg.S4, 24, VReg.V1);
        vm.load(VReg.V1, VReg.SP, 120);
        vm.store(VReg.S4, 32, VReg.V1);
        vm.load(VReg.V1, VReg.SP, 128);
        vm.store(VReg.S4, 40, VReg.V1);
        vm.label("_pcomb_pro_done_" + mode);
    }

    // ==================== [test262] 组合器迭代协议 + C.resolve 订阅 ====================
    // _pcomb_materialize(A0=iterable) -> RET boxed 数组。抛出走 _throw_unwind:
    //   数组 → 原样;字符串 → 逐码元;其余 → GetIterator 协议(含 value getter 抛出)。
    // _pcomb_subscribe(A0=C, A1=resolveFn, A2=value, A3=onF, A4=onR):
    //   nextPromise = Call(resolveFn, C, «value»);
    //   Promise 品牌 → _promise_then2;否则 Invoke(p,"then",«onF,onR»)(可抛)。
    generateCombinatorIter() {
        const vm = this.vm;

        // ---- materialize ----
        vm.label("_pcomb_materialize");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0); // iterable
        vm.shrImm(VReg.V1, VReg.S0, 48);
        vm.cmpImm(VReg.V1, 0x7FFE);
        vm.jne("_pcm_chk_str");
        // 数组默认走快路,但若自有 @@iterator 被覆写(尤其 getter 抛)则必须走 GetIterator。
        vm.lea(VReg.A0, "_symwk_iterator");
        this.emitStringConst(VReg.A1, "Symbol.iterator");
        vm.call("_symbol_wellknown");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_closure_prop_get");
        vm.movImm64(VReg.V1, 0x7ffb000000000000n);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_pcm_ret_arr");
        vm.jmp("_pcm_getiter");
        vm.label("_pcm_chk_str");
        vm.cmpImm(VReg.V1, 0x7FFC);
        vm.jeq("_pcm_string");
        // 通用 GetIterator
        vm.label("_pcm_getiter");
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.movImm64(VReg.V1, MASK48);
        vm.and(VReg.V0, VReg.RET, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffe000000000000n);
        vm.or(VReg.S1, VReg.V0, VReg.V1); // boxed 空数组
        vm.lea(VReg.A0, "_symwk_iterator");
        this.emitStringConst(VReg.A1, "Symbol.iterator");
        vm.call("_symbol_wellknown");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_object_get");
        vm.movImm64(VReg.V1, 0x7ffb000000000000n);
        vm.cmp(VReg.RET, VReg.V1);
        vm.jne("_pcm_iter_maybe");
        vm.mov(VReg.A0, VReg.S0);
        this.emitStringConst(VReg.A1, "Symbol.iterator");
        vm.call("_object_get");
        vm.label("_pcm_iter_maybe");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_maybe_getter");
        vm.shrImm(VReg.V2, VReg.RET, 48);
        vm.cmpImm(VReg.V2, 0x7FFF);
        vm.jne("_pcm_notiter");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_spread_call0"); // iterator = method.call(obj)
        vm.mov(VReg.S2, VReg.RET);
        // Type(iterator) must be Object(0x7FFD) or Array(0x7FFE) or 裸堆
        vm.shrImm(VReg.V1, VReg.S2, 48);
        vm.cmpImm(VReg.V1, 0x7FFD);
        vm.jeq("_pcm_iter_ok");
        vm.cmpImm(VReg.V1, 0x7FFE);
        vm.jeq("_pcm_iter_ok");
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_pcm_notiter");
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_pcm_notiter");
        vm.label("_pcm_iter_ok");
        // 不在此排空迭代器(永不 done 的自定义 iterable 会把 materialize 挂死,
        // invoke-then-error-close 即此)。返回 iterator,由组合器逐步 IteratorStep。
        vm.mov(VReg.RET, VReg.S2);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 48);
        vm.label("_pcm_loop"); // 保留标签以免旧引用,直接落到 notiter
        vm.jmp("_pcm_notiter");

        vm.label("_pcm_string");
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.movImm64(VReg.V1, MASK48);
        vm.and(VReg.V0, VReg.RET, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffe000000000000n);
        vm.or(VReg.S1, VReg.V0, VReg.V1);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_strlen");
        vm.mov(VReg.S2, VReg.RET); // len
        vm.movImm(VReg.S3, 0); // i
        vm.label("_pcm_str_loop");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_pcm_ret_s1");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_str_charAt");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_array_push");
        vm.mov(VReg.S1, VReg.RET);
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_pcm_str_loop");

        vm.label("_pcm_ret_arr");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 48);
        vm.label("_pcm_ret_s1");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 48);
        vm.label("_pcm_notiter");
        this.emitStringConst(VReg.A0, "argument is not iterable");
        vm.call("_throw_type_error"); // 不返回
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 48);

        // _pcomb_iter_step(A0=iterator, A1=out 槽地址) -> RET 1=有值已写入 *A1, 0=done
        // IteratorStep/IteratorValue: next() 结果必须是 Object,否则 TypeError
        // (不得把非对象喂给 _object_get:tag0 垃圾指针会 SIGSEGV)。
        // next/_object_get/_maybe_getter 若只置 pending 不 unwind,在此传播,
        // 让组合器 catch 拒绝 Promise,而不是野读崩。
        vm.label("_pcomb_iter_step");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.A0, VReg.S0);
        this.emitStringConst(VReg.A1, "next");
        vm.call("_object_get");
        vm.mov(VReg.S3, VReg.RET);
        this.emitJumpIfPending("_pis_pending");
        vm.mov(VReg.A0, VReg.S3);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_maybe_getter");
        vm.mov(VReg.S3, VReg.RET);
        this.emitJumpIfPending("_pis_pending");
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_pnpc_is_callable");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_pis_notiter");
        vm.mov(VReg.A0, VReg.S3);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_spread_call0");
        vm.mov(VReg.S2, VReg.RET); // res
        this.emitJumpIfPending("_pis_pending");
        // Type(result) must be Object(0x7FFD)/Array(0x7FFE)/Function(0x7FFF)/裸堆
        vm.shrImm(VReg.V1, VReg.S2, 48);
        vm.cmpImm(VReg.V1, 0x7FFD);
        vm.jeq("_pis_obj_ok");
        vm.cmpImm(VReg.V1, 0x7FFE);
        vm.jeq("_pis_obj_ok");
        vm.cmpImm(VReg.V1, 0x7FFF);
        vm.jeq("_pis_obj_ok");
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_pis_notobj");
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_pis_notobj");
        vm.label("_pis_obj_ok");
        vm.mov(VReg.A0, VReg.S2);
        this.emitStringConst(VReg.A1, "done");
        vm.call("_object_get");
        vm.mov(VReg.S3, VReg.RET);
        this.emitJumpIfPending("_pis_pending");
        vm.mov(VReg.A0, VReg.S3);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_maybe_getter");
        vm.mov(VReg.S3, VReg.RET);
        this.emitJumpIfPending("_pis_pending");
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_to_boolean");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_pis_done");
        vm.mov(VReg.A0, VReg.S2);
        this.emitStringConst(VReg.A1, "value");
        vm.call("_object_get");
        vm.mov(VReg.S3, VReg.RET);
        this.emitJumpIfPending("_pis_pending");
        vm.mov(VReg.A0, VReg.S3);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_maybe_getter");
        vm.mov(VReg.S3, VReg.RET);
        this.emitJumpIfPending("_pis_pending");
        vm.store(VReg.S1, 0, VReg.S3);
        vm.movImm(VReg.RET, 1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);
        vm.label("_pis_done");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);
        vm.label("_pis_notobj");
        this.emitStringConst(VReg.A0, "Iterator result is not an object");
        vm.call("_throw_type_error");
        vm.label("_pis_notiter");
        this.emitStringConst(VReg.A0, "iterator.next is not a function");
        vm.call("_throw_type_error");
        vm.label("_pis_pending");
        vm.call("_throw_unwind");

        // _pcomb_iter_close(A0=iterator):IteratorClose,忽略 return 缺失/抛出。
        // 保存并恢复既有异常槽,避免 return() 抛错覆盖 GetIterator 的 TypeError。
        vm.label("_pcomb_iter_close");
        vm.prologue(112, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0);
        vm.lea(VReg.V0, "_exception_value");
        vm.load(VReg.S1, VReg.V0, 0);
        vm.lea(VReg.V0, "_exception_pending");
        vm.load(VReg.S2, VReg.V0, 0);
        vm.shrImm(VReg.V1, VReg.S0, 48);
        vm.cmpImm(VReg.V1, 0x7FFD);
        vm.jeq("_pic_get");
        vm.cmpImm(VReg.V1, 0x7FFE);
        vm.jeq("_pic_get");
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_pic_ret");
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_pic_ret");
        vm.label("_pic_get");
        this.emitExcPush(0, "_pic_ignore");
        vm.mov(VReg.A0, VReg.S0);
        this.emitStringConst(VReg.A1, "return");
        vm.call("_object_get");
        vm.shrImm(VReg.V1, VReg.RET, 48);
        vm.cmpImm(VReg.V1, 0x7FFF);
        vm.jne("_pic_pop");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_spread_call0");
        vm.label("_pic_pop");
        this.emitExcPop(0);
        vm.jmp("_pic_ret");
        vm.label("_pic_ignore");
        this.emitExcPop(0);
        vm.label("_pic_ret");
        vm.lea(VReg.V0, "_exception_value");
        vm.store(VReg.V0, 0, VReg.S1);
        vm.lea(VReg.V0, "_exception_pending");
        vm.store(VReg.V0, 0, VReg.S2);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 112);

        // ---- subscribe: Call(resolve) + Invoke(then) ----
        vm.label("_pcomb_subscribe");
        vm.prologue(112, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        vm.mov(VReg.S0, VReg.A0); // C
        vm.mov(VReg.S1, VReg.A1); // resolveFn
        vm.mov(VReg.S2, VReg.A2); // value
        vm.mov(VReg.S3, VReg.A3); // onF
        vm.mov(VReg.S4, VReg.A4); // onR
        vm.cmpImm(VReg.S1, 0);
        vm.jeq("_pcs_direct");
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S0);
        vm.mov(VReg.A2, VReg.S2);
        vm.movImm64(VReg.A3, JS_UNDEFINED);
        vm.movImm(VReg.A4, 1);
        vm.call("_promise_invoke2");
        vm.jmp("_pcs_have_p");
        vm.label("_pcs_direct");
        vm.mov(VReg.A0, VReg.S2);
        vm.movImm(VReg.A5, 0); // resolveFn==0 ⇒ C 就是 %Promise%
        vm.call("_Promise_resolve");
        vm.label("_pcs_have_p");
        vm.mov(VReg.S2, VReg.RET); // nextPromise
        this.emitJumpIfPending("_pcs_pending");
        vm.mov(VReg.A0, VReg.S2);
        this.emitStringConst(VReg.A1, "then");
        vm.call("_object_get");
        vm.mov(VReg.S0, VReg.RET);
        this.emitJumpIfPending("_pcs_pending");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_maybe_getter");
        vm.mov(VReg.S0, VReg.RET); // then 函数(或 undefined)
        this.emitJumpIfPending("_pcs_pending");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_pnpc_is_callable");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_pcs_invoke_then");
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_is_promise");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_pcs_brand");
        // 非 callable 且非品牌 Promise:Invoke 须 TypeError,不得把数字/对象
        // 喂给 _promise_invoke2(_js_unbox 后 load magic → SIGSEGV)。
        this.emitStringConst(VReg.A0, "then is not a function");
        vm.call("_throw_type_error");
        vm.label("_pcs_invoke_then");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S2);
        vm.mov(VReg.A2, VReg.S3);
        vm.mov(VReg.A3, VReg.S4);
        vm.movImm(VReg.A4, 2);
        vm.call("_promise_invoke2");
        vm.movImm64(VReg.RET, JS_UNDEFINED);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 112);
        vm.label("_pcs_brand");
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S3);
        vm.mov(VReg.A2, VReg.S4);
        vm.call("_promise_then2");
        vm.movImm64(VReg.RET, JS_UNDEFINED);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 112);
        vm.label("_pcs_pending");
        vm.call("_throw_unwind");
    }

    // [test262] Promise 组合器参数守卫。all/any/race/allSettled 直接把 A0 当数组
    // 指针解引用(_array_length 等),非数组 tagged 值(Promise.all(false)/race(5) …)
    // 会 SIGSEGV。规范要求:非可迭代参数使返回 promise **reject 一个 TypeError**
    // (既不同步抛、也不崩)。本运行时仅支持数组(tag 0x7FFE)形态的可迭代;其余
    // 一律走此拒绝路径。
    //
    // _combinator_reject_notiterable(A0 = boxed 结果 promise) -> RET = 同一 promise
    // 构造 TypeError {name,message,__asmjs_err}(与 _throw_type_error 同构,故
    // e instanceof TypeError / e.name / e.message 成立),以其 reject 结果 promise。
    generateCombinatorGuard() {
        const vm = this.vm;
        const boxStr = (reg) => { // cstr 地址 → 装箱字符串(0x7FFC)
            vm.movImm64(VReg.V1, 0x0000ffffffffffffn); vm.and(reg, reg, VReg.V1);
            vm.movImm64(VReg.V1, 0x7ffc000000000000n); vm.or(reg, reg, VReg.V1);
        };
        // _promise_reject_type_error(A0 = boxed 结果 promise, A1 = boxed message 串)
        //   -> RET = 同一 promise。唯一的"以 TypeError 拒绝"构造点。
        vm.label("_promise_reject_type_error");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0); // boxed 结果 promise
        vm.mov(VReg.S2, VReg.A1); // boxed message
        vm.call("_object_new");
        vm.call("_box_obj_r"); // RET = boxed(0x7FFD) errObj
        vm.mov(VReg.S1, VReg.RET);
        // name = "TypeError"
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.A1, vm.asm.addString("name")); boxStr(VReg.A1);
        vm.lea(VReg.A2, vm.asm.addString("TypeError")); boxStr(VReg.A2);
        vm.call("_object_set");
        // message(调用方给定)
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.A1, vm.asm.addString("message")); boxStr(VReg.A1);
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_object_set");
        // __asmjs_err = true(instanceof Error 族品牌)
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.A1, vm.asm.addString("__asmjs_err")); boxStr(VReg.A1);
        vm.movImm64(VReg.A2, 0x7ff9000000000001n); // boxed true
        vm.call("_object_set");
        // cause = undefined(与 _throw_type_error 同:避免 e.cause 缺属性返 int 0)
        vm.mov(VReg.A0, VReg.S1);
        vm.lea(VReg.A1, vm.asm.addString("cause")); boxStr(VReg.A1);
        vm.movImm64(VReg.A2, 0x7ffb000000000000n); // undefined
        vm.call("_object_set");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_promise_attach_terror_proto");
        vm.mov(VReg.S1, VReg.RET);
        // reject(result, errObj)
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_promise_reject");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);

        // _promise_attach_terror_proto(A0=errObj) -> RET=同一对象,尽量挂 TypeError.prototype
        // 使 Object.getPrototypeOf(e)===TypeError.prototype(iter-arg-is-*-reject)。
        vm.label("_promise_attach_terror_proto");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S0, VReg.A0);
        vm.shrImm(VReg.V1, VReg.S0, 48);
        vm.cmpImm(VReg.V1, 0x7FFD);
        vm.jne("_patp_ret");
        vm.mov(VReg.A0, VReg.S0);
        this.emitStringConst(VReg.A1, "__asmjs_err");
        vm.call("_object_has");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_patp_ret");
        vm.lea(VReg.V0, "_errctorref_TypeError");
        vm.load(VReg.S1, VReg.V0, 0);
        vm.cmpImm(VReg.S1, 0);
        vm.jne("_patp_have");
        // 物化 TypeError 构造器到槽(与 emitErrorCtorRef 同形;后到的 dataLabel 覆盖偏移)
        vm.movImm(VReg.A0, 16);
        vm.call("_alloc");
        vm.mov(VReg.S2, VReg.RET);
        vm.movImm(VReg.V1, CLOSURE_MAGIC);
        vm.store(VReg.S2, 0, VReg.V1);
        vm.lea(VReg.V1, "_object_new");
        vm.store(VReg.S2, 8, VReg.V1);
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_js_box_function");
        vm.mov(VReg.S1, VReg.RET);
        vm.lea(VReg.V0, "_errctorref_TypeError");
        vm.store(VReg.V0, 0, VReg.S1);
        vm.mov(VReg.A0, VReg.S1);
        this.emitStringConst(VReg.A1, "name");
        this.emitStringConst(VReg.A2, "TypeError");
        vm.call("_closure_prop_set");
        vm.label("_patp_have");
        vm.mov(VReg.A0, VReg.S1);
        this.emitStringConst(VReg.A1, "prototype");
        vm.call("_closure_prop_get");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_object_setPrototypeOf");
        vm.label("_patp_ret");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);

        // 组合器守卫:非数组参数 → 以 TypeError 拒绝结果 promise
        vm.label("_combinator_reject_notiterable");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.lea(VReg.A1, vm.asm.addString("argument is not iterable")); boxStr(VReg.A1);
        vm.call("_promise_reject_type_error"); // A0 原样透传
        vm.epilogue([VReg.S0, VReg.S1], 16);
    }

    // Promise.all(A0=iterable) -> boxed promise
    generatePromiseAll() {
        const vm = this.vm;
        const SAVED = [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5];
        vm.label("_Promise_all");
        vm.prologue(160, SAVED);
        vm.mov(VReg.S0, VReg.A0);
        this.emitCombinatorPrologue(0, "_pall_catch");
        vm.load(VReg.S5, VReg.S4, 40); // onR = capReject

        vm.load(VReg.V1, VReg.SP, 144);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_pall_iter");

        vm.movImm(VReg.S3, 0);
        vm.label("_pall_loop");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_pall_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_get");
        vm.store(VReg.SP, 96, VReg.RET);
        vm.mov(VReg.A0, VReg.S4);
        vm.mov(VReg.A1, VReg.S3);
        vm.movImm(VReg.A2, 0);
        vm.call("_pcomb_make_elem");
        vm.store(VReg.SP, 104, VReg.RET);
        this.emitExcPush(0, "_pall_catch");
        vm.load(VReg.A0, VReg.SP, 80);
        vm.load(VReg.A1, VReg.SP, 88);
        vm.load(VReg.A2, VReg.SP, 96);
        vm.load(VReg.A3, VReg.SP, 104);
        vm.mov(VReg.A4, VReg.S5);
        vm.call("_pcomb_subscribe");
        this.emitExcPop(0);
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_pall_loop");

        vm.label("_pall_iter");
        vm.movImm(VReg.S3, 0);
        vm.label("_pall_iloop");
        // IteratorStep abrupt → [[Done]]=true → 外层不 IteratorClose(iter-*-err-no-close)
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.SP, 144, VReg.V1);
        this.emitExcPush(0, "_pall_catch");
        vm.mov(VReg.A0, VReg.S0);
        vm.addImm(VReg.A1, VReg.SP, 96);
        vm.call("_pcomb_iter_step");
        this.emitExcPop(0);
        vm.movImm(VReg.V1, 1);
        vm.store(VReg.SP, 144, VReg.V1);
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_pall_done");
        vm.load(VReg.V1, VReg.S4, 16);
        vm.addImm(VReg.V1, VReg.V1, 1);
        vm.store(VReg.S4, 16, VReg.V1);
        vm.mov(VReg.A0, VReg.S4);
        vm.mov(VReg.A1, VReg.S3);
        vm.movImm(VReg.A2, 0);
        vm.call("_pcomb_make_elem");
        vm.store(VReg.SP, 104, VReg.RET);
        this.emitExcPush(0, "_pall_catch");
        vm.load(VReg.A0, VReg.SP, 80);
        vm.load(VReg.A1, VReg.SP, 88);
        vm.load(VReg.A2, VReg.SP, 96);
        vm.load(VReg.A3, VReg.SP, 104);
        vm.mov(VReg.A4, VReg.S5);
        vm.call("_pcomb_subscribe");
        this.emitExcPop(0);
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_pall_iloop");

        vm.label("_pall_done");
        vm.mov(VReg.A0, VReg.S4);
        vm.call("_pcomb_release");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue(SAVED, 160);

        vm.label("_pall_catch");
        this.emitExcPop(0);
        vm.load(VReg.V1, VReg.SP, 144);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_pall_catch_rej");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_pcomb_iter_close");
        vm.label("_pall_catch_rej");
        this.emitTakeException(VReg.S3);
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_promise_attach_terror_proto");
        vm.mov(VReg.A2, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 128); // capReject(NPC 后即有效,不依赖 S4)
        vm.cmpImm(VReg.A0, 0);
        vm.jeq("_pall_catch_raw");
        vm.movImm64(VReg.A1, JS_UNDEFINED);
        vm.movImm64(VReg.A3, JS_UNDEFINED);
        vm.movImm(VReg.A4, 1);
        vm.call("_promise_invoke2");
        vm.jmp("_pall_catch_ret");
        vm.label("_pall_catch_raw");
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_promise_reject");
        vm.label("_pall_catch_ret");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue(SAVED, 160);
    }

    // [#36/#57] f.bind(thisArg, ...boundArgs) 的绑定蹦床。绑定闭包布局
    // (伪装成普通闭包):{CLOSURE_MAGIC@0, _bound_tramp@8, target(boxed fn)@16,
    //  thisArg@24, nBound@32(raw int), boundArg0@40, boundArg1@48, …}。
    // 调用协议:S0=闭包 raw 指针、A0-A4 实参、A5=this;蹦床把 nBound 个预绑定参
    // 前置到实参窗口(超 5 者截断,与既有 6 参寄存器上限一致)、A5 改写为绑定
    // this、S0 交接为 target 后尾跳其 func_ptr(借返回地址,S0 staging 语义与
    // 普通调用点同构;不 call 任何东西以保 LR/x64 返回地址)。
    // x64 别名要害:入口先把 A0-A4 落栈缓冲,此后 V1/V2/V3/V4/V7(=A3/A2/A4/A5/A1)
    // 皆可作 scratch(与 V5/V6/V0 一并 8 个 caller-saved),末尾再从缓冲重载 A0-A4;
    // 全程不写 S1-S4(它们是调用方跨调用存活的 callee-saved,目标未必保存)。
    // 栈缓冲(128B,16 对齐)仅 sub/add SP 借用,重载入寄存器后即归还,再尾跳。
    generateBoundTramp() {
        const vm = this.vm;
        vm.label("_bound_tramp");
        // 借 128B 栈缓冲:OA[j]=SP+j*8(保存入参 A0-A4),CB=SP+48(合成窗口)
        vm.subImm(VReg.SP, VReg.SP, 128);
        vm.store(VReg.SP, 0, VReg.A0);
        vm.store(VReg.SP, 8, VReg.A1);
        vm.store(VReg.SP, 16, VReg.A2);
        vm.store(VReg.SP, 24, VReg.A3);
        vm.store(VReg.SP, 32, VReg.A4);
        // spCopy(V7):arm64 上 add(dst, SP, reg) 把 31 当 XZR 而非 SP → 寄存器加法
        // 必须用 SP 的普通寄存器副本(addImm 立即数形式认 SP)。A1 已落栈,V7 可用。
        vm.addImm(VReg.V7, VReg.SP, 0);
        // N = nBound,截断到 5(超出者不入寄存器窗口)
        vm.load(VReg.V5, VReg.S0, 32);
        // [argc ABI] 目标收到 nBound+调用点实参:_call_argc += nBound(未截断值,
        // 语义计数)。V1/V2 此刻空闲(A0-A4 已落栈缓冲,B 循环稍后才用)。
        vm.lea(VReg.V1, "_call_argc");
        vm.load(VReg.V2, VReg.V1, 0);
        vm.add(VReg.V2, VReg.V2, VReg.V5);
        vm.store(VReg.V1, 0, VReg.V2);
        vm.cmpImm(VReg.V5, 5);
        vm.jle("_btr_nclamp");
        vm.movImm(VReg.V5, 5);
        vm.label("_btr_nclamp");
        // 预绑定参逐个写入 CB[i]=closure[40+i*8],i=0..N-1
        vm.movImm(VReg.V6, 0); // i
        vm.label("_btr_bloop");
        vm.cmp(VReg.V6, VReg.V5);
        vm.jge("_btr_bdone");
        vm.shlImm(VReg.V1, VReg.V6, 3); // i*8
        vm.add(VReg.V2, VReg.S0, VReg.V1);
        vm.load(VReg.V3, VReg.V2, 40); // closure[40+i*8]
        vm.add(VReg.V4, VReg.V7, VReg.V1);
        vm.store(VReg.V4, 48, VReg.V3); // CB[i] = SP+48+i*8
        vm.addImm(VReg.V6, VReg.V6, 1);
        vm.jmp("_btr_bloop");
        vm.label("_btr_bdone");
        // 旧实参前移:CB[N+j]=OA[j],j=0..4(CB[N+j]=[SP+N*8 + 48 + j*8])
        vm.shlImm(VReg.V1, VReg.V5, 3); // N*8
        vm.add(VReg.V2, VReg.V7, VReg.V1); // SP + N*8
        vm.load(VReg.V3, VReg.SP, 0); vm.store(VReg.V2, 48, VReg.V3);
        vm.load(VReg.V3, VReg.SP, 8); vm.store(VReg.V2, 56, VReg.V3);
        vm.load(VReg.V3, VReg.SP, 16); vm.store(VReg.V2, 64, VReg.V3);
        vm.load(VReg.V3, VReg.SP, 24); vm.store(VReg.V2, 72, VReg.V3);
        vm.load(VReg.V3, VReg.SP, 32); vm.store(VReg.V2, 80, VReg.V3);
        // target 脱壳到 V5(此时 S0 仍是闭包)
        vm.load(VReg.V5, VReg.S0, 16);
        vm.shlImm(VReg.V5, VReg.V5, 16);
        vm.shrImm(VReg.V5, VReg.V5, 16);
        // 从合成窗口重载 A0-A4(x64 上此刻才写 A 寄存器,别名安全)
        vm.load(VReg.A0, VReg.SP, 48);
        vm.load(VReg.A1, VReg.SP, 56);
        vm.load(VReg.A2, VReg.SP, 64);
        vm.load(VReg.A3, VReg.SP, 72);
        vm.load(VReg.A4, VReg.SP, 80);
        vm.load(VReg.A5, VReg.S0, 24); // A5 = thisArg(S0 仍是闭包)
        vm.addImm(VReg.SP, VReg.SP, 128); // 归还缓冲
        vm.mov(VReg.S0, VReg.V5); // S0 = target raw
        // 闭包(magic)→ func=[S0+8];否则 S0 即裸函数指针(镜像 compileMethodCall)
        vm.load(VReg.V6, VReg.S0, 0);
        vm.cmpImm(VReg.V6, CLOSURE_MAGIC);
        vm.jeq("_btr_closure");
        vm.cmpImm(VReg.V6, ASYNC_CLOSURE_MAGIC);
        vm.jeq("_btr_closure");
        vm.mov(VReg.V5, VReg.S0);
        vm.movImm(VReg.S0, 0);
        vm.jmpIndirect(VReg.V5);
        vm.label("_btr_closure");
        vm.load(VReg.V5, VReg.S0, 8);
        vm.jmpIndirect(VReg.V5);

        // [IsConstructor] _is_nonctor_fn(A0 = 裸函数/闭包/Proxy 指针) -> RET = 1 表示**确定**
        // 没有 [[Construct]](箭头/方法简写/async/generator,以及绑定到它们的 bound fn /
        // Proxy 包装上述目标)。判据是函数元数据 kind bit9;未登记的入口(内建/classinfo)
        // 返 0。bound 沿 target@16、Proxy 沿 target@8 链式展开(规范 10.4.1.2 / 10.5.2)。
        vm.label("_is_nonctor_fn");
        vm.prologue(0, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);
        vm.movImm(VReg.S1, 0); // 展开步数上限(防 bound/Proxy 环)
        vm.label("_incf_loop");
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_incf_no");
        vm.load(VReg.V0, VReg.S0, 0);
        vm.cmpImm(VReg.V0, CLOSURE_MAGIC);
        vm.jne("_incf_try_proxy");
        vm.load(VReg.V0, VReg.S0, 8);
        vm.lea(VReg.V1, "_bound_tramp");
        vm.cmp(VReg.V0, VReg.V1);
        vm.jne("_incf_meta");
        vm.load(VReg.S0, VReg.S0, 16); // bound target(boxed)
        vm.label("_incf_unbox_cont");
        vm.movImm64(VReg.V1, MASK48);
        vm.and(VReg.S0, VReg.S0, VReg.V1);
        vm.addImm(VReg.S1, VReg.S1, 1);
        vm.cmpImm(VReg.S1, 32);
        vm.jlt("_incf_loop");
        vm.jmp("_incf_no");
        vm.label("_incf_try_proxy");
        // Proxy 块:type@0=8, target@8(boxed)。IsConstructor(proxy) ≡ target 侧。
        vm.loadByte(VReg.V0, VReg.S0, 0);
        vm.cmpImm(VReg.V0, 8); // TYPE_PROXY
        vm.jne("_incf_no");
        vm.load(VReg.S0, VReg.S0, 8);
        vm.jmp("_incf_unbox_cont");
        vm.label("_incf_meta");
        vm.mov(VReg.A0, VReg.V0);
        vm.call("_func_meta_nonctor");
        vm.epilogue([VReg.S0, VReg.S1], 0);
        vm.label("_incf_no");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1], 0);
    }

    // [#35] Promise.any(A0=iterable) -> boxed promise
    // [test262] 首个 fulfil 胜出;全 reject → AggregateError。
    generatePromiseAny() {
        const vm = this.vm;
        const SAVED = [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5];
        vm.label("_Promise_any");
        vm.prologue(160, SAVED);
        vm.mov(VReg.S0, VReg.A0);
        this.emitCombinatorPrologue(2, "_pany_catch");
        vm.load(VReg.A0, VReg.S4, 32); // capResolve
        vm.load(VReg.A1, VReg.S4, 40); // capReject
        vm.call("_pcomb_make_safe_resolve");
        vm.mov(VReg.S5, VReg.RET); // onF = safeResolve

        vm.load(VReg.V1, VReg.SP, 144);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_pany_iter");

        vm.movImm(VReg.S3, 0);
        vm.label("_pany_loop");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_pany_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_get");
        vm.store(VReg.SP, 96, VReg.RET);
        vm.mov(VReg.A0, VReg.S4);
        vm.mov(VReg.A1, VReg.S3);
        vm.movImm(VReg.A2, 1);
        vm.call("_pcomb_make_elem");
        vm.store(VReg.SP, 104, VReg.RET);
        this.emitExcPush(0, "_pany_catch");
        vm.load(VReg.A0, VReg.SP, 80);
        vm.load(VReg.A1, VReg.SP, 88);
        vm.load(VReg.A2, VReg.SP, 96);
        vm.mov(VReg.A3, VReg.S5);
        vm.load(VReg.A4, VReg.SP, 104);
        vm.call("_pcomb_subscribe");
        this.emitExcPop(0);
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_pany_loop");

        vm.label("_pany_iter");
        vm.movImm(VReg.S3, 0);
        vm.label("_pany_iloop");
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.SP, 144, VReg.V1);
        this.emitExcPush(0, "_pany_catch");
        vm.mov(VReg.A0, VReg.S0);
        vm.addImm(VReg.A1, VReg.SP, 96);
        vm.call("_pcomb_iter_step");
        this.emitExcPop(0);
        vm.movImm(VReg.V1, 1);
        vm.store(VReg.SP, 144, VReg.V1);
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_pany_done");
        vm.load(VReg.V1, VReg.S4, 16);
        vm.addImm(VReg.V1, VReg.V1, 1);
        vm.store(VReg.S4, 16, VReg.V1);
        vm.mov(VReg.A0, VReg.S4);
        vm.mov(VReg.A1, VReg.S3);
        vm.movImm(VReg.A2, 1);
        vm.call("_pcomb_make_elem");
        vm.store(VReg.SP, 104, VReg.RET);
        this.emitExcPush(0, "_pany_catch");
        vm.load(VReg.A0, VReg.SP, 80);
        vm.load(VReg.A1, VReg.SP, 88);
        vm.load(VReg.A2, VReg.SP, 96);
        vm.mov(VReg.A3, VReg.S5);
        vm.load(VReg.A4, VReg.SP, 104);
        vm.call("_pcomb_subscribe");
        this.emitExcPop(0);
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_pany_iloop");

        vm.label("_pany_done");
        vm.mov(VReg.A0, VReg.S4);
        vm.call("_pcomb_release");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue(SAVED, 160);

        vm.label("_pany_catch");
        this.emitExcPop(0);
        vm.load(VReg.V1, VReg.SP, 144);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_pany_catch_rej");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_pcomb_iter_close");
        vm.label("_pany_catch_rej");
        this.emitTakeException(VReg.S3);
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_promise_attach_terror_proto");
        vm.mov(VReg.A2, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 128);
        vm.cmpImm(VReg.A0, 0);
        vm.jeq("_pany_catch_raw");
        vm.movImm64(VReg.A1, JS_UNDEFINED);
        vm.movImm64(VReg.A3, JS_UNDEFINED);
        vm.movImm(VReg.A4, 1);
        vm.call("_promise_invoke2");
        vm.jmp("_pany_catch_ret");
        vm.label("_pany_catch_raw");
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_promise_reject");
        vm.label("_pany_catch_ret");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue(SAVED, 160);
    }

    // p.finally(cb) —— 规范 27.2.5.3 的去糖形态:
    //   p.then(v => { cb(); return v; }, e => { cb(); throw e; })
    // [test262] 旧实现在**调用点同步**执行 cb 并把原 promise 原样返回:cb 早于任何
    // then 回调触发(顺序错)、返回值不是派生 promise(链上 catch 收不到)、cb 抛错
    // 不拦截。现在按订阅走 _promise_then2,两个方向各挂一个 tramp 闭包
    //   {CLOSURE_MAGIC@0, _pfin_tramp@8, cb@16, kind@24}(kind 0=fulfil,1=reject)。
    // cb 以 argc=0 调用(规范:onFinally 收零实参);reject 方向调完 cb 后把原拒因
    // 重新置入异常槽并 _throw_unwind —— 由 _promise_drain_reactions 的异常帧接住,
    // 拒绝派生 promise(拒因保持为原值,cb 的返回值不覆盖它)。
    generatePromiseFinally() {
        const vm = this.vm;

        vm.label("_promise_finally");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        vm.mov(VReg.S0, VReg.A0); // 原 promise/接收者(boxed)
        vm.mov(VReg.S1, VReg.A1); // onFinally
        // 规范 27.2.5.3 步骤 3:C = SpeciesConstructor(promise, %Promise%),
        // ThenFinally/CatchFinally 用它做 PromiseResolve(subclass-*-count、
        // species-constructor 数的就是这几次派生构造)。0 = 原生 %Promise%。
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_promise_species_ctor");
        vm.mov(VReg.S4, VReg.RET);
        // 步骤 4:onFinally 不可调用时,thenFinally/catchFinally 均等于它本身
        // (invokes-then-with-non-function:then 收到的两参都是原值)。
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_pnpc_is_callable");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_pfin_wrap");
        vm.mov(VReg.S2, VReg.S1);
        vm.mov(VReg.S3, VReg.S1);
        vm.jmp("_pfin_invoke");
        vm.label("_pfin_wrap");
        vm.mov(VReg.A0, VReg.S1);
        vm.movImm(VReg.A1, 0);
        vm.mov(VReg.A2, VReg.S4);
        vm.call("_pfin_make");
        vm.mov(VReg.S2, VReg.RET); // thenFinally
        vm.mov(VReg.A0, VReg.S1);
        vm.movImm(VReg.A1, 1);
        vm.mov(VReg.A2, VReg.S4);
        vm.call("_pfin_make");
        vm.mov(VReg.S3, VReg.RET); // catchFinally
        vm.label("_pfin_invoke");
        vm.mov(VReg.A0, VReg.S0);
        this.emitStringConst(VReg.A1, "then");
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_maybe_getter");
        vm.mov(VReg.S1, VReg.RET); // then
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_pnpc_is_callable");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_pfin_brand");
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S0);
        vm.mov(VReg.A2, VReg.S2);
        vm.mov(VReg.A3, VReg.S3);
        vm.movImm(VReg.A4, 2);
        vm.call("_promise_invoke2");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 48);

        vm.label("_pfin_brand");
        // Promise.prototype 已物化 ⇒ 上面的 Get 看得见继承的 then,拿到非可调用值只能
        // 是接收者自己覆写过(this-value-then-not-callable 的 p.then=1/undefined/…),
        // 按规范 Invoke 抛 TypeError。未物化时(语法快路 `p.finally(cb)` 可能没读过
        // Promise.prototype)退回品牌路径,保住原生 promise 的 finally。
        vm.lea(VReg.V0, "_nsobj_promise_proto");
        vm.load(VReg.V0, VReg.V0, 0);
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_pfin_notfn");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_is_promise");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_pfin_notfn");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S2);
        vm.mov(VReg.A2, VReg.S3);
        vm.call("_promise_then2");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 48);
        vm.label("_pfin_notfn");
        this.emitStringConst(VReg.A0, "undefined is not a function");
        vm.call("_throw_type_error");

        // _pfin_make(A0=onFinally, A1=kind, A2=C) -> RET boxed 一等函数(length 1、name "")
        // 闭包 48B {magic, _aref_generic@8, _pfin_tramp@16, onFinally@24, kind@32, C@40}
        vm.label("_pfin_make");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S1, VReg.A0);
        vm.mov(VReg.S2, VReg.A1);
        vm.mov(VReg.S3, VReg.A2);
        vm.movImm(VReg.A0, 48);
        vm.call("_alloc");
        vm.mov(VReg.S0, VReg.RET);
        vm.movImm(VReg.V1, CLOSURE_MAGIC);
        vm.store(VReg.S0, 0, VReg.V1);
        vm.lea(VReg.V1, "_aref_generic");
        vm.store(VReg.S0, 8, VReg.V1);
        vm.lea(VReg.V1, "_pfin_tramp");
        vm.store(VReg.S0, 16, VReg.V1);
        vm.store(VReg.S0, 24, VReg.S1);
        vm.store(VReg.S0, 32, VReg.S2);
        vm.store(VReg.S0, 40, VReg.S3);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_js_box_function");
        vm.mov(VReg.S0, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.movImm(VReg.A1, 1);
        vm.call("_pfin_fn_props");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);

        // _pfin_fn_props(A0=boxed fn, A1=length):规范匿名内建函数 name ""、length 给定
        vm.label("_pfin_fn_props");
        vm.prologue(32, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("name"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.lea(VReg.A2, vm.asm.addString(""));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A2, VReg.A2, VReg.V1);
        vm.call("_closure_prop_define");
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, vm.asm.addString("length"));
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.scvtf(0, VReg.S1);
        vm.fmovToInt(VReg.A2, 0);
        vm.call("_closure_prop_define");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1], 32);

        // ThenFinally/CatchFinally(规范 27.2.5.3.1/27.2.5.3.2):经 _aref_generic 进入,
        // S0 = 裸闭包、A1 = 结算值。
        //   result = Call(onFinally); p = PromiseResolve(C, result);
        //   return Invoke(p, "then", «valueThunk|thrower»)
        // 每次 finally 因此多派生两个 C 实例(subclass-*-count 里的 7 由此而来)。
        vm.label("_pfin_tramp");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        vm.mov(VReg.S1, VReg.A1);      // value/reason
        vm.load(VReg.S2, VReg.S0, 24); // onFinally
        vm.load(VReg.S3, VReg.S0, 32); // kind
        vm.load(VReg.S4, VReg.S0, 40); // C
        vm.mov(VReg.A0, VReg.S2);
        vm.movImm64(VReg.A1, JS_UNDEFINED); // this
        vm.movImm64(VReg.A2, JS_UNDEFINED);
        vm.movImm64(VReg.A3, JS_UNDEFINED);
        vm.movImm(VReg.A4, 0); // [argc ABI] onFinally 收零实参
        vm.call("_promise_invoke2");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A5, VReg.S4);
        vm.call("_Promise_resolve"); // p = PromiseResolve(C, result)
        vm.mov(VReg.S2, VReg.RET);   // S2 复用:onFinally 之后不再需要
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_pfin_make_thunk");
        vm.mov(VReg.S1, VReg.RET);
        vm.mov(VReg.A0, VReg.S2);
        this.emitStringConst(VReg.A1, "then");
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_maybe_getter");
        vm.mov(VReg.S3, VReg.RET);
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_pnpc_is_callable");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_pft_native");
        vm.mov(VReg.A0, VReg.S3);
        vm.mov(VReg.A1, VReg.S2);
        vm.mov(VReg.A2, VReg.S1);
        vm.movImm64(VReg.A3, JS_UNDEFINED);
        vm.movImm(VReg.A4, 1);
        vm.call("_promise_invoke2");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 48);
        vm.label("_pft_native");
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.S1);
        vm.movImm64(VReg.A2, JS_UNDEFINED);
        vm.call("_promise_then2");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 48);

        // _pfin_make_thunk(A0=value, A1=kind) -> boxed fn(length 0)
        // 闭包 40B {magic, _aref_generic@8, _pfin_thunk_tramp@16, value@24, kind@32}
        vm.label("_pfin_make_thunk");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S1, VReg.A0);
        vm.mov(VReg.S2, VReg.A1);
        vm.movImm(VReg.A0, 40);
        vm.call("_alloc");
        vm.mov(VReg.S0, VReg.RET);
        vm.movImm(VReg.V1, CLOSURE_MAGIC);
        vm.store(VReg.S0, 0, VReg.V1);
        vm.lea(VReg.V1, "_aref_generic");
        vm.store(VReg.S0, 8, VReg.V1);
        vm.lea(VReg.V1, "_pfin_thunk_tramp");
        vm.store(VReg.S0, 16, VReg.V1);
        vm.store(VReg.S0, 24, VReg.S1);
        vm.store(VReg.S0, 32, VReg.S2);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_js_box_function");
        vm.mov(VReg.S0, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.movImm(VReg.A1, 0);
        vm.call("_pfin_fn_props");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);

        vm.label("_pfin_thunk_tramp");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.load(VReg.S1, VReg.S0, 24); // value
        vm.load(VReg.V1, VReg.S0, 32); // kind
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_pfin_rethrow");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1], 16);
        vm.label("_pfin_rethrow");
        vm.lea(VReg.V0, "_exception_value");
        vm.store(VReg.V0, 0, VReg.S1);
        vm.lea(VReg.V0, "_exception_pending");
        vm.movImm(VReg.V1, 1);
        vm.store(VReg.V0, 0, VReg.V1);
        vm.call("_throw_unwind"); // 不返回:drain 的异常帧以原拒因拒绝派生 promise
        vm.epilogue([VReg.S0, VReg.S1], 16); // 理论不达
    }

    // Promise.race(A0=iterable) -> boxed promise
    // [test262] NPC → GetPromiseResolve → GetIterator;每轮 Call(C.resolve)+then
    // 订阅同一对 capResolve/capReject;空 iterable 永 pending(不 _pcomb_release)。
    generatePromiseRace() {
        const vm = this.vm;
        const SAVED = [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5];
        vm.label("_Promise_race");
        vm.prologue(160, SAVED);
        vm.mov(VReg.S0, VReg.A0);
        this.emitCombinatorPrologue(3, "_prc_catch");
        vm.load(VReg.S4, VReg.SP, 120); // onF = capResolve
        vm.load(VReg.S5, VReg.SP, 128); // onR = capReject

        vm.load(VReg.V1, VReg.SP, 144);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_prc_iter");

        vm.movImm(VReg.S3, 0);
        vm.label("_prc_loop");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_prc_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_get");
        vm.store(VReg.SP, 96, VReg.RET);
        this.emitExcPush(0, "_prc_catch");
        vm.load(VReg.A0, VReg.SP, 80);
        vm.load(VReg.A1, VReg.SP, 88);
        vm.load(VReg.A2, VReg.SP, 96);
        vm.mov(VReg.A3, VReg.S4);
        vm.mov(VReg.A4, VReg.S5);
        vm.call("_pcomb_subscribe");
        this.emitExcPop(0);
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_prc_loop");

        vm.label("_prc_iter");
        vm.movImm(VReg.S3, 0);
        vm.label("_prc_iloop");
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.SP, 144, VReg.V1);
        this.emitExcPush(0, "_prc_catch");
        vm.mov(VReg.A0, VReg.S0);
        vm.addImm(VReg.A1, VReg.SP, 96);
        vm.call("_pcomb_iter_step");
        this.emitExcPop(0);
        vm.movImm(VReg.V1, 1);
        vm.store(VReg.SP, 144, VReg.V1);
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_prc_done");
        this.emitExcPush(0, "_prc_catch");
        vm.load(VReg.A0, VReg.SP, 80);
        vm.load(VReg.A1, VReg.SP, 88);
        vm.load(VReg.A2, VReg.SP, 96);
        vm.mov(VReg.A3, VReg.S4);
        vm.mov(VReg.A4, VReg.S5);
        vm.call("_pcomb_subscribe");
        this.emitExcPop(0);
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_prc_iloop");

        vm.label("_prc_done");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue(SAVED, 160);

        vm.label("_prc_catch");
        this.emitExcPop(0);
        vm.load(VReg.V1, VReg.SP, 144);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_prc_catch_rej");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_pcomb_iter_close");
        vm.label("_prc_catch_rej");
        this.emitTakeException(VReg.S3);
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_promise_attach_terror_proto");
        vm.mov(VReg.A2, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 128);
        vm.cmpImm(VReg.A0, 0);
        vm.jeq("_prc_catch_raw");
        vm.movImm64(VReg.A1, JS_UNDEFINED);
        vm.movImm64(VReg.A3, JS_UNDEFINED);
        vm.movImm(VReg.A4, 1);
        vm.call("_promise_invoke2");
        vm.jmp("_prc_catch_ret");
        vm.label("_prc_catch_raw");
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_promise_reject");
        vm.label("_prc_catch_ret");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue(SAVED, 160);
    }

    // Promise.allSettled(A0=iterable) -> boxed promise
    // [test262] fulfil/reject 各挂 elem 闭包;全部落位后 capResolve(结果数组)。
    generatePromiseAllSettled() {
        const vm = this.vm;
        const SAVED = [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5];
        vm.label("_Promise_allSettled");
        vm.prologue(160, SAVED);
        vm.mov(VReg.S0, VReg.A0);
        this.emitCombinatorPrologue(1, "_pas_catch");

        vm.load(VReg.V1, VReg.SP, 144);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_pas_iter");

        vm.movImm(VReg.S3, 0);
        vm.label("_pas_loop");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_pas_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_get");
        vm.store(VReg.SP, 96, VReg.RET);
        vm.mov(VReg.A0, VReg.S4);
        vm.mov(VReg.A1, VReg.S3);
        vm.movImm(VReg.A2, 0);
        vm.call("_pcomb_make_elem");
        vm.store(VReg.SP, 104, VReg.RET); // onFulfil
        vm.mov(VReg.A0, VReg.S4);
        vm.mov(VReg.A1, VReg.S3);
        vm.movImm(VReg.A2, 1);
        vm.call("_pcomb_make_elem");
        vm.store(VReg.SP, 112, VReg.RET); // onReject
        this.emitExcPush(0, "_pas_catch");
        vm.load(VReg.A0, VReg.SP, 80);
        vm.load(VReg.A1, VReg.SP, 88);
        vm.load(VReg.A2, VReg.SP, 96);
        vm.load(VReg.A3, VReg.SP, 104);
        vm.load(VReg.A4, VReg.SP, 112);
        vm.call("_pcomb_subscribe");
        this.emitExcPop(0);
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_pas_loop");

        vm.label("_pas_iter");
        vm.movImm(VReg.S3, 0);
        vm.label("_pas_iloop");
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.SP, 144, VReg.V1);
        this.emitExcPush(0, "_pas_catch");
        vm.mov(VReg.A0, VReg.S0);
        vm.addImm(VReg.A1, VReg.SP, 96);
        vm.call("_pcomb_iter_step");
        this.emitExcPop(0);
        vm.movImm(VReg.V1, 1);
        vm.store(VReg.SP, 144, VReg.V1);
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_pas_done");
        vm.load(VReg.V1, VReg.S4, 16);
        vm.addImm(VReg.V1, VReg.V1, 1);
        vm.store(VReg.S4, 16, VReg.V1);
        vm.mov(VReg.A0, VReg.S4);
        vm.mov(VReg.A1, VReg.S3);
        vm.movImm(VReg.A2, 0);
        vm.call("_pcomb_make_elem");
        vm.store(VReg.SP, 104, VReg.RET);
        vm.mov(VReg.A0, VReg.S4);
        vm.mov(VReg.A1, VReg.S3);
        vm.movImm(VReg.A2, 1);
        vm.call("_pcomb_make_elem");
        vm.store(VReg.SP, 112, VReg.RET);
        this.emitExcPush(0, "_pas_catch");
        vm.load(VReg.A0, VReg.SP, 80);
        vm.load(VReg.A1, VReg.SP, 88);
        vm.load(VReg.A2, VReg.SP, 96);
        vm.load(VReg.A3, VReg.SP, 104);
        vm.load(VReg.A4, VReg.SP, 112);
        vm.call("_pcomb_subscribe");
        this.emitExcPop(0);
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_pas_iloop");

        vm.label("_pas_done");
        vm.mov(VReg.A0, VReg.S4);
        vm.call("_pcomb_release");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue(SAVED, 160);

        vm.label("_pas_catch");
        this.emitExcPop(0);
        vm.load(VReg.V1, VReg.SP, 144);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_pas_catch_rej");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_pcomb_iter_close");
        vm.label("_pas_catch_rej");
        this.emitTakeException(VReg.S3);
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_promise_attach_terror_proto");
        vm.mov(VReg.A2, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 128);
        vm.cmpImm(VReg.A0, 0);
        vm.jeq("_pas_catch_raw");
        vm.movImm64(VReg.A1, JS_UNDEFINED);
        vm.movImm64(VReg.A3, JS_UNDEFINED);
        vm.movImm(VReg.A4, 1);
        vm.call("_promise_invoke2");
        vm.jmp("_pas_catch_ret");
        vm.label("_pas_catch_raw");
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_promise_reject");
        vm.label("_pas_catch_ret");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue(SAVED, 160);
    }

    // [I2 一等值] _promise_ctor_call - `Promise()` 不带 new(经值路径调用,如
    // `const P=Promise; P(()=>{})`)→ TypeError(规范 27.2.3.1:Promise constructor
    // cannot be invoked without 'new',消息与 Node 逐字一致)。new Promise(executor)
    // 在 compileNewExpression 静态特判 _promise_new,从不落此。message 经
    // emitStringConst(数据段串直接打 0x7FFC tag)交给 _throw_type_error(仅存
    // message 值,与 _promise_reject_type_error 的串表示同容忍度)。
    generatePromiseCtorCall() {
        const vm = this.vm;
        vm.label("_promise_ctor_call");
        vm.prologue(16, [VReg.S0]);
        this.emitStringConst(VReg.A0, "Promise constructor cannot be invoked without 'new'");
        vm.call("_throw_type_error"); // 不返回
        vm.epilogue([VReg.S0], 16);   // 理论不达
    }

    // [I2 红队] 物化 Promise 原型/静态方法值闭包的接收者守卫(成员表
    // PROMISE_PROTO_METHODS/PROMISE_STATIC_METHODS 改指此处标签)。
    // 原型方法经 _aref_generic 蹦床进入(this 插 A0、实参上移);静态经
    // emitBuiltinFnClosure 直连进入(A0-A4 实参、A5=this)。错误接收者此前直读
    // promise 头(SIGSEGV)或静默成功;守卫后按 Node 逐字抛 TypeError。
    // 品牌检查/寄存器纪律(V0/V5 scratch,x64 不别名 A0-A5)/消息构造
    // (_aref_throw_incompat/_aref_throw_not_ctor/_fmt_receiver)见
    // runtime/types/map/index.js 同名守卫组注(标签全局解析)。
    generateArefGuards() {
        const vm = this.vm;
        // 构造器单例槽(数据段 qword,GC 根):静态守卫做 this===%Promise% 身份判,
        // 标签须无条件存在——程序不触裸 Promise 标识符时 members.js 不会登记它,
        // 链接期缺标签即 "Unknown label"。members.js _reEnsureSlot 对运行时
        // 已登记的同名槽查重跳过,不重复定义。[F3] 原型单例槽同理(_fmt_receiver
        // 身份比较与 catch/finally 的 Promise.prototype 特判引用)。
        vm.asm.addDataLabel("_nsobj_promise");
        vm.asm.addDataQword(0);
        vm.asm.addDataLabel("_nsobj_promise_proto");
        vm.asm.addDataQword(0);
        vm.asm.addDataLabel("_errctorref_TypeError");
        vm.asm.addDataQword(0);
        vm.asm.addDataLabel("_errctorref_AggregateError");
        vm.asm.addDataQword(0);

        // ---- _aref_promise_then(A0=this, A1=onF, A2=onR):品牌守卫 → _promise_then2。
        // (WIP 表初值直连 _promise_then 只传单回调,值路径 then.call(p,f,r) 丢
        // onRejected;_promise_then2 双侧归一化,单回调形态语义等价。)
        vm.label("_aref_promise_then");
        vm.shrImm(VReg.V0, VReg.A0, 48);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_apt_chk");
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jne("_apt_bad");
        vm.label("_apt_chk");
        vm.emitMaskLoad(VReg.V5);
        vm.andMaskReg(VReg.V0, VReg.A0, VReg.V5);
        vm.movImm64(VReg.V5, vm.ptrFloor);
        vm.cmp(VReg.V0, VReg.V5);
        vm.jlt("_apt_bad");
        vm.loadByte(VReg.V0, VReg.V0, 0);
        vm.cmpImm(VReg.V0, TYPE_PROMISE);
        vm.jne("_apt_bad");
        vm.jmp("_promise_then_spec");
        vm.label("_apt_bad");
        vm.lea(VReg.A1, vm.asm.addString("Method Promise.prototype.then called on incompatible receiver "));
        vm.movImm64(VReg.V1, TAG_STRING);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.jmp("_aref_throw_incompat");

        // ---- _aref_promise_catch(A0=this, A1=cb):规范 27.2.5.3 `return this.then(
        // undefined, onRejected)` 的接收者语义——
        //   null/undefined → "Cannot read properties of <n> (reading 'then')"
        //     (_throw_read_nullish 既有实现,逐字一致);
        //   其余非 promise → this.then 为 undefined,调之 → "undefined is not a function";
        //   promise → 尾调 _promise_catch。thenable 接收者不展开(记偏差)。
        vm.label("_aref_promise_catch");
        vm.shrImm(VReg.V0, VReg.A0, 48);
        vm.cmpImm(VReg.V0, 0x7FFA);
        vm.jeq("_apcc_nullish");
        vm.cmpImm(VReg.V0, 0x7FFB);
        vm.jeq("_apcc_nullish");
        // [I2 红队 F3] this === Promise.prototype 单例:规范 `this.then(undefined, cb)`
        // 读到真 then 方法(原型自有),其品牌检查按 then 文案抛(Node 实测逐字)。
        vm.lea(VReg.V5, "_nsobj_promise_proto");
        vm.load(VReg.V5, VReg.V5, 0);
        vm.cmp(VReg.V5, VReg.A0);
        vm.jeq("_apcc_thenbad");
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_apcc_chk");
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jne("_apcc_notfn");
        vm.label("_apcc_chk");
        vm.emitMaskLoad(VReg.V5);
        vm.andMaskReg(VReg.V0, VReg.A0, VReg.V5);
        vm.movImm64(VReg.V5, vm.ptrFloor);
        vm.cmp(VReg.V0, VReg.V5);
        vm.jlt("_apcc_notfn");
        vm.loadByte(VReg.V0, VReg.V0, 0);
        vm.cmpImm(VReg.V0, TYPE_PROMISE);
        vm.jne("_apcc_notfn");
        vm.jmp("_promise_catch");
        vm.label("_apcc_nullish");
        vm.lea(VReg.A1, vm.asm.addString("then"));
        vm.movImm64(VReg.V1, TAG_STRING);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.jmp("_throw_read_nullish");    // A0 = 接收者原样,不返回
        vm.label("_apcc_thenbad");
        vm.lea(VReg.A1, vm.asm.addString("Method Promise.prototype.then called on incompatible receiver "));
        vm.movImm64(VReg.V1, TAG_STRING);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.jmp("_aref_throw_incompat");
        vm.label("_apcc_notfn");
        // this 非 null/undefined/非 Promise.prototype/非 Promise 对象。
        // 按规范 Invoke(this, "then", «undefined, onRejected») 走。真函数帧,不用
        // push/pop LR 的手写序言 —— then 的 getter 抛出时那种帧会让 _throw_unwind
        // 落到失衡的栈上(catch/this-value-then-poisoned 曾 SIGBUS)。
        vm.jmp("_promise_catch_invoke");

        // ---- _aref_promise_finally(A0=this, A1=cb):规范 27.2.5.5 步骤 1-2——
        //   Type(this) 非 Object(原语/Symbol/BigInt)→ "Promise.prototype.finally called on non-object";
        //   对象但非 promise → then 为 undefined → "undefined is not a function"
        //   (数组/函数同理;SpeciesConstructor 读取不展开,记偏差);
        //   promise → 尾调 _promise_finally。
        vm.label("_aref_promise_finally");
        vm.shrImm(VReg.V0, VReg.A0, 48);
        // [I2 红队 F3] this === Promise.prototype 单例:规范经 SpeciesConstructor 后
        // Invoke(this, "then") 命中真 then 方法,品牌错按 then 文案抛(同 catch 注)。
        vm.lea(VReg.V5, "_nsobj_promise_proto");
        vm.load(VReg.V5, VReg.V5, 0);
        vm.cmp(VReg.V5, VReg.A0);
        vm.jeq("_apff_thenbad");
        vm.cmpImm(VReg.V0, 0x7FFD);
        vm.jeq("_apff_chk");
        vm.cmpImm(VReg.V0, 0x7FFE);
        vm.jeq("_promise_finally");       // 数组:对象,Invoke then
        vm.cmpImm(VReg.V0, 0x7FFF);
        vm.jeq("_promise_finally");       // 函数:对象,Invoke then
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_apff_nonobj");           // 装箱原语/浮点
        // 裸值:堆界下 → 原语;堆界上 → 裸堆指针(BigInt/Symbol 是原语)
        vm.movImm64(VReg.V0, vm.ptrFloor);
        vm.cmp(VReg.A0, VReg.V0);
        vm.jlt("_apff_nonobj");
        vm.load(VReg.V0, VReg.A0, -16);
        vm.andImm(VReg.V0, VReg.V0, 0xff);
        vm.cmpImm(VReg.V0, 14);           // TYPE_BIGINT([ptr-16] 布局,同 _is_bigint)
        vm.jeq("_apff_nonobj");
        vm.loadByte(VReg.V0, VReg.A0, 0);
        vm.cmpImm(VReg.V0, 61);           // TYPE_SYMBOL
        vm.jeq("_apff_nonobj");
        vm.jmp("_apff_chkbyte");
        vm.label("_apff_chk");
        vm.emitMaskLoad(VReg.V5);
        vm.andMaskReg(VReg.V0, VReg.A0, VReg.V5);
        vm.movImm64(VReg.V5, vm.ptrFloor);
        vm.cmp(VReg.V0, VReg.V5);
        vm.jlt("_apff_notfn");
        vm.loadByte(VReg.V0, VReg.V0, 0);
        vm.label("_apff_chkbyte");
        vm.cmpImm(VReg.V0, TYPE_PROMISE);
        vm.jeq("_promise_finally");
        vm.jmp("_promise_finally"); // 其它对象(含 Proxy):Invoke then,缺 then 由 _pfin_notfn 抛
        vm.label("_apff_nonobj");
        vm.lea(VReg.A0, vm.asm.addString("Promise.prototype.finally called on non-object"));
        vm.movImm64(VReg.V1, TAG_STRING);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.jmp("_throw_type_error");
        vm.label("_apff_thenbad");
        vm.lea(VReg.A1, vm.asm.addString("Method Promise.prototype.then called on incompatible receiver "));
        vm.movImm64(VReg.V1, TAG_STRING);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.jmp("_aref_throw_incompat");
        vm.label("_apff_notfn");
        vm.lea(VReg.A0, vm.asm.addString("undefined is not a function"));
        vm.movImm64(VReg.V1, TAG_STRING);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.jmp("_throw_type_error");

        // ---- 静态守卫:闭包 {magic, fnptr=本守卫} 经值路径调用(`.call(x,…)`/
        // apply/传递后调)时 A5=this。规范要求 this 为构造器 %Promise% 本身:
        //   this === _nsobj_promise 单例 → 纯尾调既有 helper(A0-A4 实参原样);
        //   原语 this(含 Symbol/BigInt)→ "<Name> called on non-object";
        //   函数 this(可构造但非 %Promise%)→ "Promise resolve or reject function is
        //     not callable"(普通函数与 Node 逐字一致;真子类 this 属已记录偏差,
        //     抛 TypeError 即可,不得崩);
        //   其余对象 this → _aref_throw_not_ctor("<fmt> is not a constructor")。
        const staticGuard = (label, helper, nonObjMsg) => {
            vm.label(label);
            vm.lea(VReg.V0, "_nsobj_promise");
            vm.load(VReg.V0, VReg.V0, 0);
            vm.cmp(VReg.V0, VReg.A5);
            vm.jeq(label + "_go");
            vm.shrImm(VReg.V0, VReg.A5, 48);
            vm.cmpImm(VReg.V0, 0x7FFF);
            vm.jeq(label + "_go");          // 装箱函数 -> 接受(规范 NewPromiseCapability 入参可为函数)
            vm.cmpImm(VReg.V0, 0x7FFD);
            vm.jeq(label + "_obj");          // 装箱对象:classinfo(type=3)/闭包放行,其余 not-ctor
            vm.cmpImm(VReg.V0, 0x7FFE);
            vm.jeq(label + "_notctor");     // 装箱数组
            vm.cmpImm(VReg.V0, 0);
            vm.jne(label + "_nonobj");      // 装箱原语/浮点
            // 裸值:堆界下 → 原语;堆界上 → BigInt/Symbol 原语、闭包/classinfo 按构造器
            vm.movImm64(VReg.V0, vm.ptrFloor);
            vm.cmp(VReg.A5, VReg.V0);
            vm.jlt(label + "_nonobj");
            vm.load(VReg.V0, VReg.A5, -16);
            vm.andImm(VReg.V0, VReg.V0, 0xff);
            vm.cmpImm(VReg.V0, 14);         // TYPE_BIGINT
            vm.jeq(label + "_nonobj");
            vm.load(VReg.V0, VReg.A5, 0);
            vm.movImm(VReg.V1, CLOSURE_MAGIC);
            vm.cmp(VReg.V0, VReg.V1);
            vm.jeq(label + "_go");          // 裸闭包指针 -> 接受(规范 NewPromiseCapability 入参可为函数)
            vm.loadByte(VReg.V0, VReg.A5, 0);
            vm.cmpImm(VReg.V0, 3);          // TYPE_FUNCTION classinfo
            vm.jeq(label + "_go");
            vm.cmpImm(VReg.V0, 61);         // TYPE_SYMBOL
            vm.jeq(label + "_nonobj");
            vm.jmp(label + "_notctor");
            vm.label(label + "_obj");
            vm.emitMaskLoad(VReg.V5);
            vm.andMaskReg(VReg.V0, VReg.A5, VReg.V5);
            vm.movImm64(VReg.V5, vm.ptrFloor);
            vm.cmp(VReg.V0, VReg.V5);
            vm.jlt(label + "_notctor");
            vm.loadByte(VReg.V1, VReg.V0, 0);
            vm.cmpImm(VReg.V1, 3);          // class X extends Promise
            vm.jeq(label + "_go");
            vm.load(VReg.V1, VReg.V0, 0);
            vm.movImm(VReg.V0, CLOSURE_MAGIC);
            vm.cmp(VReg.V1, VReg.V0);
            vm.jeq(label + "_go");
            vm.jmp(label + "_notctor");
            vm.label(label + "_go");
            vm.jmp(helper);
            vm.label(label + "_nonobj");
            vm.lea(VReg.A0, vm.asm.addString(nonObjMsg));
            vm.movImm64(VReg.V1, TAG_STRING);
            vm.or(VReg.A0, VReg.A0, VReg.V1);
            vm.jmp("_throw_type_error");
            vm.label(label + "_notcall");
            vm.lea(VReg.A0, vm.asm.addString("Promise resolve or reject function is not callable"));
            vm.movImm64(VReg.V1, TAG_STRING);
            vm.or(VReg.A0, VReg.A0, VReg.V1);
            vm.jmp("_throw_type_error");
            vm.label(label + "_notctor");
            vm.mov(VReg.A0, VReg.A5);
            vm.jmp("_aref_throw_not_ctor");
        };
        staticGuard("_aref_pss_resolve", "_Promise_resolve", "PromiseResolve called on non-object");
        staticGuard("_aref_pss_reject", "_Promise_reject", "PromiseReject called on non-object");
        staticGuard("_aref_pss_all", "_Promise_all", "Promise.all called on non-object");
        staticGuard("_aref_pss_race", "_Promise_race", "Promise.race called on non-object");
        staticGuard("_aref_pss_allSettled", "_Promise_allSettled", "Promise.allSettled called on non-object");
        staticGuard("_aref_pss_any", "_Promise_any", "Promise.any called on non-object");
        staticGuard("_aref_pss_withResolvers", "_Promise_withResolvers", "Promise.withResolvers called on non-object");
        staticGuard("_aref_pss_try", "_Promise_try", "Promise.try called on non-object");
    }
}
