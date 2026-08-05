// asm.js 运行时 - process 全局对象
// 提供 Node.js 兼容的 process 对象

import { VReg } from "../../vm/index.js";

export class ProcessGenerator {
    constructor(vm, ctx, os, arch = "arm64") {
        this.vm = vm;
        this.ctx = ctx;
        this.os = os;
        this.arch = arch;
    }

    generate() {
        this.generateProcessInit();
        this.generateProcessEnvInit();
        this.generateProcessHelpers();
        this.generateThrowUnwind();
        this.generateArgvInit();
        if (this.os === "windows") this.generateWinBuildArgv();
        this.generatePrintCstr(); // 辅助调试函数
        this.generateGetProcess();
        // Register "*" string for namespace import detection
        this.vm.asm.registerRuntimeString("_str_star", "*");
        this.generateGetModuleExport();
        this.generateCjsPublish();
        this.generateCjsSetError();
        this.generateCjsRequireLazy();
        this.generateCreateBuiltinObject();
        this.generateEventLoop();
    }

    // ============================================================
    // 事件循环（微任务 / setImmediate / setTimeout(0)）
    //
    // 队列为单链表，节点布局（24 字节）：
    //   [0]  next    下一节点裸指针（0=末尾）
    //   [8]  cb      回调值（NaN-boxed 函数/闭包）
    //   [16] handle  句柄对象（NaN-boxed 对象；微任务为 0）
    // 句柄对象带 "cancelled" 属性（JS 布尔）。clearTimeout/clearImmediate
    // 把它置 true；drain 时跳过已取消项。
    // 头尾指针存于数据段（_ev_*_head/_ev_*_tail），被 GC 根扫描覆盖，
    // 使排队回调/句柄在等待执行期间存活。
    // ============================================================
    generateEventLoop() {
        const vm = this.vm;
        const CANCEL_KEY = () => this.vm.asm.addString("cancelled");

        // _ev_make_handle -> RET = 装箱句柄对象（cancelled=false）
        vm.label("_ev_make_handle");
        vm.prologue(16, [VReg.S0]);
        vm.movImm(VReg.A0, 64);
        vm.call("_object_new_sized"); // 裸对象指针
        vm.mov(VReg.S0, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, CANCEL_KEY());
        vm.movImm64(VReg.A2, 0x7ff9000000000000n); // JS_FALSE
        vm.call("_object_set");
        // 装箱为对象 0x7FFD
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.S0, VReg.S0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.RET, VReg.S0, VReg.V1);
        vm.epilogue([VReg.S0], 16);

