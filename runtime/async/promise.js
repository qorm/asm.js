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

// Handler 节点(24 bytes):
// +0: callback (8 bytes) - 回调函数(tagged 闭包值)
// +8: next_promise (8 bytes) - then/catch 返回的 Promise(boxed)
// +16: next (8 bytes) - 下一个 handler

const TYPE_PROMISE = 11;
const PROMISE_SIZE = 48;
const HANDLER_SIZE = 24;

// resolve/reject 闭包对象(24 bytes): +0 magic, +8 func_ptr, +16 boxed promise
const RESOLVER_SIZE = 24;

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

    generate() {
        this.generatePromiseInvoke1();
        this.generatePromiseInvoke2();
        this.generateMakeResolver();
        this.generateThenableAdopt();
        this.generateReactionQueue();
        this.generateIsPromise();
        this.generateResolverTrampolines();
        this.generatePromiseNew();
        this.generatePromiseResolve();
        this.generatePromiseReject();
        this.generatePromiseThen();
        this.generatePromiseThen2();
        this.generatePromiseCatch();
        this.generatePromiseAwait();
        this.generatePromiseResolveStatic();
        this.generatePromiseRejectStatic();
        this.generatePromiseWithResolvers();
        this.generateMakeSettledResult();
        this.generateCombinatorElem();
        this.generateAppendHandler();
        this.generateAggregateError();
        this.generateCombinatorGuard();
        this.generatePromiseAll();
        this.generatePromiseRace();
        this.generatePromiseAllSettled();
        this.generatePromiseAny();
        this.generatePromiseFinally();
        this.generateBoundTramp();
    }

    // _promise_invoke1(A0=cb, A1=arg) -> RET
    // 调用回调，支持 tagged 闭包值 / 裸闭包指针 / 裸函数指针。cb 为 0 时返回 undefined。
    generatePromiseInvoke1() {
        const vm = this.vm;
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
        vm.mov(VReg.A0, VReg.S1); // arg
        vm.setCallArgcImm(1, VReg.V2, VReg.V3); // [argc ABI] callback(value)
        // [test262] promise 反应回调的 this 必须是 undefined(PromiseReactionJob 用
        // Call(handler, undefined, «arg»))。此前 A5 是调用点残留垃圾,严格模式回调里
        // `this` 读到裸 0 —— rxn-handler-*-invoke-strict 全灭。V4 在 x64 上别名 A5,
        // 故写 A5 必须放在 V1(=A3,函数指针)之后、callIndirect 之前。
        vm.movImm64(VReg.A5, JS_UNDEFINED);
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
    // 闭包布局 {CLOSURE_MAGIC@0, tramp@8, boxed promise@16}(即 RESOLVER_SIZE)。
    // 唯一的 resolver 闭包构造点:_promise_new / _Promise_withResolvers / thenable 采纳
    // / 组合器订阅全部经此,不再各自复制一遍 alloc+store+box 序列。
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
        vm.cmpImm(VReg.S2, 0);
        vm.jne("_pmk_rej");
        vm.lea(VReg.V1, "_promise_resolve_tramp");
        vm.jmp("_pmk_store");
        vm.label("_pmk_rej");
        vm.lea(VReg.V1, "_promise_reject_tramp");
        vm.label("_pmk_store");
        vm.store(VReg.S0, 8, VReg.V1);
        vm.store(VReg.S0, 16, VReg.S1);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_js_box_function");
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

    // resolve/reject 蹦床：S0=闭包对象(裸指针), A0=值
    generateResolverTrampolines() {
        const vm = this.vm;

        vm.label("_promise_resolve_tramp");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S1, VReg.A0); // 值
        vm.load(VReg.A0, VReg.S0, 16); // boxed promise
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_promise_resolve");
        vm.movImm64(VReg.RET, JS_UNDEFINED);
        vm.epilogue([VReg.S0, VReg.S1], 16);

        vm.label("_promise_reject_tramp");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S1, VReg.A0);
        vm.load(VReg.A0, VReg.S0, 16);
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

        // box promise -> S2
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_js_box_object");
        vm.mov(VReg.S2, VReg.RET);

        // 无 executor：直接返回
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_pn_done");

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

        vm.label("_pn_done");
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
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_is_promise");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_pr_adopt_promise");

        // [test262] 非 promise 的 thenable(带可调用 then 的普通对象)必须被采纳:
        // 规范 25.6.1.3.2 步骤 8-9。then 只查一次,查得的函数原样交给采纳例程。
        vm.shrImm(VReg.V1, VReg.S1, 48);
        vm.movImm(VReg.V0, 0x7ffd);
        vm.cmp(VReg.V1, VReg.V0);
        vm.jne("_pr_settle");
        // [test262] `then` 的**读取**本身可能抛(访问器 getter:resolve-poisoned-then),
        // 规范要求以抛出值 reject 而不是穿透成进程级未捕获 → 查找放在异常帧内。
        this.emitExcPush(0, "_pr_then_throw");
        vm.mov(VReg.A0, VReg.S1);
        this.emitStringConst(VReg.A1, "then");
        vm.call("_object_get");
        vm.mov(VReg.A1, VReg.S1);  // this = thenable
        vm.mov(VReg.A0, VReg.RET); // _object_get 返回的可能是 getter 标记对象
        vm.call("_maybe_getter");  // 解包访问器(数据属性原样返回)
        this.emitExcPop(0);
        vm.mov(VReg.S2, VReg.RET);
        vm.shrImm(VReg.V1, VReg.S2, 48);
        vm.movImm(VReg.V0, 0x7fff); // TAG_FUNCTION —— then 不可调用时按普通值结算
        vm.cmp(VReg.V1, VReg.V0);
        vm.jne("_pr_settle");
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
        // 已 reject 且只提供 onFulfilled：把拒因传递给 next
        vm.mov(VReg.A0, VReg.S2);
        vm.load(VReg.A1, VReg.S0, 16);
        vm.call("_promise_reject");
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

    // _promise_catch(A0=promise, A1=cb) -> boxed next promise
    generatePromiseCatch() {
        const vm = this.vm;

        vm.label("_promise_catch");
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
        // fulfilled：值透传给 next
        vm.load(VReg.V1, VReg.S0, 16);
        vm.mov(VReg.A0, VReg.S2);
        vm.mov(VReg.A1, VReg.V1);
        vm.call("_promise_resolve");
        vm.mov(VReg.RET, VReg.S2);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);
    }

    // _promise_await(A0=promise) -> value
    // 被 reject 时设置 _exception_pending/_exception_value，返回 undefined。
    generatePromiseAwait() {
        const vm = this.vm;

        vm.label("_promise_await");
        vm.prologue(32, [VReg.S0, VReg.S1]);
        vm.call("_js_unbox"); // A0=promise -> 裸
        vm.mov(VReg.S0, VReg.RET);

        vm.load(VReg.V1, VReg.S0, 8);
        vm.cmpImm(VReg.V1, PROMISE_FULFILLED);
        vm.jeq("_paw_ful");
        vm.cmpImm(VReg.V1, PROMISE_REJECTED);
        vm.jeq("_paw_rej");

        // pending：挂起当前协程
        vm.lea(VReg.S1, "_scheduler_current");
        vm.load(VReg.S1, VReg.S1, 0);
        vm.store(VReg.S0, 40, VReg.S1);
        vm.call("_coroutine_yield");
        // 恢复后重新判定
        vm.load(VReg.V1, VReg.S0, 8);
        vm.cmpImm(VReg.V1, PROMISE_REJECTED);
        vm.jeq("_paw_rej");

        vm.label("_paw_ful");
        vm.load(VReg.RET, VReg.S0, 16);
        vm.epilogue([VReg.S0, VReg.S1], 32);

        vm.label("_paw_rej");
        vm.load(VReg.S1, VReg.S0, 16); // reason
        vm.lea(VReg.V0, "_exception_value");
        vm.store(VReg.V0, 0, VReg.S1);
        vm.lea(VReg.V0, "_exception_pending");
        vm.movImm(VReg.V1, 1);
        vm.store(VReg.V0, 0, VReg.V1);
        vm.movImm64(VReg.RET, JS_UNDEFINED);
        vm.epilogue([VReg.S0, VReg.S1], 32);
    }

    // Promise.resolve(value) -> boxed promise
    generatePromiseResolveStatic() {
        const vm = this.vm;
        vm.label("_Promise_resolve");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        // 若入参本身是 promise，直接返回它
        vm.mov(VReg.S0, VReg.A0);
        vm.call("_is_promise");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_prs_new");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1], 16);
        vm.label("_prs_new");
        vm.movImm(VReg.A0, 0);
        vm.call("_promise_new");
        vm.mov(VReg.S1, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_promise_resolve");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1], 16);
    }

    // Promise.reject(reason) -> boxed promise
    generatePromiseRejectStatic() {
        const vm = this.vm;
        vm.label("_Promise_reject");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);
        vm.movImm(VReg.A0, 0);
        vm.call("_promise_new");
        vm.mov(VReg.S1, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_promise_reject");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1], 16);
    }

    // [ES2024] Promise.withResolvers() -> boxed { promise, resolve, reject }
    // pending promise + 两个绑定到它的 resolve/reject 一等函数(闭包布局
    // [CLOSURE_MAGIC@0, tramp@8, boxed_promise@16],复用既有 _promise_*_tramp)。
    // resolve/reject 走 #74 后的 _promise_resolve/reject,天然获得微任务延迟语义。
    generatePromiseWithResolvers() {
        const vm = this.vm;
        vm.label("_Promise_withResolvers");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);

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

    // ==================== [test262] 组合器的异步元素订阅 ====================
    // all/race/any/allSettled 此前是"同步 settled 快照"模型:遍历数组、直接读每个
    // 元素 promise 的 status/value 定案。凡输入含 pending promise(test262 里绝大多数
    // 用例都是先建 pending、稍后 resolve),结果就错到根上 —— all 回填裸 0、race 永远
    // 不结算、allSettled 把 pending 记成 fulfilled。
    //
    // 新模型按规范逐元素订阅:p = Promise.resolve(e);p.then(onFulfil, onReject)。
    // 四个组合器共享一份状态记录与一个元素回调蹦床,靠 mode/kind 分派:
    //   state(32B): {boxed 结果 promise@0, boxed 结果数组@8, remaining@16(裸), mode@24}
    //     mode 0=all、1=allSettled、2=any
    //   elem 闭包(40B): {CLOSURE_MAGIC@0, _pcomb_elem_tramp@8, state@16, index@24, kind@32}
    //     kind 0=fulfil、1=reject
    // remaining 初值 n+1(规范的 remainingElementsCount 同款技巧):循环结束再减 1,
    // 保证空数组/同步结算的元素不会在挂完所有订阅前提前定案。
    generateCombinatorElem() {
        const vm = this.vm;

        // _pcomb_make_elem(A0=state 裸指针, A1=index, A2=kind) -> RET boxed 一等函数
        vm.label("_pcomb_make_elem");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S1, VReg.A0);
        vm.mov(VReg.S2, VReg.A1);
        vm.mov(VReg.S3, VReg.A2);
        vm.movImm(VReg.A0, 40);
        vm.call("_alloc");
        vm.mov(VReg.S0, VReg.RET);
        vm.movImm(VReg.V1, CLOSURE_MAGIC);
        vm.store(VReg.S0, 0, VReg.V1);
        vm.lea(VReg.V1, "_pcomb_elem_tramp");
        vm.store(VReg.S0, 8, VReg.V1);
        vm.store(VReg.S0, 16, VReg.S1);
        vm.store(VReg.S0, 24, VReg.S2);
        vm.store(VReg.S0, 32, VReg.S3);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_js_box_function");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);

        // 元素回调蹦床:S0 = elem 闭包裸指针(闭包调用约定), A0 = 结算值
        vm.label("_pcomb_elem_tramp");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        vm.mov(VReg.S1, VReg.A0);     // value
        vm.load(VReg.S2, VReg.S0, 16); // state
        vm.load(VReg.S3, VReg.S0, 24); // index
        vm.load(VReg.S4, VReg.S0, 32); // kind
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
        // _pcomb_finish_call(A0=state) 从组合器主体进入。
        vm.label("_pcomb_finish");
        vm.load(VReg.V1, VReg.S2, 24);
        vm.cmpImm(VReg.V1, 2);
        vm.jeq("_pce_fin_any");
        vm.load(VReg.A0, VReg.S2, 0);
        vm.load(VReg.A1, VReg.S2, 8);
        vm.call("_promise_resolve");
        vm.jmp("_pce_ret");
        vm.label("_pce_fin_any"); // any 全 reject -> AggregateError(errors)
        vm.load(VReg.A0, VReg.S2, 8);
        vm.call("_promise_make_aggregate_error");
        vm.mov(VReg.S1, VReg.RET);
        vm.load(VReg.A0, VReg.S2, 0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_promise_reject");
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
        vm.lea(VReg.V0, "_js_true");
        vm.load(VReg.A2, VReg.V0, 0);
        vm.call("_object_define");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1], 32);
    }

    // 组合器公共序幕(S0=输入数组已就位):建结果 promise -> S1、非数组守卫、
    // 取长度 -> S2、建结果数组(boxed 0x7FFE)与 state 记录 -> S4、remaining=n+1。
    // mode 由参数写入 state+24。notIterLabel 为非数组时的跳转目标。
    emitCombinatorPrologue(mode, notIterLabel) {
        const vm = this.vm;
        vm.movImm(VReg.A0, 0);
        vm.call("_promise_new");
        vm.mov(VReg.S1, VReg.RET); // 结果 promise
        vm.shrImm(VReg.V1, VReg.S0, 48);
        vm.cmpImm(VReg.V1, 0x7FFE);
        vm.jne(notIterLabel);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.mov(VReg.S2, VReg.RET); // n
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_array_new_with_size");
        vm.movImm64(VReg.V1, MASK48);
        vm.and(VReg.V0, VReg.RET, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffe000000000000n);
        vm.or(VReg.S3, VReg.V0, VReg.V1); // boxed 结果数组
        vm.movImm(VReg.A0, 32);
        vm.call("_alloc");
        vm.mov(VReg.S4, VReg.RET); // state
        vm.store(VReg.S4, 0, VReg.S1);
        vm.store(VReg.S4, 8, VReg.S3);
        vm.addImm(VReg.V1, VReg.S2, 1);
        vm.store(VReg.S4, 16, VReg.V1); // remaining = n + 1
        vm.movImm(VReg.V1, mode);
        vm.store(VReg.S4, 24, VReg.V1);
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
        // reject(result, errObj)
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_promise_reject");
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);

        // 组合器守卫:非数组参数 → 以 TypeError 拒绝结果 promise
        vm.label("_combinator_reject_notiterable");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.lea(VReg.A1, vm.asm.addString("argument is not iterable")); boxStr(VReg.A1);
        vm.call("_promise_reject_type_error"); // A0 原样透传
        vm.epilogue([VReg.S0, VReg.S1], 16);
    }

    // Promise.all(A0=array) -> boxed promise
    // [test262] 按规范逐元素订阅(见 generateCombinatorElem 顶部注释):
    //   p = Promise.resolve(e); p.then(elem(i, fulfil), reject(result))
    // 全部 fulfil -> resolve 结果数组;任一 reject -> 以其拒因 reject 结果 promise。
    generatePromiseAll() {
        const vm = this.vm;
        const SAVED = [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5];
        vm.label("_Promise_all");
        vm.prologue(48, SAVED);
        vm.mov(VReg.S0, VReg.A0); // 输入数组
        this.emitCombinatorPrologue(0, "_pall_notiter");
        // 共享 reject:任一元素失败即整体失败
        vm.mov(VReg.A0, VReg.S1);
        vm.movImm(VReg.A1, 1);
        vm.call("_promise_make_resolver");
        vm.mov(VReg.S5, VReg.RET);

        vm.movImm(VReg.S3, 0); // i
        vm.label("_pall_loop");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_pall_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_Promise_resolve"); // 非 promise/thenable 一律包成 promise
        vm.store(VReg.SP, 0, VReg.RET); // p 溢出到局部区(S 寄存器已用尽)
        vm.mov(VReg.A0, VReg.S4);
        vm.mov(VReg.A1, VReg.S3);
        vm.movImm(VReg.A2, 0);
        vm.call("_pcomb_make_elem");
        vm.mov(VReg.A1, VReg.RET); // onFulfil(先搬走:arm64 上 RET 与 A0 同寄存器)
        vm.load(VReg.A0, VReg.SP, 0);
        vm.mov(VReg.A2, VReg.S5);
        vm.call("_promise_then2");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_pall_loop");

        vm.label("_pall_done");
        vm.mov(VReg.A0, VReg.S4);
        vm.call("_pcomb_release");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue(SAVED, 48);

        vm.label("_pall_notiter");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_combinator_reject_notiterable");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue(SAVED, 48);
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
    }

    // [#35] Promise.any(A0=array) -> boxed promise
    // [test262] 逐元素订阅:首个 fulfil 直接 resolve 结果 promise;每个 reject 把
    // 拒因按下标存进 errors 数组并递减 remaining,归零(全 reject)时以
    // AggregateError{name,message,errors} reject。
    generatePromiseAny() {
        const vm = this.vm;
        const SAVED = [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5];
        vm.label("_Promise_any");
        vm.prologue(48, SAVED);
        vm.mov(VReg.S0, VReg.A0);
        this.emitCombinatorPrologue(2, "_pany_notiter");
        // 共享 resolve:任一元素成功即整体成功
        vm.mov(VReg.A0, VReg.S1);
        vm.movImm(VReg.A1, 0);
        vm.call("_promise_make_resolver");
        vm.mov(VReg.S5, VReg.RET);

        vm.movImm(VReg.S3, 0);
        vm.label("_pany_loop");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_pany_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_Promise_resolve");
        vm.store(VReg.SP, 0, VReg.RET);
        vm.mov(VReg.A0, VReg.S4);
        vm.mov(VReg.A1, VReg.S3);
        vm.movImm(VReg.A2, 1);
        vm.call("_pcomb_make_elem");
        vm.mov(VReg.A2, VReg.RET); // onReject(先搬走:arm64 上 RET 与 A0 同寄存器)
        vm.load(VReg.A0, VReg.SP, 0);
        vm.mov(VReg.A1, VReg.S5);
        vm.call("_promise_then2");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_pany_loop");

        vm.label("_pany_done");
        vm.mov(VReg.A0, VReg.S4);
        vm.call("_pcomb_release");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue(SAVED, 48);

        vm.label("_pany_notiter");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_combinator_reject_notiterable");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue(SAVED, 48);
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
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S0, VReg.A0); // 原 promise(boxed)
        vm.mov(VReg.S1, VReg.A1); // cb
        vm.mov(VReg.A0, VReg.S1);
        vm.movImm(VReg.A1, 0);
        vm.call("_pfin_make");
        vm.mov(VReg.S2, VReg.RET); // onFulfil
        vm.mov(VReg.A0, VReg.S1);
        vm.movImm(VReg.A1, 1);
        vm.call("_pfin_make");
        vm.mov(VReg.S3, VReg.RET); // onReject
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S2);
        vm.mov(VReg.A2, VReg.S3);
        vm.call("_promise_then2");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);

        // _pfin_make(A0=cb, A1=kind) -> RET boxed 一等函数
        vm.label("_pfin_make");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2]);
        vm.mov(VReg.S1, VReg.A0);
        vm.mov(VReg.S2, VReg.A1);
        vm.movImm(VReg.A0, 32);
        vm.call("_alloc");
        vm.mov(VReg.S0, VReg.RET);
        vm.movImm(VReg.V1, CLOSURE_MAGIC);
        vm.store(VReg.S0, 0, VReg.V1);
        vm.lea(VReg.V1, "_pfin_tramp");
        vm.store(VReg.S0, 8, VReg.V1);
        vm.store(VReg.S0, 16, VReg.S1);
        vm.store(VReg.S0, 24, VReg.S2);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_js_box_function");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);

        // finally 回调蹦床:S0 = 闭包裸指针, A0 = 结算值
        vm.label("_pfin_tramp");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S1, VReg.A0);      // value/reason
        vm.load(VReg.S2, VReg.S0, 16); // cb
        vm.load(VReg.S3, VReg.S0, 24); // kind
        vm.mov(VReg.A0, VReg.S2);
        vm.movImm64(VReg.A1, JS_UNDEFINED); // this
        vm.movImm64(VReg.A2, JS_UNDEFINED);
        vm.movImm64(VReg.A3, JS_UNDEFINED);
        vm.movImm(VReg.A4, 0); // [argc ABI] onFinally 收零实参
        vm.call("_promise_invoke2");
        vm.cmpImm(VReg.S3, 0);
        vm.jne("_pfin_rethrow");
        vm.mov(VReg.RET, VReg.S1); // fulfil:原值透传
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);
        vm.label("_pfin_rethrow");
        vm.lea(VReg.V0, "_exception_value");
        vm.store(VReg.V0, 0, VReg.S1);
        vm.lea(VReg.V0, "_exception_pending");
        vm.movImm(VReg.V1, 1);
        vm.store(VReg.V0, 0, VReg.V1);
        vm.call("_throw_unwind"); // 不返回:drain 的异常帧以原拒因拒绝派生 promise
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32); // 理论不达
    }

    // Promise.race(A0=array) -> boxed promise
    // [test262] 逐元素订阅同一对 resolve/reject:首个结算者胜出(后续 settle 被
    // _promise_resolve/_promise_reject 的已结算守卫忽略)。空数组永远 pending(合规)。
    generatePromiseRace() {
        const vm = this.vm;
        const SAVED = [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5];
        vm.label("_Promise_race");
        vm.prologue(48, SAVED);
        vm.mov(VReg.S0, VReg.A0);
        vm.movImm(VReg.A0, 0);
        vm.call("_promise_new");
        vm.mov(VReg.S1, VReg.RET);
        // [test262] 参数守卫:非数组(tag != 0x7FFE)→ reject TypeError,不解引用
        vm.shrImm(VReg.V1, VReg.S0, 48);
        vm.cmpImm(VReg.V1, 0x7FFE);
        vm.jne("_prc_notiter");
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.mov(VReg.S2, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.movImm(VReg.A1, 0);
        vm.call("_promise_make_resolver");
        vm.mov(VReg.S4, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.movImm(VReg.A1, 1);
        vm.call("_promise_make_resolver");
        vm.mov(VReg.S5, VReg.RET);

        vm.movImm(VReg.S3, 0);
        vm.label("_prc_loop");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_prc_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_Promise_resolve");
        vm.mov(VReg.A0, VReg.RET);
        vm.mov(VReg.A1, VReg.S4);
        vm.mov(VReg.A2, VReg.S5);
        vm.call("_promise_then2");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_prc_loop");

        vm.label("_prc_done");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue(SAVED, 48);

        vm.label("_prc_notiter");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_combinator_reject_notiterable");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue(SAVED, 48);
    }

    // Promise.allSettled(A0=array) -> boxed promise (resolve 结果数组)
    // [test262] 逐元素订阅,fulfil/reject 两条链各挂一个 elem 闭包(kind 决定
    // {status:"fulfilled",value} 还是 {status:"rejected",reason});全部落位后 resolve。
    generatePromiseAllSettled() {
        const vm = this.vm;
        const SAVED = [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5];
        vm.label("_Promise_allSettled");
        vm.prologue(48, SAVED);
        vm.mov(VReg.S0, VReg.A0);
        this.emitCombinatorPrologue(1, "_pas_notiter");

        vm.movImm(VReg.S3, 0);
        vm.label("_pas_loop");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_pas_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_Promise_resolve");
        vm.store(VReg.SP, 0, VReg.RET); // p
        vm.mov(VReg.A0, VReg.S4);
        vm.mov(VReg.A1, VReg.S3);
        vm.movImm(VReg.A2, 0);
        vm.call("_pcomb_make_elem");
        vm.store(VReg.SP, 8, VReg.RET); // onFulfil
        vm.mov(VReg.A0, VReg.S4);
        vm.mov(VReg.A1, VReg.S3);
        vm.movImm(VReg.A2, 1);
        vm.call("_pcomb_make_elem");
        vm.mov(VReg.A2, VReg.RET); // onReject(先搬走:arm64 上 RET 与 A0 同寄存器)
        vm.load(VReg.A0, VReg.SP, 0);
        vm.load(VReg.A1, VReg.SP, 8);
        vm.call("_promise_then2");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_pas_loop");

        vm.label("_pas_done");
        vm.mov(VReg.A0, VReg.S4);
        vm.call("_pcomb_release");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue(SAVED, 48);

        vm.label("_pas_notiter");
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_combinator_reject_notiterable");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue(SAVED, 48);
    }
}
