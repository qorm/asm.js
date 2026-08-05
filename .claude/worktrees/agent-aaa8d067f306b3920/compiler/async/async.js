// asm.js 编译器 - 异步函数编译
// 编译 async 函数和 await 表达式

import { VReg } from "../../vm/index.js";

// async 函数魔数 - 标记为异步闭包
export const ASYNC_CLOSURE_MAGIC = 0xa51c;

// 判断 AST 节点是否是 async 函数（兼容 parser 的 async/isAsync 两种属性）
export function isAsyncFunction(node) {
    return node && (node.async === true || node.isAsync === true);
}

// [批次D] 判断 AST 节点是否是生成器函数（兼容 isGenerator/generator 两种属性）
export function isGeneratorFunction(node) {
    return node && (node.isGenerator === true || node.generator === true);
}

// 异步编译器方法混入
export const AsyncCompiler = {
    // 编译 await 表达式
    // await promise 会挂起当前协程直到 promise 完成
    compileAwaitExpression(expr) {
        const vm = this.vm;
        // 编译被 await 的表达式
        this.compileExpression(expr.argument);
        // RET = 被 await 的值(可能是 Promise,也可能是普通值/thenable)

        // await 非 Promise:值本身即结果,**不进** _promise_await(否则把非 promise 当 promise
        // 解引 → 段错误,`await 7` 崩的根因)。thenable 暂不 adopt(返回对象本身,记偏差)。
        const awaitDone = this.ctx.newLabel("await_done");
        vm.mov(VReg.A0, VReg.RET);
        vm.push(VReg.RET);
        vm.call("_is_promise");     // RET = 1 若为 Promise
        vm.cmpImm(VReg.RET, 0);
        vm.pop(VReg.RET);           // RET = 被 await 的值(还原)
        vm.jeq(awaitDone);          // 非 Promise → RET 即结果

        // 调用 _promise_await
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_promise_await");
        // RET = resolved 值；若被 reject，_promise_await 已置 _exception_pending

        // 检查 await 期间是否产生异常（promise 被 reject）
        const contLabel = this.ctx.newLabel("await_no_exc");
        vm.push(VReg.RET); // 暂存结果值，保证两条路径栈平衡
        vm.lea(VReg.V0, "_exception_pending");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq(contLabel);
        // 异常挂起：拒因已在 _exception_value，跳到当前 try 的 catch（或未处理退出）
        vm.pop(VReg.RET);
        if (this.ctx.exceptionLabel) {
            vm.jmp(this.ctx.exceptionLabel);
        } else {
            this.emitUnhandledExceptionExit();
        }
        vm.label(contLabel);
        vm.pop(VReg.RET);
        vm.label(awaitDone);
    },

    // [批次D] 编译 yield 表达式（只出现在生成器体内，体运行在协程栈上）
    // 协议：把 yield 值写入当前协程 result 槽(coro+72) → _coroutine_yield 挂起；
    // _generator_next 在主协程侧从 +72 读出该值包成 {value,done:false}。
    // 恢复时 _coroutine_resume 已把 next(v) 的 v 写回 +72，
    // _coroutine_yield 的 resume 续体从 +72 读出并作为 RET 返回 = yield 表达式的值。
    compileYieldExpression(expr) {
        const vm = this.vm;
        if (expr.delegate) {
            this.compileYieldStar(expr);
            return;
        }
        if (expr.argument) {
            this.compileExpression(expr.argument);
        } else {
            vm.movImm64(VReg.RET, 0x7ffb000000000000n); // was lea+load _js const
        }
        // async generator 体内 yield:resolve 当前 next() Promise 再挂起(见 emitAsyncYieldValue)。
        // 普通生成器保持原路径(逐字节不变)。
        if (this.ctx.inAsyncGenerator) {
            this.emitAsyncYieldValue();
        } else {
            this.emitYieldValue(); // 挂起 RET；恢复后 RET = next(v)/throw 注入值
        }
    },

    // [async generator] yield 值 = resolve coro+88(当前挂起的 next() Promise){value, done:false},
    // 清 +88(标记"已 yield 非 await/完成"),再 _coroutine_yield 挂起。恢复后 RET = next(v) 注入值
    // (由 _coroutine_resume 写 coro+72)。异常注入(agen.throw)处理与同步 yield 同构。
    emitAsyncYieldValue() {
        const vm = this.vm;
        // 构造 {value:RET, done:false}
        vm.mov(VReg.A0, VReg.RET);
        vm.lea(VReg.A1, "_js_false");
        vm.load(VReg.A1, VReg.A1, 0);
        vm.call("_generator_make_result"); // RET = boxed {value, done:false}
        // coro = _scheduler_current；resolve coro+88 = P
        vm.lea(VReg.V1, "_scheduler_current");
        vm.load(VReg.V1, VReg.V1, 0); // V1 = coro
        vm.push(VReg.V1); // 跨 _promise_resolve 保 coro
        vm.mov(VReg.A1, VReg.RET); // result
        vm.load(VReg.A0, VReg.V1, 88); // A0 = P(boxed)
        vm.call("_promise_resolve");
        vm.pop(VReg.V1); // coro
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.V1, 88, VReg.V0); // 清 +88
        // 挂起;恢复后 RET = coro+72(next(v) 注入值)
        vm.call("_coroutine_yield");
        // [agen.throw] 恢复后异常注入检查(与 emitYieldValue 同构)
        const contLabel = this.ctx.newLabel("ayield_no_exc");
        vm.push(VReg.RET);
        vm.lea(VReg.V0, "_exception_pending");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq(contLabel);
        vm.pop(VReg.RET);
        if (this.ctx.exceptionLabel) {
            vm.jmp(this.ctx.exceptionLabel);
        } else if (this.ctx.returnLabel) {
            vm.jmp(this.ctx.returnLabel);
        } else {
            this.emitUnhandledExceptionExit();
        }
        vm.label(contLabel);
        vm.pop(VReg.RET);
    },

    // 把 RET 作为 yield 值挂起协程；恢复后 RET = next(v) 传入的 v。
    // [gen.throw] 恢复后检查异常注入:_exception_pending 置位表示 gen.throw(e) 注入了异常
    //  —— 有体内 try 则跳其 catch(exceptionLabel);无则跳 returnLabel 完成协程(pending 保留,
    //     _generator_throw 见 COMPLETED+pending 向调用者传播)。与 compileAwaitExpression 同构。
    emitYieldValue() {
        const vm = this.vm;
        // 当前协程指针（x64: V1=RCX=A3 此处无在飞实参，可用；勿用 V0=RAX=RET）
        vm.lea(VReg.V1, "_scheduler_current");
        vm.load(VReg.V1, VReg.V1, 0);
        vm.store(VReg.V1, 72, VReg.RET); // coro.result = yield 值
        vm.call("_coroutine_yield"); // 挂起；恢复后 RET = resume value

        const contLabel = this.ctx.newLabel("yield_no_exc");
        const retChkLabel = this.ctx.newLabel("yield_retchk");
        vm.push(VReg.RET); // 暂存 resume 值,保证各路径栈平衡
        vm.lea(VReg.V0, "_exception_pending");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq(retChkLabel);
        vm.pop(VReg.RET);
        if (this.ctx.exceptionLabel) {
            vm.jmp(this.ctx.exceptionLabel);
        } else if (this.ctx.returnLabel) {
            // 体内无 try:完成协程,pending 保留 → 回 _generator_throw 传播给调用者
            vm.jmp(this.ctx.returnLabel);
        } else {
            this.emitUnhandledExceptionExit();
        }
        // [gen.return] 注入检查:_generator_return 置 _gen_return_pending 后 resume。
        // 见 pending → 清零、取注入值为返回值,内联跑挂起点与出口间的 finalizer
        // (emitPendingFinalizers 按本 yield 的词法 finallyStack,RET 经 __finally_retval
        // 槽保命;finalizer 内含 yield 则协程再次挂起,恢复后继续走到 returnLabel),
        // 最终以该值完成协程 → _generator_return 返回 {value, done:true}。
        vm.label(retChkLabel);
        vm.lea(VReg.V0, "_gen_return_pending");
        vm.load(VReg.V1, VReg.V0, 0);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq(contLabel);
        vm.pop(VReg.RET); // 弃 resume 值
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.V0, 0, VReg.V1); // 清 pending(消费一次)
        vm.lea(VReg.V0, "_gen_return_value");
        vm.load(VReg.RET, VReg.V0, 0); // RET = 注入返回值
        this.emitPendingFinalizers(0, true);
        if (this.ctx.returnLabel) {
            vm.jmp(this.ctx.returnLabel);
        } else {
            this.emitUnhandledExceptionExit();
        }
        vm.label(contLabel);
        vm.pop(VReg.RET);
    },

    // [收尾] yield* 委托:对可迭代对象取迭代器,逐值 yield 直到 done,表达式值 = 被委托者
    //  return 值(done 时 result.value)。生成器套生成器经协程 resumer 链(coroutine.js)嵌套。
    //  数组快路(tag 0x7ffe)按下标遍历,表达式值 = undefined(同 node)。
    //  通用路:obj[Symbol.iterator]().next() 循环(生成器自迭代;普通迭代器对象命中)。
    //  偏差:next(v) 恒以 undefined 调用(不转发外层 next 传入值)。
    compileYieldStar(expr) {
        const vm = this.vm;

        const iterableTemp = this.ctx.allocLocal(`__ys_iterable_${this.nextLabelId()}`);
        const iteratorTemp = this.ctx.allocLocal(`__ys_iterator_${this.nextLabelId()}`);
        const resultTemp = this.ctx.allocLocal(`__ys_result_${this.nextLabelId()}`);
        const arrTemp = this.ctx.allocLocal(`__ys_arr_${this.nextLabelId()}`);
        const idxTemp = this.ctx.allocLocal(`__ys_idx_${this.nextLabelId()}`);

        const notArrayLabel = this.ctx.newLabel("ystar_notarray");
        const arrLoopLabel = this.ctx.newLabel("ystar_arrloop");
        const undefLabel = this.ctx.newLabel("ystar_undef");
        const iterLoopLabel = this.ctx.newLabel("ystar_iterloop");
        const iterDoneLabel = this.ctx.newLabel("ystar_iterdone");
        const endLabel = this.ctx.newLabel("ystar_end");

        this.compileExpression(expr.argument);
        vm.store(VReg.FP, iterableTemp, VReg.RET);

        // 数组快路(tag 0x7ffe)
        vm.mov(VReg.V0, VReg.RET);
        vm.shrImm(VReg.V0, VReg.V0, 48);
        vm.cmpImm(VReg.V0, 0x7ffe);
        vm.jne(notArrayLabel);
        // x64: shrImm 毁了 RET(V0==RAX),从槽重载
        if (this.vm.backend.name === "x64") this.vm.load(VReg.RET, VReg.FP, iterableTemp);
        vm.emitMaskLoad(VReg.V1);
        vm.andMaskReg(VReg.V0, VReg.RET, VReg.V1);
        vm.store(VReg.FP, arrTemp, VReg.V0);
        vm.movImm(VReg.V0, 0);
        vm.store(VReg.FP, idxTemp, VReg.V0);
        vm.label(arrLoopLabel);
        vm.load(VReg.V0, VReg.FP, idxTemp);
        vm.load(VReg.V1, VReg.FP, arrTemp);
        vm.load(VReg.V1, VReg.V1, 8); // 当前长度 @8
        vm.cmp(VReg.V0, VReg.V1);
        vm.jge(undefLabel); // 数组遍历完:表达式值 = undefined
        vm.load(VReg.V1, VReg.FP, arrTemp);
        vm.load(VReg.V1, VReg.V1, 24); // data_ptr @24
        vm.load(VReg.V0, VReg.FP, idxTemp);
        vm.shlImm(VReg.V0, VReg.V0, 3);
        vm.add(VReg.V0, VReg.V1, VReg.V0);
        vm.load(VReg.RET, VReg.V0, 0);
        this.emitYieldValue(); // yield 元素
        vm.load(VReg.V0, VReg.FP, idxTemp);
        vm.addImm(VReg.V0, VReg.V0, 1);
        vm.store(VReg.FP, idxTemp, VReg.V0);
        vm.jmp(arrLoopLabel);
        vm.label(notArrayLabel);

        // 通用迭代器路:obj[Symbol.iterator]()
        vm.load(VReg.A0, VReg.FP, iterableTemp);
        this.emitBoxedStringKey("Symbol.iterator", VReg.A1);
        vm.call("_object_get");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq(undefLabel);
        vm.mov(VReg.V6, VReg.RET);
        vm.load(VReg.V5, VReg.FP, iterableTemp);
        this.compileMethodCall(VReg.V6, VReg.V5, []);
        vm.store(VReg.FP, iteratorTemp, VReg.RET);

        vm.label(iterLoopLabel);
        // it.next()
        vm.load(VReg.A0, VReg.FP, iteratorTemp);
        this.emitBoxedStringKey("next", VReg.A1);
        vm.call("_object_get");
        vm.cmpImm(VReg.RET, 0);
        vm.jeq(undefLabel);
        vm.mov(VReg.V6, VReg.RET);
        vm.load(VReg.V5, VReg.FP, iteratorTemp);
        this.compileMethodCall(VReg.V6, VReg.V5, []);
        vm.store(VReg.FP, resultTemp, VReg.RET);
        // done?
        vm.load(VReg.A0, VReg.FP, resultTemp);
        this.emitBoxedStringKey("done", VReg.A1);
        vm.call("_object_get");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_to_boolean");
        vm.cmpImm(VReg.RET, 0);
        vm.jne(iterDoneLabel);
        // yield result.value
        vm.load(VReg.A0, VReg.FP, resultTemp);
        this.emitBoxedStringKey("value", VReg.A1);
        vm.call("_object_get"); // RET = value
        this.emitYieldValue();
        vm.jmp(iterLoopLabel);

        vm.label(iterDoneLabel);
        // 表达式值 = result.value(被委托者 return 值)
        vm.load(VReg.A0, VReg.FP, resultTemp);
        this.emitBoxedStringKey("value", VReg.A1);
        vm.call("_object_get");
        vm.jmp(endLabel);

        vm.label(undefLabel);
        vm.movImm64(VReg.RET, 0x7ffb000000000000n); // was lea+load _js const
        vm.label(endLabel);
        // RET = yield* 表达式值
    },

    // [批次D] 生成器函数 stub：函数标签处不执行体，改为创建协程+生成器对象。
    // 进入时寄存器状态与普通函数调用一致：A0..=实参(A0=p0,A1=p1..A4=p4)、S0=闭包指针
    // (闭包路径)或 0/垃圾、A5=this。
    // 建协程后需把 2-5 号实参(A1-A4)回填进协程(+112..+136),供 _coroutine_entry 首次
    // resume 时恢复成生成器体的多实参。因需在 _generator_new 返回后做回填,改用带 prologue
    // 的 call(而非旧的尾跳)——语义等价(生成器函数正常返回 genobj 给调用者)。
    // 紧随其后落 bodyLabel，调用方继续在该点编译真正的函数体(经 _coroutine_entry 进入)。
    // async generator：stub 与生成器同构,仅构造器换成 _async_generator_new。
    emitAsyncGeneratorStub(bodyLabel, hasClosure) {
        this.emitGeneratorStub(bodyLabel, hasClosure, "_async_generator_new");
    },

    emitGeneratorStub(bodyLabel, hasClosure, ctorFn) {
        const vm = this.vm;
        if (!ctorFn) ctorFn = "_generator_new"; // 缺省=同步生成器(既有调用点字节不变)
        vm.prologue(0, [VReg.S3]); // 存 FP/LR + S3(用于跨 _generator_new 保住 A5=this)
        vm.mov(VReg.S3, VReg.A5);  // S3 = this(A5);callee-saved,survives _generator_new
        // 先把 2-5 号实参压栈(4 个=32B,16 对齐),随后覆盖 A0/A1/A2 供 _generator_new
        vm.push(VReg.A1);
        vm.push(VReg.A2);
        vm.push(VReg.A3);
        vm.push(VReg.A4);
        vm.mov(VReg.A1, VReg.A0); // A1 = 首参
        if (hasClosure) {
            vm.mov(VReg.A2, VReg.S0); // 闭包路径：S0 = 闭包对象指针
        } else {
            vm.movImm(VReg.A2, 0); // 顶层声明：无闭包
        }
        vm.lea(VReg.A0, bodyLabel);
        vm.call(ctorFn); // RET = genobj/async-genobj；_gen_last_coro = 新建协程裸指针
        // 回填多实参到协程(coro 在 scratch 全局)。逆序 pop 到 A1-A4,再存 coro+112..136。
        // A1-A4 均非 RET(RAX/X0),故 RET=genobj 全程存活。
        vm.lea(VReg.V6, "_gen_last_coro");
        vm.load(VReg.V6, VReg.V6, 0); // V6 = coro
        vm.store(VReg.V6, 144, VReg.S3); // this(A5)→ coro+144(CORO_THIS),_coroutine_entry 恢复
        vm.pop(VReg.A4);
        vm.pop(VReg.A3);
        vm.pop(VReg.A2);
        vm.pop(VReg.A1);
        vm.store(VReg.V6, 112, VReg.A1);
        vm.store(VReg.V6, 120, VReg.A2);
        vm.store(VReg.V6, 128, VReg.A3);
        vm.store(VReg.V6, 136, VReg.A4);
        vm.epilogue([VReg.S3], 0); // ret：返回 genobj；恢复 S3
        vm.label(bodyLabel);
    },

    // async 方法 stub:方法标签处不执行体,建协程+Promise+入调度队列,返回 Promise。
    // 与 async 函数调用(compileAsyncCall)同构,但把建协程放在**方法体标签**处(方法以
    // 裸函数指针 0x7fff|label 存表,调用点 compileMethodCall 不识别 async,故由 stub 自建)。
    // 入口寄存器:A0-A4=实参(A0=p0..A4=p4)、A5=this、S0=闭包(闭包路径,类方法为 0)。
    // 真正方法体在 bodyLabel(经 _coroutine_entry 首次 resume 进入,用 async 返回路径 resolve
    // coro+88 的 Promise)。
    emitAsyncMethodStub(bodyLabel, hasClosure) {
        const vm = this.vm;
        vm.prologue(0, [VReg.S1, VReg.S2, VReg.S3]);
        vm.mov(VReg.S3, VReg.A5); // S3 = this(A5),callee-saved
        vm.push(VReg.A1);
        vm.push(VReg.A2);
        vm.push(VReg.A3);
        vm.push(VReg.A4);
        vm.mov(VReg.A1, VReg.A0); // A1 = 首参
        if (hasClosure) {
            vm.mov(VReg.A2, VReg.S0);
        } else {
            vm.movImm(VReg.A2, 0);
        }
        vm.lea(VReg.A0, bodyLabel);
        vm.call("_coroutine_create"); // RET = coro
        vm.mov(VReg.S2, VReg.RET); // S2 = coro(callee-saved)
        vm.store(VReg.S2, 144, VReg.S3); // CORO_THIS = this
        vm.pop(VReg.A4);
        vm.pop(VReg.A3);
        vm.pop(VReg.A2);
        vm.pop(VReg.A1);
        vm.store(VReg.S2, 112, VReg.A1);
        vm.store(VReg.S2, 120, VReg.A2);
        vm.store(VReg.S2, 128, VReg.A3);
        vm.store(VReg.S2, 136, VReg.A4);
        // Promise + 关联 + 入队 + 返回
        vm.movImm(VReg.A0, 0);
        vm.call("_promise_new");
        vm.mov(VReg.S1, VReg.RET); // S1 = Promise
        vm.store(VReg.S2, 88, VReg.S1); // coro.promise
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_scheduler_spawn");
        vm.mov(VReg.RET, VReg.S1); // 返回 Promise
        vm.epilogue([VReg.S1, VReg.S2, VReg.S3], 0);
        vm.label(bodyLabel);
    },

    // 编译 async 函数调用
    // 创建协程并返回 Promise
    // [方言] js f(x) 协程派发:被调方与实参**现在**求值(当前协程,左到右),调用本身
    // 作为新协程投递调度队列(fire-and-forget,无返回值)。运行时经 _spawn_tramp 进入:
    // coro+64(A0)=被调值(装箱/裸,蹦床统一分派 closure/bare/async-stub/proxy),
    // CORO_ARG1-4(A1-A4)=实参 0-3(Stage-0 上限 4 个),CORO_THIS(A5)=方法接收者。
    // argc 在 _coroutine_create 前写 _call_argc → 快照进 CORO_ARGC → 蹦床调用时新鲜。
    compileSpawnStatement(stmt) {
        const vm = this.vm;
        const call = stmt.call;
        const args = call.arguments || [];
        const n = Math.min(args.length, 4);
        const fSlot = this.ctx.allocLocal(`__spawn_f_${this.nextLabelId()}`);
        const thisSlot = this.ctx.allocLocal(`__spawn_t_${this.nextLabelId()}`);
        // 被调方求值:非计算成员 obj.m → 分别求 obj(this)与方法值(经 _maybe_getter);
        // 其它形态求值整个 callee,this=undefined。
        const callee = call.callee;
        if (callee && callee.type === "MemberExpression" && !callee.computed &&
            callee.property && callee.property.type === "Identifier") {
            this.compileExpression(callee.object);
            vm.store(VReg.FP, thisSlot, VReg.RET);
            vm.mov(VReg.A0, VReg.RET);
            this.emitBoxedStringKey(callee.property.name, VReg.A1);
            vm.call("_object_get");
            vm.mov(VReg.A0, VReg.RET);
            vm.load(VReg.A1, VReg.FP, thisSlot);
            vm.call("_maybe_getter");
            vm.store(VReg.FP, fSlot, VReg.RET);
        } else {
            this.compileExpression(callee);
            vm.store(VReg.FP, fSlot, VReg.RET);
            vm.movImm64(VReg.V1, 0x7ffb000000000000n); // this = undefined
            vm.store(VReg.FP, thisSlot, VReg.V1);
        }
        // 实参左到右求值落槽
        const argSlots = [];
        for (let i = 0; i < n; i++) {
            this.compileExpression(args[i]);
            const s = this.ctx.allocLocal(`__spawn_a${i}_${this.nextLabelId()}`);
            vm.store(VReg.FP, s, VReg.RET);
            argSlots.push(s);
        }
        // argc → _call_argc(创建快照读取);建协程:func=_spawn_tramp, arg0=被调值
        this.emitSetCallArgc(n);
        vm.lea(VReg.A0, "_spawn_tramp");
        vm.load(VReg.A1, VReg.FP, fSlot);
        vm.movImm(VReg.A2, 0);
        vm.call("_coroutine_create");
        vm.mov(VReg.S2, VReg.RET); // S2 = coro(callee-saved,同 compileAsyncCall 惯例)
        // 回填实参 1-4 与 this
        const coroArgOff = [112, 120, 128, 136];
        for (let i = 0; i < n; i++) {
            vm.load(VReg.V1, VReg.FP, argSlots[i]);
            vm.store(VReg.S2, coroArgOff[i], VReg.V1);
        }
        vm.load(VReg.V1, VReg.FP, thisSlot);
        vm.store(VReg.S2, 144, VReg.V1); // CORO_THIS
        // 投递调度队列(事件循环轮到时运行)
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_scheduler_spawn");
    },

    compileAsyncCall(funcPtr, args) {
        const vm = this.vm;

        // async 函数声明调用:建协程 + 返回 Promise。closure_ptr=0(顶层声明无闭包)。
        // [多实参透传] 协程实参约定(见 _coroutine_entry):A0=coro+64(首参)、A1-A4=
        // coro+112/120/128/136(CORO_ARG1-4)。_coroutine_create 仅存首参、清零 CORO_ARG1-4;
        // 次参 2-5 在 create 后由本调用点回填。此前只编 args[0] → `f(x,y)` 丢 y。最多 5 参。
        // funcPtr 与各实参先落 FP 局部槽:compileExpression 会自由冲寄存器(架构无关,无裸栈)。
        const argc = args ? Math.min(args.length, 5) : 0;
        const fpSlot = this.ctx.allocLocal(`__async_fp_${this.nextLabelId()}`);
        vm.store(VReg.FP, fpSlot, funcPtr);
        const argSlots = [];
        for (let i = 0; i < argc; i++) {
            this.compileExpression(args[i]);
            const slot = this.ctx.allocLocal(`__async_darg${i}_${this.nextLabelId()}`);
            vm.store(VReg.FP, slot, VReg.RET);
            argSlots.push(slot);
        }

        // [argc] 实参求值(上方 compileExpression)可能含嵌套调用把 _call_argc 写脏;
        // 在 _coroutine_create 快照前按本调用点实参数回写。
        this.emitSetCallArgc(argc);
        // 组装 _coroutine_create(A0=func_ptr, A1=首参|0, A2=0)
        vm.load(VReg.A0, VReg.FP, fpSlot); // func_ptr
        if (argc > 0) {
            vm.load(VReg.A1, VReg.FP, argSlots[0]); // 首参
        } else {
            vm.movImm(VReg.A1, 0);
        }
        vm.movImm(VReg.A2, 0);
        vm.call("_coroutine_create");
        vm.mov(VReg.S2, VReg.RET); // S2 = 协程(callee-saved,跨下方 call 稳)

        // 回填次参 2-5 到 CORO_ARG1-4(coro+112/120/128/136)。V1 scratch(下无 call 打断)。
        const coroArgOff = [112, 120, 128, 136];
        for (let i = 1; i < argc; i++) {
            vm.load(VReg.V1, VReg.FP, argSlots[i]);
            vm.store(VReg.S2, coroArgOff[i - 1], VReg.V1);
        }

        // 创建 Promise
        vm.movImm(VReg.A0, 0);
        vm.call("_promise_new");
        vm.mov(VReg.S3, VReg.RET); // S3 = Promise

        // 将协程与 Promise 关联
        vm.store(VReg.S2, 88, VReg.S3); // coro.promise = Promise

        // 将协程加入调度队列
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_scheduler_spawn");

        // 返回 Promise
        vm.mov(VReg.RET, VReg.S3);
    },

    // 检查闭包是否是 async 函数
    // 在 compileClosureCall 中调用
    checkAsyncClosure(closureReg, asyncLabel) {
        const vm = this.vm;

        // 加载 magic
        vm.load(VReg.V1, closureReg, 0);
        vm.movImm(VReg.V2, ASYNC_CLOSURE_MAGIC);
        vm.cmp(VReg.V1, VReg.V2);
        vm.jeq(asyncLabel);
    },

    // 编译 async 函数返回
    // async 函数 return 跳到 returnLabel，由 emitAsyncResolveAndReturnFromRet 处理
    compileAsyncReturn(expr) {
        const vm = this.vm;

        // 编译返回值
        if (expr && expr.argument) {
            this.compileExpression(expr.argument);
        } else {
            vm.movImm(VReg.RET, 0);
        }

        // 跳到 returnLabel，统一处理 resolve + epilogue
        vm.jmp(this.ctx.returnLabel);
    },

    // async 函数体内**未捕获**的异常(throw / await 到 reject):拒绝该函数关联的 Promise
    // 而非 emitUnhandledExceptionExit(退出)。异常值在 _exception_value(compileThrowStatement/
    // compileAwaitExpression 已置),清 _exception_pending 后 reject(coro.promise, value)、epilogue。
    // 由 async 函数体把 ctx.exceptionLabel 指到此块的标签触发。
    emitAsyncRejectFromException() {
        const vm = this.vm;
        const skip = this.ctx.newLabel("async_rej_no_promise");
        vm.lea(VReg.V1, "_scheduler_current");
        vm.load(VReg.V1, VReg.V1, 0);      // 当前协程
        vm.load(VReg.V2, VReg.V1, 88);     // 关联 Promise
        vm.cmpImm(VReg.V2, 0);
        vm.jeq(skip);
        vm.lea(VReg.V0, "_exception_value");
        vm.load(VReg.A1, VReg.V0, 0);      // 拒因
        vm.mov(VReg.A0, VReg.V2);
        vm.call("_promise_reject");
        vm.lea(VReg.V0, "_exception_pending");
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.V0, 0, VReg.V1);     // 清 pending(已作为拒因交给 Promise)
        vm.label(skip);
        vm.movImm(VReg.RET, 0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 8192);
    },

    // async 函数返回（RET 已经是返回值）
    // 用于把所有 return 汇聚到 returnLabel 统一处理
    // resolve Promise 后正常 epilogue 返回，由 _coroutine_entry 处理协程结束
    emitAsyncResolveAndReturnFromRet() {
        const vm = this.vm;

        // 保存返回值
        vm.push(VReg.RET);

        // 获取当前协程
        vm.lea(VReg.V1, "_scheduler_current");
        vm.load(VReg.V1, VReg.V1, 0);

        // 获取关联的 Promise
        vm.load(VReg.V2, VReg.V1, 88);

        // 如果有 Promise，resolve 它
        vm.cmpImm(VReg.V2, 0);
        const noPromiseLabel = this.ctx.newLabel("async_ret_no_promise");
        vm.jeq(noPromiseLabel);

        vm.pop(VReg.A1); // 返回值
        vm.push(VReg.A1); // 保留一份
        vm.mov(VReg.A0, VReg.V2);
        vm.call("_promise_resolve");

        vm.label(noPromiseLabel);
        // 恢复返回值，然后正常 epilogue
        vm.pop(VReg.RET);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 8192);
    },

    // 生成调度器初始化调用
    // 在程序入口处调用
    generateSchedulerInit() {
        this.vm.call("_scheduler_init");
    },

    // 生成调度器运行调用
    // 在程序结束前调用，确保所有协程完成
    generateSchedulerRun() {
        this.vm.call("_scheduler_run");
    },
};
