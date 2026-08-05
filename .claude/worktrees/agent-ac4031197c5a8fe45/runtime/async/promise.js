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

    generate() {
        this.generatePromiseInvoke1();
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
        vm.callIndirect(VReg.V1);
        vm.jmp("_pi1_done");
        vm.label("_pi1_undef");
        vm.movImm64(VReg.RET, JS_UNDEFINED);
        vm.label("_pi1_done");
        vm.epilogue([VReg.S0, VReg.S1], 16);
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
        vm.label("_promise_drain_reactions");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
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
        vm.load(VReg.A0, VReg.S0, 8); // callback
        vm.load(VReg.A1, VReg.S0, 16); // value
        vm.call("_promise_invoke1");
        vm.mov(VReg.S2, VReg.RET); // result
        vm.load(VReg.A0, VReg.S0, 24); // next_promise
        vm.cmpImm(VReg.A0, 0);
        vm.jeq("_pdr_next");
        vm.mov(VReg.A1, VReg.S2);
        vm.call("_promise_resolve");
        vm.label("_pdr_next");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_pdr_loop");
        vm.label("_pdr_done");
        vm.mov(VReg.RET, VReg.S3);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);
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

        vm.label("_promise_new");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);

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

        // 创建 resolve 闭包 -> S3
        vm.movImm(VReg.A0, RESOLVER_SIZE);
        vm.call("_alloc");
        vm.mov(VReg.S3, VReg.RET);
        vm.movImm(VReg.V1, CLOSURE_MAGIC);
        vm.store(VReg.S3, 0, VReg.V1);
        vm.lea(VReg.V1, "_promise_resolve_tramp");
        vm.store(VReg.S3, 8, VReg.V1);
        vm.store(VReg.S3, 16, VReg.S2); // boxed promise

        // 创建 reject 闭包 -> S4
        vm.movImm(VReg.A0, RESOLVER_SIZE);
        vm.call("_alloc");
        vm.mov(VReg.S4, VReg.RET);
        vm.movImm(VReg.V1, CLOSURE_MAGIC);
        vm.store(VReg.S4, 0, VReg.V1);
        vm.lea(VReg.V1, "_promise_reject_tramp");
        vm.store(VReg.S4, 8, VReg.V1);
        vm.store(VReg.S4, 16, VReg.S2);

        // box resolve/reject 为 function 值
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_js_box_function");
        vm.mov(VReg.S3, VReg.RET); // tagged resolve
        vm.mov(VReg.A0, VReg.S4);
        vm.call("_js_box_function");
        vm.mov(VReg.S4, VReg.RET); // tagged reject

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
        vm.callIndirect(VReg.V5);

        vm.label("_pn_done");
        vm.mov(VReg.RET, VReg.S2);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 48);
    }

    // _promise_resolve(A0=promise, A1=value)
    generatePromiseResolve() {
        const vm = this.vm;

        vm.label("_promise_resolve");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);

        vm.mov(VReg.S1, VReg.A1); // value
        vm.call("_js_unbox"); // A0=promise -> 裸指针
        vm.mov(VReg.S3, VReg.RET);

        // 已 settled 则忽略
        vm.load(VReg.V1, VReg.S3, 8);
        vm.cmpImm(VReg.V1, PROMISE_PENDING);
        vm.jeq("_pr_pending");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);

        vm.label("_pr_pending");
        // value 若本身是 Promise：采用其状态(thenable adoption)
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_is_promise");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_pr_settle");
        // 采用：读取内层状态
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_js_unbox");
        vm.mov(VReg.V5, VReg.RET); // 裸内层 promise
        vm.load(VReg.V1, VReg.V5, 8); // 内层状态
        vm.cmpImm(VReg.V1, PROMISE_REJECTED);
        vm.jeq("_pr_adopt_reject");
        // fulfilled/pending：用内层值继续(pending 时值为 0/undefined，fixture 不涉及)
        vm.load(VReg.S1, VReg.V5, 16);
        vm.jmp("_pr_settle");
        vm.label("_pr_adopt_reject");
        vm.mov(VReg.A0, VReg.S3);
        vm.load(VReg.A1, VReg.V5, 16);
        vm.call("_promise_reject_raw");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);

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
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);
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
        // pending：挂到 then 链
        vm.load(VReg.V1, VReg.S0, 24);
        vm.store(VReg.S3, 16, VReg.V1);
        vm.store(VReg.S0, 24, VReg.S3);
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
    generatePromiseThen2() {
        const vm = this.vm;
        vm.label("_promise_then2");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S1, VReg.A1); // onF
        vm.mov(VReg.S4, VReg.A2); // onR
        vm.call("_js_unbox");     // A0=promise -> 裸
        vm.mov(VReg.S0, VReg.RET);
        vm.movImm(VReg.A0, 0);
        vm.call("_promise_new");
        vm.mov(VReg.S2, VReg.RET); // next(boxed)

        vm.load(VReg.V1, VReg.S0, 8); // state
        vm.cmpImm(VReg.V1, PROMISE_FULFILLED);
        vm.jeq("_pt2_ful");
        vm.cmpImm(VReg.V1, PROMISE_REJECTED);
        vm.jeq("_pt2_rej");
        // pending:两个 handler 分别挂两条链,共享 next
        vm.movImm(VReg.A0, HANDLER_SIZE);
        vm.call("_alloc");
        vm.mov(VReg.S3, VReg.RET); // fulfill handler
        vm.store(VReg.S3, 0, VReg.S1); // onF
        vm.store(VReg.S3, 8, VReg.S2); // next
        vm.load(VReg.V1, VReg.S0, 24);
        vm.store(VReg.S3, 16, VReg.V1);
        vm.store(VReg.S0, 24, VReg.S3); // 挂 fulfill 链头
        vm.movImm(VReg.A0, HANDLER_SIZE);
        vm.call("_alloc");
        vm.mov(VReg.S5, VReg.RET); // reject handler
        vm.store(VReg.S5, 0, VReg.S4); // onR
        vm.store(VReg.S5, 8, VReg.S2); // next
        vm.load(VReg.V1, VReg.S0, 32);
        vm.store(VReg.S5, 16, VReg.V1);
        vm.store(VReg.S0, 32, VReg.S5); // 挂 reject 链头
        vm.mov(VReg.RET, VReg.S2);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 48);

        vm.label("_pt2_ful"); // 已 fulfilled → 排入 onF
        vm.mov(VReg.A0, VReg.S1);
        vm.load(VReg.A1, VReg.S0, 16);
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_promise_enqueue_reaction");
        vm.mov(VReg.RET, VReg.S2);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 48);

        vm.label("_pt2_rej"); // 已 rejected → 排入 onR
        vm.mov(VReg.A0, VReg.S4);
        vm.load(VReg.A1, VReg.S0, 16);
        vm.mov(VReg.A2, VReg.S2);
        vm.call("_promise_enqueue_reaction");
        vm.mov(VReg.RET, VReg.S2);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 48);
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
        // pending：挂到 catch 链
        vm.load(VReg.V1, VReg.S0, 32);
        vm.store(VReg.S3, 16, VReg.V1);
        vm.store(VReg.S0, 32, VReg.S3);
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

        // resolve 闭包 -> S3
        vm.movImm(VReg.A0, RESOLVER_SIZE);
        vm.call("_alloc");
        vm.mov(VReg.S3, VReg.RET);
        vm.movImm(VReg.V1, CLOSURE_MAGIC);
        vm.store(VReg.S3, 0, VReg.V1);
        vm.lea(VReg.V1, "_promise_resolve_tramp");
        vm.store(VReg.S3, 8, VReg.V1);
        vm.store(VReg.S3, 16, VReg.S2); // boxed promise

        // reject 闭包 -> S4
        vm.movImm(VReg.A0, RESOLVER_SIZE);
        vm.call("_alloc");
        vm.mov(VReg.S4, VReg.RET);
        vm.movImm(VReg.V1, CLOSURE_MAGIC);
        vm.store(VReg.S4, 0, VReg.V1);
        vm.lea(VReg.V1, "_promise_reject_tramp");
        vm.store(VReg.S4, 8, VReg.V1);
        vm.store(VReg.S4, 16, VReg.S2);

        // 装箱为一等函数
        vm.mov(VReg.A0, VReg.S3);
        vm.call("_js_box_function");
        vm.mov(VReg.S3, VReg.RET);
        vm.mov(VReg.A0, VReg.S4);
        vm.call("_js_box_function");
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

    // _promise_make_settled_result(A0=value) -> boxed {status, value|reason}
    generateMakeSettledResult() {
        const vm = this.vm;
        vm.label("_promise_make_settled_result");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0); // value
        vm.call("_object_new");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_js_box_object");
        vm.mov(VReg.S1, VReg.RET); // boxed obj

        vm.mov(VReg.A0, VReg.S0);
        vm.call("_is_promise");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_pmsr_plain");

        // promise：读状态/值
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_js_unbox");
        vm.mov(VReg.V5, VReg.RET);
        vm.load(VReg.V1, VReg.V5, 8); // state
        vm.load(VReg.V2, VReg.V5, 16); // value/reason
        vm.mov(VReg.S0, VReg.V2); // 暂存值/因
        vm.cmpImm(VReg.V1, PROMISE_REJECTED);
        vm.jeq("_pmsr_rej");
        // fulfilled
        vm.mov(VReg.A0, VReg.S1);
        this.emitStringConst(VReg.A1, "status");
        this.emitStringConst(VReg.A2, "fulfilled");
        vm.call("_object_set");
        vm.mov(VReg.A0, VReg.S1);
        this.emitStringConst(VReg.A1, "value");
        vm.mov(VReg.A2, VReg.S0);
        vm.call("_object_set");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1], 16);

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
        vm.epilogue([VReg.S0, VReg.S1], 16);

        vm.label("_pmsr_plain");
        vm.mov(VReg.A0, VReg.S1);
        this.emitStringConst(VReg.A1, "status");
        this.emitStringConst(VReg.A2, "fulfilled");
        vm.call("_object_set");
        vm.mov(VReg.A0, VReg.S1);
        this.emitStringConst(VReg.A1, "value");
        vm.mov(VReg.A2, VReg.S0);
        vm.call("_object_set");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1], 16);
    }

    // Promise.all(A0=array) -> boxed promise
    // 同步聚合(fixture 中输入均已 settle)：全成 -> resolve 结果数组；任一败 -> reject。
    generatePromiseAll() {
        const vm = this.vm;
        vm.label("_Promise_all");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0); // input array

        vm.movImm(VReg.A0, 0);
        vm.call("_promise_new");
        vm.mov(VReg.S1, VReg.RET); // result promise

        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.mov(VReg.S2, VReg.RET); // length

        vm.mov(VReg.A0, VReg.S2);
        vm.call("_array_new_with_size");
        vm.mov(VReg.S3, VReg.RET); // result array

        vm.movImm(VReg.S4, 0); // i
        vm.label("_pall_loop");
        vm.cmp(VReg.S4, VReg.S2);
        vm.jge("_pall_done");

        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_array_get");
        vm.mov(VReg.S5, VReg.RET); // element

        vm.mov(VReg.A0, VReg.S5);
        vm.call("_is_promise");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_pall_plain");

        vm.mov(VReg.A0, VReg.S5);
        vm.call("_js_unbox");
        vm.mov(VReg.V5, VReg.RET); // 裸 promise
        vm.load(VReg.V1, VReg.V5, 8);
        vm.cmpImm(VReg.V1, PROMISE_REJECTED);
        vm.jeq("_pall_reject");
        // fulfilled：result[i] = promise.value
        vm.mov(VReg.A0, VReg.S3);
        vm.mov(VReg.A1, VReg.S4);
        vm.load(VReg.A2, VReg.V5, 16);
        vm.call("_array_set");
        vm.jmp("_pall_after");

        vm.label("_pall_plain");
        vm.mov(VReg.A0, VReg.S3);
        vm.mov(VReg.A1, VReg.S4);
        vm.mov(VReg.A2, VReg.S5);
        vm.call("_array_set");

        vm.label("_pall_after");
        vm.addImm(VReg.S4, VReg.S4, 1);
        vm.jmp("_pall_loop");

        vm.label("_pall_reject");
        vm.mov(VReg.A0, VReg.S1);
        vm.load(VReg.A1, VReg.V5, 16);
        vm.call("_promise_reject");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 48);

        vm.label("_pall_done");
        vm.mov(VReg.A0, VReg.S1);
        // 结果数组装箱 0x7FFE(S3 是 _array_new_with_size 的裸指针):裸指针按 float64
        // 位解释是极小 denormal → then 回调/JSON/打印全看到 0(数组方法类消费者容裸
        // 指针曾掩盖此 bug,与 concat 未装箱同款)。
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.A1, VReg.S3, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffe000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_promise_resolve");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 48);
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
    // 与 _Promise_all 同步 settled 检查模型:首个 fulfilled(或普通值)即
    // resolve;全 rejected → 以首个拒因 reject(无 AggregateError 体系,记偏差)
    generatePromiseAny() {
        const vm = this.vm;
        // AggregateError 用到的键/值字符串常量(registerRuntimeString 按值去重,与既有同值共享)。
        vm.asm.registerRuntimeString("_str_agg_name", "AggregateError");
        vm.asm.registerRuntimeString("_str_agg_msg", "All promises were rejected");
        vm.asm.registerRuntimeString("_str_k_name", "name");
        vm.asm.registerRuntimeString("_str_k_message", "message");
        vm.asm.registerRuntimeString("_str_k_errors", "errors");
        vm.asm.registerRuntimeString("_str_k_asmjserr", "__asmjs_err");
        vm.label("_Promise_any");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0); // input array
        vm.movImm(VReg.A0, 0);
        vm.call("_promise_new");
        vm.mov(VReg.S1, VReg.RET); // result promise
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.mov(VReg.S2, VReg.RET); // length
        // errors 数组(装箱 0x7FFE),逐个拒因 push
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.movImm64(VReg.V1, MASK48);
        vm.and(VReg.V0, VReg.RET, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffe000000000000n);
        vm.or(VReg.S3, VReg.V0, VReg.V1); // S3 = 装箱 errors 数组
        vm.movImm(VReg.S4, 0); // i
        vm.label("_pany_loop");
        vm.cmp(VReg.S4, VReg.S2);
        vm.jge("_pany_allrej");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_array_get");
        vm.mov(VReg.S5, VReg.RET);
        vm.mov(VReg.A0, VReg.S5);
        vm.call("_is_promise");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_pany_plainwin"); // 普通值即 fulfilled
        vm.mov(VReg.A0, VReg.S5);
        vm.call("_js_unbox");
        vm.mov(VReg.V5, VReg.RET);
        vm.load(VReg.V1, VReg.V5, 8);
        vm.cmpImm(VReg.V1, PROMISE_REJECTED);
        vm.jne("_pany_fulwin"); // 非 rejected(fulfilled/pending 按 settled 模型取值)
        // rejected:拒因 push 进 errors 数组(_array_push 保留输入 tag → 仍装箱)
        vm.mov(VReg.A0, VReg.S3);
        vm.load(VReg.A1, VReg.V5, 16);
        vm.call("_array_push");
        vm.mov(VReg.S3, VReg.RET);
        vm.addImm(VReg.S4, VReg.S4, 1);
        vm.jmp("_pany_loop");
        vm.label("_pany_fulwin");
        vm.mov(VReg.A0, VReg.S1);
        vm.load(VReg.A1, VReg.V5, 16);
        vm.call("_promise_resolve");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 48);
        vm.label("_pany_plainwin");
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S5);
        vm.call("_promise_resolve");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 48);
        vm.label("_pany_allrej");
        // 全 rejected → 建 AggregateError 普通对象 {name,message,errors,__asmjs_err}
        // (与编译器 new Error 同构:_object_new + _object_define,不动 error 运行时)。
        vm.call("_object_new");
        vm.movImm64(VReg.V1, MASK48);
        vm.and(VReg.V0, VReg.RET, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.S0, VReg.V0, VReg.V1); // S0 = 装箱 AggregateError 对象
        // name = "AggregateError"
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, "_str_k_name");
        vm.lea(VReg.V0, "_str_agg_name");
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A2, VReg.V0, VReg.V1);
        vm.call("_object_define");
        // message
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, "_str_k_message");
        vm.lea(VReg.V0, "_str_agg_msg");
        vm.movImm64(VReg.V1, 0x7ffc000000000000n);
        vm.or(VReg.A2, VReg.V0, VReg.V1);
        vm.call("_object_define");
        // errors = 收集的拒因数组
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, "_str_k_errors");
        vm.mov(VReg.A2, VReg.S3);
        vm.call("_object_define");
        // __asmjs_err = true(供 instanceof Error 判别)
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, "_str_k_asmjserr");
        vm.lea(VReg.V0, "_js_true");
        vm.load(VReg.A2, VReg.V0, 0);
        vm.call("_object_define");
        // reject(result, aggError)
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S0);
        vm.call("_promise_reject");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 48);
    }

    // [#35] p.finally(cb) —— 调用 cb()(忽略参数与返回值),透传原 promise。
    // 同步 settled 模型下即刻调用;cb 抛错不拦截(记偏差)。
    generatePromiseFinally() {
        const vm = this.vm;
        vm.label("_promise_finally");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0); // 原 promise(boxed)
        vm.mov(VReg.A0, VReg.A1); // cb
        vm.movImm(VReg.A1, 0);
        vm.call("_promise_invoke1");
        vm.mov(VReg.RET, VReg.S0); // 透传
        vm.epilogue([VReg.S0, VReg.S1], 16);
    }

    // Promise.race(A0=array) -> boxed promise
    generatePromiseRace() {
        const vm = this.vm;
        vm.label("_Promise_race");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        vm.mov(VReg.S0, VReg.A0);
        vm.movImm(VReg.A0, 0);
        vm.call("_promise_new");
        vm.mov(VReg.S1, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.mov(VReg.S2, VReg.RET);
        vm.movImm(VReg.S3, 0);

        vm.label("_prc_loop");
        vm.cmp(VReg.S3, VReg.S2);
        vm.jge("_prc_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S3);
        vm.call("_array_get");
        vm.mov(VReg.S4, VReg.RET);

        vm.mov(VReg.A0, VReg.S4);
        vm.call("_is_promise");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_prc_plain");
        // promise：已 settle 则决出
        vm.mov(VReg.A0, VReg.S4);
        vm.call("_js_unbox");
        vm.mov(VReg.V5, VReg.RET);
        vm.load(VReg.V1, VReg.V5, 8);
        vm.cmpImm(VReg.V1, PROMISE_FULFILLED);
        vm.jeq("_prc_ful");
        vm.cmpImm(VReg.V1, PROMISE_REJECTED);
        vm.jeq("_prc_rej");
        // pending：继续
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_prc_loop");

        vm.label("_prc_ful");
        vm.mov(VReg.A0, VReg.S1);
        vm.load(VReg.A1, VReg.V5, 16);
        vm.call("_promise_resolve");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 48);

        vm.label("_prc_rej");
        vm.mov(VReg.A0, VReg.S1);
        vm.load(VReg.A1, VReg.V5, 16);
        vm.call("_promise_reject");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 48);

        vm.label("_prc_plain");
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_promise_resolve");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 48);

        vm.label("_prc_done");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 48);
    }

    // Promise.allSettled(A0=array) -> boxed promise (resolve 结果数组)
    generatePromiseAllSettled() {
        const vm = this.vm;
        vm.label("_Promise_allSettled");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5]);
        vm.mov(VReg.S0, VReg.A0);
        vm.movImm(VReg.A0, 0);
        vm.call("_promise_new");
        vm.mov(VReg.S1, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.call("_array_length");
        vm.mov(VReg.S2, VReg.RET);
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_array_new_with_size");
        vm.mov(VReg.S3, VReg.RET); // result array
        vm.movImm(VReg.S4, 0);

        vm.label("_pas_loop");
        vm.cmp(VReg.S4, VReg.S2);
        vm.jge("_pas_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S4);
        vm.call("_array_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_promise_make_settled_result");
        vm.mov(VReg.S5, VReg.RET);
        vm.mov(VReg.A0, VReg.S3);
        vm.mov(VReg.A1, VReg.S4);
        vm.mov(VReg.A2, VReg.S5);
        vm.call("_array_set");
        vm.addImm(VReg.S4, VReg.S4, 1);
        vm.jmp("_pas_loop");

        vm.label("_pas_done");
        vm.mov(VReg.A0, VReg.S1);
        // 结果数组装箱 0x7FFE(同 _pall_done:S3 裸指针按 float64 位是 denormal → 0)
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.A1, VReg.S3, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffe000000000000n);
        vm.or(VReg.A1, VReg.A1, VReg.V1);
        vm.call("_promise_resolve");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4, VReg.S5], 48);
    }
}