        // _ev_new_node(A0=cb, A1=handle) -> RET = 节点裸指针
        vm.label("_ev_new_node");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0); // cb
        vm.mov(VReg.S1, VReg.A1); // handle
        vm.movImm(VReg.A0, 24);
        vm.call("_alloc");
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.RET, 0, VReg.V1);  // next = 0
        vm.store(VReg.RET, 8, VReg.S0);  // cb
        vm.store(VReg.RET, 16, VReg.S1); // handle
        vm.epilogue([VReg.S0, VReg.S1], 16); // RET = node

        // _ev_append(A0=node, A1=&head, A2=&tail)
        vm.label("_ev_append");
        vm.prologue(0, []);
        vm.load(VReg.V0, VReg.A2, 0); // tail
        vm.cmpImm(VReg.V0, 0);
        vm.jne("_ev_append_has_tail");
        vm.store(VReg.A1, 0, VReg.A0); // *head = node
        vm.store(VReg.A2, 0, VReg.A0); // *tail = node
        vm.jmp("_ev_append_done");
        vm.label("_ev_append_has_tail");
        vm.store(VReg.V0, 0, VReg.A0); // tail.next = node
        vm.store(VReg.A2, 0, VReg.A0); // *tail = node
        vm.label("_ev_append_done");
        vm.epilogue([], 0);

        // _ev_set_timeout(A0=cb) -> RET = handle
        vm.label("_ev_set_timeout");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0); // cb
        vm.call("_ev_make_handle");
        vm.mov(VReg.S1, VReg.RET); // handle
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_ev_new_node");
        vm.mov(VReg.A0, VReg.RET);
        vm.lea(VReg.A1, "_ev_timeout_head");
        vm.lea(VReg.A2, "_ev_timeout_tail");
        vm.call("_ev_append");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1], 16);

        // _ev_set_immediate(A0=cb) -> RET = handle
        vm.label("_ev_set_immediate");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);
        vm.call("_ev_make_handle");
        vm.mov(VReg.S1, VReg.RET);
        vm.mov(VReg.A0, VReg.S0);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_ev_new_node");
        vm.mov(VReg.A0, VReg.RET);
        vm.lea(VReg.A1, "_ev_imm_head");
        vm.lea(VReg.A2, "_ev_imm_tail");
        vm.call("_ev_append");
        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1], 16);

        // _ev_queue_microtask(A0=cb) -> RET = undefined
        vm.label("_ev_queue_microtask");
        vm.prologue(16, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.A0, VReg.S0);
        vm.movImm(VReg.A1, 0); // handle = 0（微任务无句柄）
        vm.call("_ev_new_node");
        vm.mov(VReg.A0, VReg.RET);
        vm.lea(VReg.A1, "_ev_micro_head");
        vm.lea(VReg.A2, "_ev_micro_tail");
        vm.call("_ev_append");
        vm.movImm64(VReg.RET, 0x7ffb000000000000n); // JS_UNDEFINED
        vm.epilogue([VReg.S0], 16);

        // _ev_clear(A0=handle) -> undefined。仅对象句柄有效，其它值忽略。
        vm.label("_ev_clear");
        vm.prologue(16, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.movImm(VReg.V1, 0x7ffd);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jne("_ev_clear_done");
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, CANCEL_KEY());
        vm.movImm64(VReg.A2, 0x7ff9000000000001n); // JS_TRUE
        vm.call("_object_set");
        vm.label("_ev_clear_done");
        vm.movImm64(VReg.RET, 0x7ffb000000000000n); // JS_UNDEFINED
        vm.epilogue([VReg.S0], 16);

        // _ev_is_cancelled(A0=handle) -> RET = 1(已取消) / 0
        vm.label("_ev_is_cancelled");
        vm.prologue(16, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);
        vm.shrImm(VReg.V0, VReg.S0, 48);
        vm.movImm(VReg.V1, 0x7ffd);
        vm.cmp(VReg.V0, VReg.V1);
        vm.jne("_ev_is_cancelled_no");
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, CANCEL_KEY());
        vm.call("_object_get");
        vm.movImm64(VReg.V1, 0x7ff9000000000001n); // JS_TRUE
        vm.cmp(VReg.RET, VReg.V1);
        vm.jeq("_ev_is_cancelled_yes");
        vm.label("_ev_is_cancelled_no");
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0], 16);
        vm.label("_ev_is_cancelled_yes");
        vm.movImm(VReg.RET, 1);
        vm.epilogue([VReg.S0], 16);

        // _ev_invoke(A0=cbvalue)：以 0 参数调用回调（支持闭包/裸函数指针）
        vm.label("_ev_invoke");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.call("_js_unbox"); // A0 已是 cb，RET = 裸指针
        vm.mov(VReg.S0, VReg.RET);
        vm.load(VReg.V0, VReg.S0, 0);
        vm.movImm(VReg.V1, 0xc105); // CLOSURE_MAGIC
        vm.cmp(VReg.V0, VReg.V1);
        vm.jeq("_ev_invoke_closure");
        // 裸函数指针：S1 = fn，S0 = 0
        vm.mov(VReg.S1, VReg.S0);
        vm.movImm(VReg.S0, 0);
        vm.jmp("_ev_invoke_call");
        vm.label("_ev_invoke_closure");
        vm.load(VReg.S1, VReg.S0, 8); // fn ptr（S0 保留为闭包指针）
        vm.label("_ev_invoke_call");
        vm.movImm64(VReg.A0, 0x7ffb000000000000n); // undefined 参数
        vm.setCallArgcImm(0, VReg.V0, VReg.V1); // [argc ABI] handler()
        vm.callIndirect(VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1], 16);

        // _ev_run：退出前 drain 事件循环。
        // 顺序：微任务全清 → 每个 setImmediate（其间重清微任务）→ 每个 setTimeout。
        vm.label("_ev_run");
        vm.prologue(16, [VReg.S0, VReg.S1]);

        vm.label("_ev_run_loop");
        // ---- 清空所有微任务 ----
        vm.label("_ev_run_micro");
        vm.lea(VReg.V0, "_ev_micro_head");
        vm.load(VReg.S0, VReg.V0, 0);
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_ev_run_after_micro");
        vm.load(VReg.S1, VReg.S0, 0); // next
        vm.lea(VReg.V0, "_ev_micro_head");
        vm.store(VReg.V0, 0, VReg.S1);
        vm.cmpImm(VReg.S1, 0);
        vm.jne("_ev_micro_notempty");
        vm.lea(VReg.V0, "_ev_micro_tail");
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.V0, 0, VReg.V1);
        vm.label("_ev_micro_notempty");
        vm.load(VReg.A0, VReg.S0, 8); // cb
        vm.call("_ev_invoke");
        vm.jmp("_ev_run_micro");

        vm.label("_ev_run_after_micro");
        // [bug2] 定时器/setImmediate 回调里 resolve 的 Promise 反应位于独立队列
        // (_promise_drain_reactions),不在 _ev_micro_head。退出前的 _exit_pump_loop 早于
        // _ev_run 跑完 → 回调内新排的反应(如 setTimeout 里的 Promise.resolve().then())
        // 曾被静默丢弃。此处一并泵空 Promise 反应 + 被唤醒的 await 协程,有排空则回去重清
        // ev_micro(可能又产生新微任务),直到两队列皆空。终止性同 _exit_pump_loop。
        vm.call("_scheduler_run");
        vm.call("_promise_drain_reactions"); // RET = 排空的反应数
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_ev_run_micro");
        // ---- 一个 setImmediate ----
        vm.lea(VReg.V0, "_ev_imm_head");
        vm.load(VReg.S0, VReg.V0, 0);
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_ev_run_try_timeout");
        vm.load(VReg.S1, VReg.S0, 0);
        vm.lea(VReg.V0, "_ev_imm_head");
        vm.store(VReg.V0, 0, VReg.S1);
        vm.cmpImm(VReg.S1, 0);
        vm.jne("_ev_imm_notempty");
        vm.lea(VReg.V0, "_ev_imm_tail");
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.V0, 0, VReg.V1);
        vm.label("_ev_imm_notempty");
        vm.load(VReg.A0, VReg.S0, 16); // handle
        vm.call("_ev_is_cancelled");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_ev_run_loop"); // 已取消：跳过，回主循环
        vm.load(VReg.A0, VReg.S0, 8);
        vm.call("_ev_invoke");
        vm.jmp("_ev_run_loop");

        vm.label("_ev_run_try_timeout");
        // ---- 一个 setTimeout ----
        vm.lea(VReg.V0, "_ev_timeout_head");
        vm.load(VReg.S0, VReg.V0, 0);
        vm.cmpImm(VReg.S0, 0);
        vm.jeq("_ev_run_done");
        vm.load(VReg.S1, VReg.S0, 0);
        vm.lea(VReg.V0, "_ev_timeout_head");
        vm.store(VReg.V0, 0, VReg.S1);
        vm.cmpImm(VReg.S1, 0);
        vm.jne("_ev_to_notempty");
        vm.lea(VReg.V0, "_ev_timeout_tail");
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.V0, 0, VReg.V1);
        vm.label("_ev_to_notempty");
        vm.load(VReg.A0, VReg.S0, 16);
        vm.call("_ev_is_cancelled");
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_ev_run_loop");
        vm.load(VReg.A0, VReg.S0, 8);
        vm.call("_ev_invoke");
        vm.jmp("_ev_run_loop");

        vm.label("_ev_run_done");
        vm.epilogue([VReg.S0, VReg.S1], 16);
    }

    // __get_process: 获取 process 全局对象
    generateGetProcess() {
        const vm = this.vm;
        vm.label("_user___get_process");
        vm.prologue(0, []);
        vm.lea(VReg.V1, "_process_global");
        vm.load(VReg.RET, VReg.V1, 0);
        vm.epilogue([], 0);
    }

    // _get_module_export: 从模块注册表获取导出值
    // A0 = moduleIndex, A1 = exportName (C string)
    // Returns: JSValue of the exported value
    generateGetModuleExport() {
        const vm = this.vm;
        vm.label("_get_module_export");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2]);

        // S0 = moduleIndex
        vm.mov(VReg.S0, VReg.A0);
        // S1 = exportName
        vm.mov(VReg.S1, VReg.A1);

        // 计算模块指针偏移: _module_registry + moduleIndex * 8
        vm.shl(VReg.S2, VReg.S0, 3); // S2 = moduleIndex * 8
        vm.lea(VReg.V0, "_module_registry");
        vm.add(VReg.V0, VReg.V0, VReg.S2);

        // 加载模块指针
        vm.load(VReg.S2, VReg.V0, 0);
        // S2 = module object pointer

        // 检查模块指针是否为 0
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_get_module_export_null");

        // 检查是否为 namespace import (exportName == "*")
        // Compare S1 (exportName) with "_str_star"
        vm.lea(VReg.V1, "_str_star");
        vm.mov(VReg.A0, VReg.S1);
        vm.mov(VReg.A1, VReg.V1);
        vm.call("_strcmp");
        // RET = 0 if equal, non-zero otherwise
        vm.cmpImm(VReg.RET, 0);
        vm.jeq("_get_module_export_namespace");

        // Named export: call _object_get(module, exportName)
        vm.label("_get_module_export_object_get");
        // _module_registry stores raw object pointers, but _object_get expects a
        // tagged JS object value.
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.A0, VReg.S2, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.A0, VReg.A0, VReg.V1);
        vm.mov(VReg.A1, VReg.S1);
        vm.call("_object_get");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);

        // Namespace import: return the module object directly (tagged as JS object)
        vm.label("_get_module_export_namespace");
        // Tag V0 as JS object: 0x7FFD000000000000 | pointer
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.S2, VReg.V1);  // V0 = pointer
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.RET, VReg.V0, VReg.V1);  // RET = tagged object
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);

        vm.label("_get_module_export_null");
        vm.movImm(VReg.RET, 0); // Return JS_UNDEFINED
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 32);
    }

    // ============================================================
    // [CJS cyclic require] Lazy module initialization.
    //
    // Node's CommonJS loader installs module.exports in the cache BEFORE
    // running the module body, so a cyclic require() observes the partial
    // exports object. asm.js's default AOT model runs every module body inline
    // in _main in a fixed topological order sharing one stack frame, which
    // cannot interleave a true cycle (each module needs the other's data) and
    // clobbers per-module locals across the reused frame. To model Node here,
    // modules that participate in a require cycle are instead compiled as
    // standalone init functions (_user___cjs_init_m<idx>, each with its own
    // frame) and executed lazily on first require via _cjs_require_lazy.
    // ============================================================

    // _cjs_publish(A0=moduleIndex, A1=exportsValue): record the (partial)
    // module.exports so an in-progress cyclic re-require can read it. Called at
    // the top of each lazy init body (right after `const module={exports:{}}`)
    // and again at body end to capture any `module.exports = X` reassignment.
    generateCjsPublish() {
        const vm = this.vm;
        vm.label("_cjs_publish");
        vm.prologue(0, []);
        vm.shl(VReg.V0, VReg.A0, 3);        // V0 = idx * 8
        vm.lea(VReg.V1, "_cjs_exports");
        vm.add(VReg.V1, VReg.V1, VReg.V0);  // V1 = &_cjs_exports[idx]
        vm.store(VReg.V1, 0, VReg.A1);
        vm.epilogue([], 0);
    }

    // _cjs_set_error(A0=moduleIndex, A1=errorValue): mark a module as errored and
    // cache the thrown value. Called from the synthesized catch clause of a lazy
    // init body just before re-throwing, so subsequent require() re-throws the
    // same value without re-running the body (matches Node's failed-cycle caching
    // as modeled by the require-cycle-error-cached fixture).
    generateCjsSetError() {
        const vm = this.vm;
        vm.label("_cjs_set_error");
        vm.prologue(0, []);
        vm.shl(VReg.V0, VReg.A0, 3);        // V0 = idx * 8
        vm.lea(VReg.V1, "_cjs_state");
        vm.add(VReg.V1, VReg.V1, VReg.V0);  // V1 = &_cjs_state[idx]
        vm.movImm(VReg.V2, 3);
        vm.store(VReg.V1, 0, VReg.V2);      // state[idx] = 3 (errored)
        vm.lea(VReg.V1, "_cjs_error");
        vm.add(VReg.V1, VReg.V1, VReg.V0);  // V1 = &_cjs_error[idx]
        vm.store(VReg.V1, 0, VReg.A1);      // error[idx] = errorValue
        vm.epilogue([], 0);
    }

    // _cjs_require_lazy(A0=moduleIndex, A1=initFnPtr): resolve a cyclic-CJS
    // require. Returns the (possibly partial) module.exports value.
    //   state 3 (errored)      -> re-throw cached error via _throw_unwind
    //   state 1/2 (in progress -> already published exports; return it (cyclic
    //             or done)         partial re-require lands here)
    //   state 0 (fresh)        -> mark 1, run init body, mark 2, return exports
    // If the init body throws, its synthesized catch has already set state=3 and
    // cached the error, then re-threw; the throw unwinds through this helper
    // (skipping the state=2 store) up to the caller's try.
    generateCjsRequireLazy() {
        const vm = this.vm;
        vm.label("_cjs_require_lazy");
        vm.prologue(32, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);           // S0 = idx
        vm.mov(VReg.S1, VReg.A1);           // S1 = initFnPtr

        vm.shl(VReg.V0, VReg.S0, 3);        // V0 = idx * 8
        vm.lea(VReg.V1, "_cjs_state");
        vm.add(VReg.V1, VReg.V1, VReg.V0);  // V1 = &_cjs_state[idx]
        vm.load(VReg.V2, VReg.V1, 0);       // V2 = state
        vm.cmpImm(VReg.V2, 3);
        vm.jeq("_cjs_require_lazy_errored");
        vm.cmpImm(VReg.V2, 0);
        vm.jne("_cjs_require_lazy_return"); // state 1 or 2 -> return published exports

        // state == 0: mark initializing, run the module body.
        vm.movImm(VReg.V2, 1);
        vm.store(VReg.V1, 0, VReg.V2);      // state[idx] = 1
        vm.callIndirect(VReg.S1);           // run _user___cjs_init_m<idx>()
        // Body returned normally -> mark done.
        vm.shl(VReg.V0, VReg.S0, 3);
        vm.lea(VReg.V1, "_cjs_state");
        vm.add(VReg.V1, VReg.V1, VReg.V0);
        vm.movImm(VReg.V2, 2);
        vm.store(VReg.V1, 0, VReg.V2);      // state[idx] = 2

        vm.label("_cjs_require_lazy_return");
        vm.shl(VReg.V0, VReg.S0, 3);
        vm.lea(VReg.V1, "_cjs_exports");
        vm.add(VReg.V1, VReg.V1, VReg.V0);
        vm.load(VReg.RET, VReg.V1, 0);      // RET = _cjs_exports[idx]
        vm.epilogue([VReg.S0, VReg.S1], 32);

        vm.label("_cjs_require_lazy_errored");
        vm.shl(VReg.V0, VReg.S0, 3);
        vm.lea(VReg.V1, "_cjs_error");
        vm.add(VReg.V1, VReg.V1, VReg.V0);
        vm.load(VReg.V2, VReg.V1, 0);       // V2 = cached error value
        vm.lea(VReg.V0, "_exception_value");
        vm.store(VReg.V0, 0, VReg.V2);
        vm.lea(VReg.V0, "_exception_pending");
        vm.movImm(VReg.V2, 1);
        vm.store(VReg.V0, 0, VReg.V2);
        vm.call("_throw_unwind");           // does not return
    }

    // _create_builtin_object: Create a heap-allocated object for shim module builtins
    // A0 = C string pointer (object name), A1 = number of methods
    // Returns: pointer to heap-allocated object
    generateCreateBuiltinObject() {
        const vm = this.vm;
        vm.label("_create_builtin_object");
        vm.prologue(32, [VReg.S0, VReg.S1]);

        vm.mov(VReg.S0, VReg.A0); // S0 = name (unused for now)
        vm.mov(VReg.S1, VReg.A1); // S1 = method count

        // 需要的字节数（旧头语义: 24 + (methodCount+4)*16）交给 _object_new_sized
        // 换算初始容量。方法随后经 os.xxx = fn 的 _object_set 追加，可自动增长。
        vm.addImm(VReg.A0, VReg.S1, 4); // extra slots for type tag
        vm.shl(VReg.A0, VReg.A0, 4); // * 16 (PROP_SIZE)
        vm.addImm(VReg.A0, VReg.A0, 24); // + 旧头大小
        vm.call("_object_new_sized"); // 返回裸对象指针（type/count/proto/capacity/props_ptr 已初始化）

        // Return object pointer in RET
        vm.epilogue([VReg.S0, VReg.S1], 32);
    }

    // _print_cstr: 打印 C 字符串（以 null 结尾）
    // A0 = C 字符串指针
    generatePrintCstr() {
        const vm = this.vm;

        vm.label("_print_cstr");
        vm.prologue(0, [VReg.S0, VReg.S1]);

        vm.mov(VReg.S0, VReg.A0); // S0 = 字符串指针

        // 计算长度
        vm.movImm(VReg.S1, 0); // S1 = 长度
        vm.label("_print_cstr_len_loop");
        vm.loadByte(VReg.V0, VReg.S0, 0);
        vm.add(VReg.V0, VReg.S0, VReg.S1);
        vm.loadByte(VReg.V0, VReg.V0, 0);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_print_cstr_len_done");
        vm.addImm(VReg.S1, VReg.S1, 1);
        vm.jmp("_print_cstr_len_loop");

        vm.label("_print_cstr_len_done");
        // 调用 write 系统调用
        vm.movImm(VReg.A0, 1); // fd = 1 (stdout)
        vm.mov(VReg.A1, VReg.S0); // buf = 字符串指针
        vm.mov(VReg.A2, VReg.S1); // count = 长度

        // 系统调用号：
        // macOS ARM64/x64: 4
        // Linux ARM64: 64
        // Linux x64: 1
        if (this.os === "macos") {
            vm.syscall(4);
        } else if (this.os === "linux") {
            vm.syscall(this.arch === "arm64" ? 64 : 1);
        } else if (this.os === "wasi") {
            vm.syscall(1); // wasi 号名空间 = linux-x64
        }

        // 打印换行符
        vm.movImm(VReg.V0, 10); // '\n'
        vm.store(VReg.SP, -16, VReg.V0);
        vm.movImm(VReg.A0, 1);
        vm.subImm(VReg.A1, VReg.SP, 16);
        vm.movImm(VReg.A2, 1);
        if (this.os === "macos") {
            vm.syscall(4);
        } else if (this.os === "linux") {
            vm.syscall(this.arch === "arm64" ? 64 : 1);
        } else if (this.os === "wasi") {
            vm.syscall(1); // wasi 号名空间 = linux-x64
        }

        vm.epilogue([VReg.S0, VReg.S1], 0);
    }

    // _process_cwd_fn(): 返回 "." 装箱字符串（裸 process.cwd() 用）。
    // 原返回 "/" → 自举时 resolveModulePath 用 cwd 拼 runtime/node/*.js 得到绝对
    // "/runtime/node/fs.js"(缺 cwd 前缀)读不到 → 所有模块空 → gen2 空壳。改 "." → 相对
    // 当前目录解析（自举从项目根跑，正确）。真 getcwd syscall 在 macOS 返 EFAULT，暂用 "."。
    generateProcessHelpers() {
        const vm = this.vm;
        vm.label("_process_cwd_fn");
        vm.prologue(16, [VReg.S0]);
        vm.lea(VReg.A0, this.vm.asm.addString("."));
        vm.call("_js_box_string");
        vm.epilogue([VReg.S0], 16);

        // _process_nextTick_fn(cb): 将回调排入微任务队列，退出前 _ev_run 会执行。
        // 方法约定：第一个参数（回调值，NaN-boxed 函数/闭包）在 A0，直接转交
        // _ev_queue_microtask。返回 undefined（在 RET）。
        vm.label("_process_nextTick_fn");
        vm.prologue(0, []);
        vm.call("_ev_queue_microtask"); // A0 已是 cb
        vm.epilogue([], 0);

        // _process_exit_fn(code): 用 code 退出
        vm.label("_process_exit_fn");
        // A0 = code（方法约定：第一个参数）；归一化为整数后 syscall exit
        vm.call("_syscall_arg");
        vm.mov(VReg.A0, VReg.RET);
        if (this.os === "macos") {
            // Darwin arm64 uses the raw BSD number (1) in x16; x64 requires the
            // Unix-class prefix 0x2000000 in rax (0x2000001), or Rosetta traps
            // EXC_SYSCALL on a class-0 syscall → process.exit() segfaults.
            vm.syscall(this.arch === "arm64" ? 1 : 0x2000001);
        } else if (this.os === "linux") {
            vm.syscall(this.arch === "arm64" ? 93 : 60);
        } else if (this.os === "wasi") {
            vm.syscall(60); // wasi 号名空间 = linux-x64
        }
    }

    // [#38] _throw_unwind: 跨函数异常传播。
    // 前置条件:_exception_value/_exception_pending 已写。
    // 链头非空 → 恢复顶帧的 S0-S4、FP、S5(x64 S5 是 FP-8 栈槽,必须在 FP 之后)、
    // SP,间接跳转 catchPC。不弹链头——catch/finally_exc 入口按词法帧恢复(幂等),
    // 且未弹保证 finally 重抛能继续向外找。链头空 → 未捕获,退出码 1(与既有行为一致)。
    // 无 prologue:本函数永不返回,SP/FP 由帧快照整体置换。
    generateThrowUnwind() {
        const vm = this.vm;
        vm.label("_throw_unwind");
        vm.lea(VReg.V0, "_exc_ctx_top");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, 0);
        vm.jne("_throw_unwind_hasctx");
        // [协程逃逸] 链空但身处非主协程(运行时 helper 在协程体内抛出等):不可直接
        // exit——完成本协程(pending 保留),控制回到 resumer;resume 点
        // (_generator_next/_generator_throw/_generator_return)在调用方栈上传播。
        vm.lea(VReg.V2, "_scheduler_current");
        vm.load(VReg.V2, VReg.V2, 0);
        vm.lea(VReg.V3, "_scheduler_main");
        vm.load(VReg.V3, VReg.V3, 0);
        vm.cmp(VReg.V2, VReg.V3);
        vm.jeq("_throw_unwind_exit");
        vm.jmp("_coroutine_return");
        vm.label("_throw_unwind_exit");
        // 未捕获:exit(1)
        vm.movImm(VReg.A0, 1);
        if (this.os === "wasi") {
            vm.syscall(60); // wasi 号名空间 = linux-x64
        } else if (this.arch === "arm64") {
            vm.syscall(this.os === "linux" ? 93 : 1);
        } else {
            vm.syscall(this.os === "linux" ? 60 : 0x2000001);
        }
        vm.label("_throw_unwind_hasctx");
        // 帧布局 {link@0, catchPC@8, SP@16, FP@24, S0@32..S4@64, S5@72}
        vm.load(VReg.S0, VReg.V1, 32);
        vm.load(VReg.S1, VReg.V1, 40);
        vm.load(VReg.S2, VReg.V1, 48);
        vm.load(VReg.S3, VReg.V1, 56);
        vm.load(VReg.S4, VReg.V1, 64);
        vm.load(VReg.V2, VReg.V1, 24);
        vm.mov(VReg.FP, VReg.V2);
        vm.load(VReg.V2, VReg.V1, 72);
        vm.mov(VReg.S5, VReg.V2);
        vm.load(VReg.V2, VReg.V1, 16);
        vm.mov(VReg.SP, VReg.V2);
        vm.load(VReg.V2, VReg.V1, 8);
        vm.jmpIndirect(VReg.V2);
    }

    // 辅助：把裸对象（存于 SP+spOff）的 key 属性设为装箱字符串 value。
    // 复用 platform/arch 处已验证的 _js_box_string + _object_set 序列。
    _setStrPropFrom(vm, spOff, key, value) {
        vm.lea(VReg.A0, this.vm.asm.addString(value));
        vm.call("_js_box_string");
        vm.mov(VReg.A2, VReg.RET);
        vm.load(VReg.A0, VReg.SP, spOff);
        vm.lea(VReg.A1, this.vm.asm.addString(key));
        vm.call("_object_set");
    }

    // _process_init: 初始化 process 对象
    // 在程序启动时调用，传入 argc 和 argv
    // A0 = argc, A1 = argv (指向 char* 数组的指针)
    generateProcessInit() {
        const vm = this.vm;

        vm.label("_process_init");
        // [SP+0]=FP, [SP+8]=LR
        // 帧 64B：SP+16=argc, SP+24=argv, SP+32=process 对象, SP+40=argv 数组临时,
        // SP+48=辅助对象临时（versions/env）
        vm.prologue(64, []);

        // 确保 argc 是 32 位的（dyld 传入 X0，高 32 位可能有垃圾）
        vm.movImm64(VReg.V4, 0xffffffffn);
        vm.and(VReg.A0, VReg.A0, VReg.V4);

        // 保存 argc 和 argv
        vm.store(VReg.SP, 16, VReg.A0); // [SP+16] = argc
        vm.store(VReg.SP, 24, VReg.A1); // [SP+24] = argv

        // 创建 process 对象（新布局：属性区独立分配、可自动增长）
        vm.movImm(VReg.A0, 128);
        vm.call("_object_new_sized"); // 头字段（capacity/props_ptr）已初始化
        vm.store(VReg.SP, 32, VReg.RET); // [SP+32] = process 对象

        // 保存 process 对象到全局变量
        vm.lea(VReg.V1, "_process_global");
        vm.load(VReg.V0, VReg.SP, 32);
        vm.store(VReg.V1, 0, VReg.V0);

        // 创建 argv 数组
        vm.load(VReg.A0, VReg.SP, 16); // argc
        vm.load(VReg.A1, VReg.SP, 24); // argv
        vm.call("_process_create_argv");
        // RET = argv 数组

        // 保存 argv 数组到栈上临时位置
        vm.store(VReg.SP, 40, VReg.RET);

        // 1. 设置 argv
        vm.load(VReg.A0, VReg.SP, 32); // obj (raw ptr)
        vm.lea(VReg.A1, this.vm.asm.addString("argv"));
        vm.load(VReg.A2, VReg.SP, 40); // value (boxed array)
        vm.call("_object_set");

        // 2. 设置 platform（按目标平台选串，绝不能硬编码 macos——
        //    否则 linux 二进制里 process.platform=="macos"，getSyscall 走 macos 分支
        //    发出 0x2000001 号系统调用 → linux 上非法 → process.exit segfault）
        const platformLabel = this.vm.os === "linux" ? "_str_linux"
            : this.vm.os === "windows" ? "_str_win32"
            : this.vm.os === "wasi" ? "_str_wasi"
            : "_str_macos";
        vm.load(VReg.A0, VReg.SP, 32); // obj (raw ptr)
        vm.lea(VReg.A1, this.vm.asm.addString("platform"));
        vm.lea(VReg.V1, platformLabel);
        vm.mov(VReg.A0, VReg.V1);
        vm.call("_js_box_string");
        vm.mov(VReg.A2, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 32); // reload obj
        vm.lea(VReg.A1, this.vm.asm.addString("platform"));
        vm.call("_object_set");

        // 3. 设置 arch（按目标架构选串）
        const archLabel = this.vm.arch === "x64" ? "_str_x64"
            : this.vm.arch === "wasm32" ? "_str_wasm32"
            : "_str_arm64";
        vm.load(VReg.A0, VReg.SP, 32); // obj (raw ptr)
        vm.lea(VReg.A1, this.vm.asm.addString("arch"));
        vm.lea(VReg.V1, archLabel);
        vm.mov(VReg.A0, VReg.V1);
        vm.call("_js_box_string");
        vm.mov(VReg.A2, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 32); // reload obj
        vm.lea(VReg.A1, this.vm.asm.addString("arch"));
        vm.call("_object_set");

        // cwd: 函数指针（NaN-box 0x7FFF），供裸 process.cwd() 调用
        vm.load(VReg.A0, VReg.SP, 32);
        vm.lea(VReg.A1, this.vm.asm.addString("cwd"));
        vm.lea(VReg.A2, "_process_cwd_fn");
        vm.movImm64(VReg.V1, 0x7fff000000000000n);
        vm.or(VReg.A2, VReg.A2, VReg.V1);
        vm.call("_object_set");

        // exit: 函数指针
        vm.load(VReg.A0, VReg.SP, 32);
        vm.lea(VReg.A1, this.vm.asm.addString("exit"));
        vm.lea(VReg.A2, "_process_exit_fn");
        vm.movImm64(VReg.V1, 0x7fff000000000000n);
        vm.or(VReg.A2, VReg.A2, VReg.V1);
        vm.call("_object_set");

        // nextTick: 函数指针（NaN-box 0x7FFF），供裸 process.nextTick(cb) 调用
        vm.load(VReg.A0, VReg.SP, 32);
        vm.lea(VReg.A1, this.vm.asm.addString("nextTick"));
        vm.lea(VReg.A2, "_process_nextTick_fn");
        vm.movImm64(VReg.V1, 0x7fff000000000000n);
        vm.or(VReg.A2, VReg.A2, VReg.V1);
        vm.call("_object_set");

        // version: 字符串（typeof process.version === "string"）
        vm.lea(VReg.A0, this.vm.asm.addString("v20.0.0"));
        vm.call("_js_box_string");
        vm.mov(VReg.A2, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 32);
        vm.lea(VReg.A1, this.vm.asm.addString("version"));
        vm.call("_object_set");

        // versions: 对象，含 node/v8/modules/napi 版本字符串
        vm.movImm(VReg.A0, 128);
        vm.call("_object_new_sized"); // 裸对象指针
        vm.store(VReg.SP, 48, VReg.RET); // [SP+48] = versions 裸指针
        this._setStrPropFrom(vm, 48, "node", "20.0.0");
        this._setStrPropFrom(vm, 48, "v8", "11.3.0");
        this._setStrPropFrom(vm, 48, "uv", "1.0.0");
        this._setStrPropFrom(vm, 48, "modules", "108");
        this._setStrPropFrom(vm, 48, "napi", "8");
        // 装箱 versions 为对象 0x7FFD 并挂到 process
        vm.load(VReg.V0, VReg.SP, 48);
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.V0, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.A2, VReg.V0, VReg.V1);
        vm.load(VReg.A0, VReg.SP, 32);
        vm.lea(VReg.A1, this.vm.asm.addString("versions"));
        vm.call("_object_set");

        // env: 对象，挂到 process.env,随后从 envp 填充 KEY=VALUE（见 _process_env_init）。
        vm.movImm(VReg.A0, 128);
        vm.call("_object_new_sized");
        vm.store(VReg.SP, 48, VReg.RET); // [SP+48] = env 裸对象指针（versions 槽已用完，复用）
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.RET, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffd000000000000n);
        vm.or(VReg.A2, VReg.V0, VReg.V1);
        vm.load(VReg.A0, VReg.SP, 32);
        vm.lea(VReg.A1, this.vm.asm.addString("env"));
        vm.call("_object_set");
        // 从 envp 填充（POSIX 才有连续 envp;Windows argv 为合成，跳过 → env 保持空对象）
        if (this.vm.os !== "windows") {
            vm.load(VReg.A0, VReg.SP, 48); // env 裸对象
            vm.load(VReg.A1, VReg.SP, 16); // argc
            vm.load(VReg.A2, VReg.SP, 24); // argv
            vm.call("_process_env_init");
        }

        // 创建 globalThis 全局对象并写入 _global_this（裸指针）。
        // 供裸标识符 globalThis 及事件循环/用户代码挂载属性使用。
        vm.movImm(VReg.A0, 128);
        vm.call("_object_new_sized");
        vm.lea(VReg.V1, "_global_this");
        vm.store(VReg.V1, 0, VReg.RET);

        // 返回 process 对象 (从全局加载，确保是正确的装箱值或指针)
        vm.lea(VReg.V1, "_process_global");
        vm.load(VReg.RET, VReg.V1, 0);
        vm.epilogue([], 64);
    }

    // _process_env_init(A0=env裸对象, A1=argc, A2=argv):从 envp 填充 process.env。
    // envp 紧随 argv[argc]=NULL 之后(POSIX 初始栈布局),envp = argv + (argc+1)*8。
    // 每条为 "KEY=VALUE\0" C 串:找首个 '=',临时置 0 截出 KEY(_cstr_to_heap_str 复制到
    // 堆串),VALUE=后半(已 null 终止),随后恢复 '=';_object_set(env, key, value)。
    // GC 安全:栈保守扫描 [SP,_stack_base),故 boxed key/value 溢出到本帧栈槽(SP+16/24)
    // 即为根;env 经 process.env→_process_global 全局可达;GC 非移动(mark-sweep)故裸指针稳。
    // 仅 POSIX(macOS/linux)调用——Windows 的 argv 为合成,与真实 envp 不连续,跳过。
    generateProcessEnvInit() {
        const vm = this.vm;
        vm.label("_process_env_init");
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S0, VReg.A0); // env 裸对象
        // envp = argv + (argc+1)*8
        vm.addImm(VReg.V0, VReg.A1, 1);
        vm.shl(VReg.V0, VReg.V0, 3);
        vm.add(VReg.S1, VReg.A2, VReg.V0); // S1 = envp 游标
        // 迭代计数(防御性上限,防 envp 未按预期 null 终止)
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.SP, 32, VReg.V0);

        vm.label("_penv_loop");
        vm.load(VReg.S2, VReg.S1, 0); // 当前 entry 指针
        vm.cmpImm(VReg.S2, 0);
        vm.jeq("_penv_done");
        vm.load(VReg.V0, VReg.SP, 32);
        vm.cmpImm(VReg.V0, 8192);
        vm.jge("_penv_done");
        vm.addImm(VReg.V0, VReg.V0, 1);
        vm.store(VReg.SP, 32, VReg.V0);

        // 找 '='(61)
        vm.movImm(VReg.S3, 0);
        vm.label("_penv_find");
        vm.add(VReg.V0, VReg.S2, VReg.S3);
        vm.loadByte(VReg.V0, VReg.V0, 0);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_penv_next"); // 无 '=' → 跳过
        vm.cmpImm(VReg.V0, 61);
        vm.jeq("_penv_goteq");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_penv_find");

        vm.label("_penv_goteq");
        vm.cmpImm(VReg.S3, 0);
        vm.jeq("_penv_next"); // 空 KEY → 跳过
        // 临时 null 截断 KEY:[S2+S3] = 0
        vm.add(VReg.V1, VReg.S2, VReg.S3);
        vm.movImm(VReg.V0, 0);
        vm.storeByte(VReg.V1, 0, VReg.V0);
        // KEY → 堆串
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_cstr_to_heap_str");
        vm.store(VReg.SP, 16, VReg.RET); // boxed key(栈根)
        // 恢复 '='
        vm.add(VReg.V1, VReg.S2, VReg.S3);
        vm.movImm(VReg.V0, 61);
        vm.storeByte(VReg.V1, 0, VReg.V0);
        // VALUE = entry + eqOff + 1(已 null 终止)
        vm.add(VReg.A0, VReg.S2, VReg.S3);
        vm.addImm(VReg.A0, VReg.A0, 1);
        vm.call("_cstr_to_heap_str");
        vm.store(VReg.SP, 24, VReg.RET); // boxed value(栈根)
        // env[key] = value
        vm.mov(VReg.A0, VReg.S0);
        vm.load(VReg.A1, VReg.SP, 16);
        vm.load(VReg.A2, VReg.SP, 24);
        vm.call("_object_set");

        vm.label("_penv_next");
        vm.addImm(VReg.S1, VReg.S1, 8);
        vm.jmp("_penv_loop");

        vm.label("_penv_done");
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 64);
    }

    // _process_create_argv: 创建 argv 数组
    // A0 = argc, A1 = argv (char**)
    // Windows 命令行 -> argv(char**)。PE 入口无 CRT,argv 需自建。
    // GetCommandLineA 返回整条命令行(含 exe 名),按空格切分成 token,原地写 null
    // 终止每个 token,指针存入堆上分配的 argv 数组。返回 argc(RET),argv 存入
    // 全局 _win_argv_ptr。产出的 argv 形如 [exe, arg1, arg2, ...] = OS argv,
    // 随后 _process_create_argv 再补一次 argv[0](与 macos/linux 同逻辑)使
    // process.argv[2] 对齐到首个真实参数。仅空格切分(自举路径参数无空格)。
    generateWinBuildArgv() {
        const vm = this.vm;
        vm.label("_win_build_argv");
        vm.prologue(0, [VReg.S1, VReg.S2, VReg.S3]);
        vm.callWindowsGetCommandLine();     // RET = 命令行字符串指针
        vm.mov(VReg.S3, VReg.RET);           // S3 = 游标
        vm.movImm(VReg.A0, 512);             // 64 个指针槽
        vm.call("_alloc");
        vm.mov(VReg.S1, VReg.RET);           // S1 = argv 数组基址
        vm.movImm(VReg.S2, 0);               // S2 = argc

        vm.label("_wba_loop");
        // 跳过前导空格
        vm.label("_wba_skipsp");
        vm.loadByte(VReg.V0, VReg.S3, 0);
        vm.cmpImm(VReg.V0, 32);              // ' '
        vm.jne("_wba_sp_done");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_wba_skipsp");
        vm.label("_wba_sp_done");
        vm.cmpImm(VReg.V0, 0);               // 命令行结束
        vm.jeq("_wba_done");
        // 越界保护:argc >= 64 则停
        vm.cmpImm(VReg.S2, 64);
        vm.jge("_wba_done");
        // token 起点:argv[argc] = S3
        vm.mov(VReg.V1, VReg.S2);
        vm.shl(VReg.V1, VReg.V1, 3);
        vm.add(VReg.V1, VReg.S1, VReg.V1);
        vm.store(VReg.V1, 0, VReg.S3);
        vm.addImm(VReg.S2, VReg.S2, 1);
        // 扫到 token 结束
        vm.label("_wba_tokend");
        vm.loadByte(VReg.V0, VReg.S3, 0);
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_wba_done");                 // 末尾 token,已由原串的 \0 终止
        vm.cmpImm(VReg.V0, 32);
        vm.jeq("_wba_tokspace");
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_wba_tokend");
        vm.label("_wba_tokspace");
        vm.movImm(VReg.V0, 0);
        vm.storeByte(VReg.S3, 0, VReg.V0);   // 原地 null 终止
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_wba_loop");

        vm.label("_wba_done");
        vm.lea(VReg.V1, "_win_argv_ptr");
        vm.store(VReg.V1, 0, VReg.S1);       // 存 argv 数组基址
        vm.mov(VReg.RET, VReg.S2);           // 返回 argc
        vm.epilogue([VReg.S1, VReg.S2, VReg.S3], 0);
    }

    // 返回 JS Array 对象
    generateArgvInit() {
        const vm = this.vm;

        vm.label("_process_create_argv");
        // 栈布局:
        // ARM64 frame: [SP+0]=FP, [SP+8]=LR
        // [SP+16] = argc
        // [SP+24] = argv (char**)
        // [SP+32] = JS 数组
        // [SP+40] = 当前索引 i
        // [SP+48] = 临时保存字符串
        vm.prologue(64, []);

        // 保存参数 (偏移 16)
        vm.store(VReg.SP, 16, VReg.A0); // [SP+16] = argc
        vm.store(VReg.SP, 24, VReg.A1); // [SP+24] = argv

        // 创建空数组
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.store(VReg.SP, 32, VReg.RET); // [SP+32] = 数组

        // argv == NULL(windows 入口无 argc/argv)→ 跳过全部推入,返回空数组
        vm.load(VReg.V1, VReg.SP, 24);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq("_argv_done");

        // Node 布局兼容：argv[0]=运行时, argv[1]=脚本, argv[2..]=用户参数。
        // 编译产物没有独立的"脚本"，用二进制路径同时充当 argv[0] 与 argv[1]：
        // 先额外推一次 OS argv[0]，再从 0 开始推完整 OS argv。
        vm.load(VReg.V1, VReg.SP, 24); // argv
        vm.load(VReg.A0, VReg.V1, 0);  // OS argv[0]
        vm.call("_cstr_to_heap_str");
        vm.mov(VReg.A1, VReg.RET);
        vm.load(VReg.A0, VReg.SP, 32);
        vm.call("_array_push");
        vm.store(VReg.SP, 32, VReg.RET);

        // 初始化索引 i = 0
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.SP, 40, VReg.V0); // [SP+40] = i = 0

        // 循环: for (i = 0; i < argc; i++)
        vm.label("_argv_loop");
        vm.load(VReg.V0, VReg.SP, 40); // V0 = i
        vm.load(VReg.V1, VReg.SP, 16); // V1 = argc
        vm.cmp(VReg.V0, VReg.V1);
        vm.jge("_argv_done");

        // 获取 argv[i]: char* ptr = argv[i]
        vm.load(VReg.V0, VReg.SP, 40); // V0 = i
        vm.shl(VReg.V0, VReg.V0, 3); // V0 = i * 8
        vm.load(VReg.V1, VReg.SP, 24); // V1 = argv
        vm.add(VReg.V1, VReg.V1, VReg.V0); // V1 = &argv[i]
        vm.load(VReg.V0, VReg.V1, 0); // V0 = argv[i]

        // 拷贝进 JS 堆并装箱（argv 字符串在 OS 栈上，不能直接引用）
        vm.mov(VReg.A0, VReg.V0);
        vm.call("_cstr_to_heap_str");
        vm.store(VReg.SP, 48, VReg.RET); // [SP+48] = boxed str

        // 加载数组到 V0，再设置参数
        vm.load(VReg.V0, VReg.SP, 32); // V0 = 数组
        vm.load(VReg.V1, VReg.SP, 48); // V1 = boxed str
        vm.mov(VReg.A1, VReg.V1);
        vm.mov(VReg.A0, VReg.V0);
        vm.call("_array_push");
        vm.store(VReg.SP, 32, VReg.RET); // 保存新数组 (可能扩容)

        // i++
        vm.load(VReg.V0, VReg.SP, 40);
        vm.addImm(VReg.V0, VReg.V0, 1);
        vm.store(VReg.SP, 40, VReg.V0);

        vm.jmp("_argv_loop");

        vm.label("_argv_done");
        // 返回数组（NaN-box 为 JS 数组 0x7FFE，供 typeof/length/下标等 JS 路径识别）
        vm.load(VReg.RET, VReg.SP, 32);
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.RET, VReg.RET, VReg.V1);
        vm.movImm64(VReg.V1, 0x7ffe000000000000n);
        vm.or(VReg.RET, VReg.RET, VReg.V1);
        vm.epilogue([], 64);
    }

    // 生成数据段
    generateDataSection(asm) {
        // process 全局变量存储 (已由 allocator.js 统一添加)
        // Windows argv 数组基址(_win_build_argv 写入,入口读取)
        if (this.os === "windows") {
            asm.addDataLabel("_win_argv_ptr");
            asm.addDataQword(0);
        }
        // 异常值存储
        asm.addDataLabel("_exception_value");
        asm.addDataQword(0);

        // 异常待处理标志 (用于跨函数异常传播)
        // 0 = 无异常, 1 = 有待处理异常
        asm.addDataLabel("_exception_pending");
        asm.addDataQword(0);

        // [#38] 跨函数异常传播:catch 上下文链头。每个 try 在所属函数栈帧里
        // 占 10 槽 80B = {link, catchPC, SP, FP, S0, S1, S2, S3, S4, S5},
        // try-enter 写帧并把链头指向它;catch 入口/finally_exc 入口/try 正常退出
        // 以及跨 try 的 return/break/continue 恢复链头为 frame.link(幂等)。
        // throw 无本地 label 时 _throw_unwind 按链头恢复寄存器跳 catchPC。
        // 帧住在栈上 → 无深度上限,递归 try 天然安全。
        asm.addDataLabel("_exc_ctx_top");
        asm.addDataQword(0);

        // Default platform/arch strings for __get_process() fallback
        // These are used by the __get_process() compiler fallback when
        // runtime modules call it at import time (before _process_init).
        const addCString = (label, str) => {
            asm.addDataLabel(label);
            for (let i = 0; i < str.length; i++) asm.addDataByte(str.charCodeAt(i));
            asm.addDataByte(0);
        };
        addCString("_str_macos", "macos");
        addCString("_str_linux", "linux");
        addCString("_str_win32", "win32");
        addCString("_str_arm64", "arm64");
        addCString("_str_x64", "x64");
        // 仅 wasi 目标注入(native 数据段逐字节不变)
        if (this.vm.os === "wasi") {
            addCString("_str_wasi", "wasi");
            addCString("_str_wasm32", "wasm32");
        }
    }
}
