// asm.js 编译器 - 异步函数编译
// 编译 async 函数和 await 表达式

import { VReg } from "../../vm/index.js";
import { collectPatternNames } from "../../lang/analysis/closure.js";

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
        } else if (this.ctx.inCoroBody && this.ctx.returnLabel) {
            // [gen/async-gen unwind] 协程体内 await 到 reject 且无本地 try:完成协程
            // (pending 保留),由 _generator_next/_async_generator_next 在调用方栈上传播
            // (生成器 → reject 该次 next() Promise;async generator → reject)。与
            // emitYieldValue / emitAsyncYieldValue 的裸 throw 同构。
            vm.jmp(this.ctx.returnLabel);
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
        if (this.ctx.inAsyncGenerator) {
            // [async generator] AsyncGeneratorYield:先 Await(yield 值)再产出。
            // `yield Promise.reject(e)` 须使该次 next() Promise reject(e)(而非把 Promise
            // 当值产出)。await 只对 Promise 施加(非 Promise 值原样返回)。reject → 异常
            // 传播:体内有 try 走其 catch,无则完成协程(pending 保留)由 _async_generator_next
            // reject 本次 next() 的 Promise。
            const yieldDone = this.ctx.newLabel("ayieldval_done");
            vm.mov(VReg.A0, VReg.RET);
            vm.push(VReg.RET);
            vm.call("_is_promise");     // RET = 1 若为 Promise
            vm.cmpImm(VReg.RET, 0);
            vm.pop(VReg.RET);           // RET = yield 值(还原)
            vm.jeq(yieldDone);          // 非 Promise → 值即产出值
            vm.mov(VReg.A0, VReg.RET);
            vm.call("_promise_await");
            const yieldExcLabel = this.ctx.newLabel("ayieldval_no_exc");
            vm.push(VReg.RET);
            vm.lea(VReg.V0, "_exception_pending");
            vm.load(VReg.V1, VReg.V0, 0);
            vm.cmpImm(VReg.V1, 0);
            vm.jeq(yieldExcLabel);
            vm.pop(VReg.RET);
            if (this.ctx.exceptionLabel) {
                vm.jmp(this.ctx.exceptionLabel);
            } else if (this.ctx.inCoroBody && this.ctx.returnLabel) {
                vm.jmp(this.ctx.returnLabel);
            } else {
                this.emitUnhandledExceptionExit();
            }
            vm.label(yieldExcLabel);
            vm.pop(VReg.RET);
            vm.label(yieldDone);
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
    //  [async generator] async gen 体内 yield* 走异步迭代协议(Symbol.asyncIterator 优先,
    //  缺失则回退同步迭代器,复用 for-await-of 的脱糖风格),每轮 next() 结果 await 化。
    compileYieldStar(expr) {
        if (this.ctx.inAsyncGenerator) {
            this.compileYieldStarAsync(expr);
            return;
        }
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

    // [async generator] async gen 体内 yield* 的异步迭代协议实现。
    // 脱糖成合成 AST 复用现有 方法调用/await/while/yield 编译器(同 for-await-of 的
    // compileForAwaitDispatch 风格)。GetIterator(value, async) 语义:
    //   __am = __src[Symbol.asyncIterator]
    //   if (typeof __am === "function") { __it = __am.call(__src) }        // async 迭代器
    //   else if (__am === null || typeof __am === "undefined") {
    //     __it = __src[Symbol.iterator]()   // CreateAsyncFromSyncIterator:同步 next() 经 await 归一化
    //   } else { throw new TypeError }      // GetMethod:非 callable 非 null/undefined → TypeError
    //   while (true) {
    //     __r = await __it.next()
    //     if (__r.done) { __val = __r.value; break; }
    //     yield __r.value
    //   }
    //   RET = __val
    // yield 经 compileYieldExpression → inAsyncGenerator 走 emitAsyncYieldValue,
    // resolve 当前挂起的 next() Promise{value,done:false} 再挂起。
    compileYieldStarAsync(expr) {
        const vm = this.vm;
        const id = this.nextLabelId();
        const srcName = `__ysa_src_${id}`;
        const amName = `__ysa_am_${id}`;
        const itName = `__ysa_it_${id}`;
        const resName = `__ysa_res_${id}`;
        const valName = `__ysa_val_${id}`;
        const idn = (n) => ({ type: "Identifier", name: n });
        const member = (o, p, computed) => ({ type: "MemberExpression", object: o, property: p, computed: !!computed });
        const symAsyncIter = () => member(idn("Symbol"), idn("asyncIterator"), false);
        const symIter = () => member(idn("Symbol"), idn("iterator"), false);
        const asyncIterRef = member(idn(srcName), symAsyncIter(), true);
        const getIt = (symKey) => ({ type: "CallExpression", callee: member(idn(srcName), symKey(), true), arguments: [] });
        const typeofIs = (val, s) => ({ type: "BinaryExpression", operator: "===", left: { type: "UnaryExpression", operator: "typeof", argument: val }, right: { type: "StringLiteral", value: s } });
        // 循环体:while(true){ __r=await __it.next(); if(__r.done){__val=__r.value;break;} yield __r.value }
        const loopBody = { type: "WhileStatement", test: { type: "BooleanLiteral", value: true }, body: { type: "BlockStatement", body: [
            { type: "VariableDeclaration", kind: "const", declarations: [{ type: "VariableDeclarator", id: idn(resName), init: { type: "AwaitExpression", argument: { type: "CallExpression", callee: member(idn(itName), idn("next"), false), arguments: [] } } }] },
            { type: "IfStatement",
              test: member(idn(resName), idn("done"), false),
              consequent: { type: "BlockStatement", body: [
                  { type: "ExpressionStatement", expression: { type: "AssignmentExpression", operator: "=", left: idn(valName), right: member(idn(resName), idn("value"), false) } },
                  { type: "BreakStatement" },
              ] },
              alternate: null },
            { type: "ExpressionStatement", expression: { type: "YieldExpression", delegate: false, argument: member(idn(resName), idn("value"), false) } },
        ] } };
        // async 迭代器优先(null/undefined → 同步迭代器回退;其余非 callable → TypeError)。
        // 调用形态 src[Symbol.asyncIterator]()(成员调用,this=src)与 for-await-of 的
        // compileForAwaitDispatch 同构;typeof 分派已读过一次 getter,此分支再读一次
        // —— 与 for-await-of 的既有双读行为一致(test262 不计数该 getter)。
        const asyncBlock = { type: "BlockStatement", body: [
            { type: "VariableDeclaration", kind: "const", declarations: [{ type: "VariableDeclarator", id: idn(itName), init: { type: "CallExpression", callee: member(idn(srcName), symAsyncIter(), true), arguments: [] } }] },
            loopBody,
        ] };
        const syncBlock = { type: "BlockStatement", body: [
            { type: "VariableDeclaration", kind: "const", declarations: [{ type: "VariableDeclarator", id: idn(itName), init: getIt(symIter) }] },
            loopBody,
        ] };
        const typeErrorBlock = { type: "BlockStatement", body: [
            { type: "ThrowStatement", argument: { type: "NewExpression", callee: { type: "Identifier", name: "TypeError" }, arguments: [{ type: "Literal", value: "obj[Symbol.asyncIterator] is not a function" }] } },
        ] };
        const dispatch = { type: "BlockStatement", body: [
            { type: "VariableDeclaration", kind: "const", declarations: [{ type: "VariableDeclarator", id: idn(srcName), init: expr.argument }] },
            { type: "VariableDeclaration", kind: "const", declarations: [{ type: "VariableDeclarator", id: idn(amName), init: asyncIterRef }] },
            { type: "VariableDeclaration", kind: "let", declarations: [{ type: "VariableDeclarator", id: idn(valName), init: idn("undefined") }] },
            { type: "IfStatement",
              test: typeofIs(idn(amName), "function"),
              consequent: asyncBlock,
              alternate: { type: "BlockStatement", body: [
                  { type: "IfStatement",
                    test: { type: "BinaryExpression", operator: "===", left: idn(amName), right: { type: "Literal", value: null } },
                    consequent: syncBlock,
                    alternate: { type: "BlockStatement", body: [
                        { type: "IfStatement",
                          test: typeofIs(idn(amName), "undefined"),
                          consequent: syncBlock,
                          alternate: typeErrorBlock },
                    ] } },
              ] } },
        ] };
        this.compileStatement(dispatch);
        // RET = __val(yield* 表达式值 = 被委托者 return 值)
        const valOff = this.ctx.getLocal(valName);
        if (valOff) vm.load(VReg.RET, VReg.FP, valOff);
        else vm.movImm64(VReg.RET, 0x7ffb000000000000n);
    },

    // [批次D] 生成器函数 stub：函数标签处不执行体，改为创建协程+生成器对象。
    // 进入时寄存器状态与普通函数调用一致：A0..=实参(A0=p0,A1=p1..A4=p4)、S0=闭包指针
    // (闭包路径)或 0/垃圾、A5=this。
    // 建协程后需把 2-5 号实参(A1-A4)回填进协程(+112..+136),供 _coroutine_entry 首次
    // resume 时恢复成生成器体的多实参。因需在 _generator_new 返回后做回填,改用带 prologue
    // 的 call(而非旧的尾跳)——语义等价(生成器函数正常返回 genobj 给调用者)。
    // 紧随其后落 bodyLabel，调用方继续在该点编译真正的函数体(经 _coroutine_entry 进入)。
    // async generator：stub 与生成器同构,仅构造器换成 _async_generator_new。
    emitAsyncGeneratorStub(bodyLabel, hasClosure, capturedNames) {
        this.emitGeneratorStub(bodyLabel, hasClosure, "_async_generator_new", capturedNames);
    },

    emitGeneratorStub(bodyLabel, hasClosure, ctorFn, capturedNames) {
        const vm = this.vm;
        if (!ctorFn) ctorFn = "_generator_new"; // 缺省=同步生成器(既有调用点字节不变)
        // 栈尺寸 0→8192:[L2-②] eager 默认值探针(emitGenStubDefaultProbes)要在本帧
        // 分配临时槽;无解构参数的生成器探针零发射,多余栈空间仅浪费不入栈 —— 指令/字节
        // 只在含探针的生成器上变化。S3 仍用于跨 _generator_new 保住 A5=this。
        vm.prologue(8192, [VReg.S3]);
        // [FDI 提前] 解构参数守卫:规范里 FunctionDeclarationInstantiation 在**调用时**跑,
        // 故 `function* g({}){}` 的 `g(null)` 同步抛 TypeError,而非先返回生成器对象、把抛
        // 推迟到首次 .next()。见 emitGenStubParamGuards:只提前「可抛的那一步」,无解构参数
        // 的生成器一条指令都不多发(既有产物字节不变)。
        this.emitGenStubParamGuards(bodyLabel);
        // [L2-②] eager 参数默认值探针:把 A0-A4 实参先落临时槽,再按解构 pattern 的
        // 「读元素/属性 + 判 undefined → 求默认值」顺序提前走一遍。只对**安全默认值**
        // (仅引用未解析名或常量)生效;命中 unresolvable 默认值 → 调用时抛 ReferenceError
        // (规范 FunctionDeclarationInstantiation 在 [[Call]] 阶段求默认值,`g([undefined])`
        // 对 `[a=unresolvable]` 须同步抛)。成功路径只把外层默认值写回临时槽、不绑定——
        // 体内惰性绑定照旧,数组/字符串/对象源可重迭代,无观测副作用。
        const eagerSlots = this.emitGenStubEagerDefaults(bodyLabel, capturedNames);
        if (eagerSlots) {
            // 探针结果回填 A0-A4:简单标识符参数的默认值已求好(体见非 undefined 即跳过
            // 默认,天然避免双重求值);解构参数的外层默认值已写回,体内再解构同一值。
            for (let i = 0; i < eagerSlots.length; i++) {
                vm.load(vm.getArgReg(i), VReg.FP, eagerSlots[i]);
            }
        }
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
        // 栈尺寸须与 prologue(8192) 配对(epilogue 用 stackSize 恢复 SP;0 会令 SP 停在
        // 帧中段 → ret 从错误地址取返回地址 → 调用生成器函数即崩)。
        vm.epilogue([VReg.S3], 8192); // ret：返回 genobj；恢复 S3
        vm.label(bodyLabel);
    },

    // [L2-②] 生成器/async-gen 参数默认值 eager 探针入口:在 stub 入口把 A0-A4 实参落临时
    // 槽,再对每个解构/默认形参跑默认值探针。返回临时槽偏移数组(与形参一一对应),或
    // null(无探针可发/无解构参数)。临时槽只在 stub 帧内使用,调用方随后回填寄存器。
    emitGenStubEagerDefaults(bodyLabel, capturedNames) {
        const params = this._genStubParams(bodyLabel);
        if (!params || params.length === 0) return null;
        // 保存/恢复 ctx 栈状态:探针在 stub 帧内分配临时槽,不得污染外层(生成器定义处)
        // 的 locals/stackOffset —— 外层函数后续语句的槽位分配必须不受影响。
        const savedStackOffset = this.ctx.stackOffset;
        const savedLocals = this.ctx.locals;
        const savedBoxed = this.ctx.boxedVars;
        const savedVarTypes = this.ctx.varTypes;
        const savedCtx = this.ctx;
        this.ctx.stackOffset = 0;
        this.ctx.locals = {};
        this.ctx.boxedVars = new Set();
        this.ctx.varTypes = {};
        const vm = this.vm;
        const n = Math.min(params.length, 5);
        // 收集本函数全部形参绑定名:默认值若引用**同函数其它形参**(`[b=a]` 引用前参 a),
        // 探针帧里没绑 a → 求值会错抛 ReferenceError。这些名一律视为不可探针安全。
        const boundNames = {};
        for (let i = 0; i < params.length; i++) {
            collectPatternNames(params[i], boundNames);
        }
        // 闭包捕获名同样不可探针安全:生成器体经 S0 闭包捕获它们(如 `function make(){
        // const v=42; return function*([a=v]){…} }`),探针帧没有闭包捕获 → 把 v 误判为
        // unresolvable → 错抛 ReferenceError(零误拒违规)。顶层声明/类方法无捕获 → 空数组。
        if (capturedNames) {
            for (let i = 0; i < capturedNames.length; i++) {
                const cn = capturedNames[i];
                if (cn && typeof cn === "string") boundNames[cn] = true;
            }
        }
        // 安全判定须用**外层原 ctx**(生成器定义处作用域):重置后的探针帧 locals 为空,
        // 会把顶层 var/外层局部误判为 unresolvable → 探针求值错抛。safeFn 判定时临时切回
        // 原 ctx(编译期调用,仅影响本方法内的解析,不发指令)。
        const safeFn = (e) => {
            const c = this.ctx;
            this.ctx = savedCtx;
            let r;
            try { r = this._isEagerProbeSafe(e, boundNames); }
            finally { this.ctx = c; }
            return r;
        };
        const slots = [];
        for (let i = 0; i < n; i++) {
            const off = this.ctx.allocLocal(`__stubarg_${i}`);
            vm.store(VReg.FP, off, vm.getArgReg(i));
            slots.push(off);
        }
        for (let i = 0; i < n; i++) {
            const p = params[i];
            if (!p) continue;
            let pat = p, dflt = null;
            if (p.type === "AssignmentPattern") {
                // 外层默认值:undefined → 求默认值(若安全),结果写回槽供内层探针/回填用
                dflt = p.right;
                pat = p.left;
                if (dflt && safeFn(dflt)) {
                    const skip = this.ctx.newLabel("stub_odflt_skip");
                    const chkReg = vm.backend.name === "x64" ? VReg.V5 : VReg.V1;
                    const undReg = vm.backend.name === "x64" ? VReg.V6 : VReg.V2;
                    vm.load(chkReg, VReg.FP, slots[i]);
                    vm.movImm64(undReg, 0x7ffb000000000000n); // JS_UNDEFINED
                    vm.cmp(chkReg, undReg);
                    vm.jne(skip);
                    this.compileExpression(dflt);
                    vm.store(VReg.FP, slots[i], VReg.RET);
                    vm.label(skip);
                }
            } else if (p.type === "SpreadElement" || p.type === "RestElement") {
                continue; // rest 参数不探针(收集逻辑在体内,无默认值)
            }
            if (pat && (pat.type === "ObjectPattern" || pat.type === "ArrayPattern")) {
                this.emitGenStubDefaultProbes(pat, slots[i], boundNames, safeFn);
            }
        }
        this.ctx.stackOffset = savedStackOffset;
        this.ctx.locals = savedLocals;
        this.ctx.boxedVars = savedBoxed;
        this.ctx.varTypes = savedVarTypes;
        return slots;
    },

    // [L2-②] 递归默认值探针:按 pattern 的读取顺序,对每个带默认值(且默认值安全)的绑定位
    // 发「读源值 → 判 undefined → 求默认值」序列。源是数组/字符串/对象(可重读)时才探针,
    // 自定义迭代器/未装箱对象跳过 —— 探针用下标/属性读不消费迭代器,自定义迭代器须留给
    // 体内惰性绑定(重复消费会错值,零误拒)。嵌套 pattern 递归(临时槽落本 stub 帧)。
    emitGenStubDefaultProbes(pattern, srcSlot, boundNames, safeFn) {
        const vm = this.vm;
        if (!pattern) return;
        if (pattern.type === "ObjectPattern") {
            const props = pattern.properties || [];
            for (const p of props) {
                if (!p || p.type === "SpreadElement" || p.type === "RestElement") continue;
                let target = p.value, dflt = null;
                if (p.value && p.value.type === "AssignmentPattern") {
                    target = p.value.left;
                    dflt = p.value.right;
                }
                // 无默认值且无嵌套 pattern → 无可探针内容,整条跳过(免多余 tag 检查)
                const hasInner = target && (target.type === "ObjectPattern" || target.type === "ArrayPattern");
                if (!(dflt && safeFn(dflt)) && !hasInner) continue;
                // 计算键 prop:键表达式可能引用外层变量/有副作用,探针帧求值不可靠 → 跳过
                // (缺该 prop 的默认值提前触发,但绝不误抛;失败用例均用静态键)
                if (p.computed) continue;
                // 源必须是装箱对象才探针(对象解构读属性;数组/字符串不是对象,跳过)
                const okL = this.ctx.newLabel("stub_obj_ok");
                const skipL = this.ctx.newLabel("stub_obj_skip");
                vm.load(VReg.V0, VReg.FP, srcSlot);
                vm.shrImm(VReg.V1, VReg.V0, 48);
                vm.cmpImm(VReg.V1, 0x7FFD);
                vm.jeq(okL);
                vm.jmp(skipL);
                vm.label(okL);
                const keyName = p.key && (p.key.name || p.key.value);
                if (!keyName) { vm.jmp(skipL); continue; }
                vm.load(VReg.A0, VReg.FP, srcSlot);
                this.emitBoxedStringKey(keyName, VReg.A1);
                vm.call("_object_get");
                if (dflt && safeFn(dflt)) {
                    const dfltL = this.ctx.newLabel("stub_dflt");
                    const doneL = this.ctx.newLabel("stub_done");
                    vm.cmpImm(VReg.RET, 0);
                    vm.jeq(dfltL);
                    vm.shrImm(VReg.V1, VReg.RET, 48);
                    vm.cmpImm(VReg.V1, 0x7FFB); // tagged undefined
                    vm.jeq(dfltL);
                    vm.jmp(doneL);
                    vm.label(dfltL);
                    this.compileExpression(dflt); // 未解析名 → ReferenceError
                    vm.label(doneL);
                }
                if (target && (target.type === "ObjectPattern" || target.type === "ArrayPattern")) {
                    const subOff = this.ctx.allocLocal(`__stubsub_${this.nextLabelId()}`);
                    vm.store(VReg.FP, subOff, VReg.RET);
                    this.emitGenStubDefaultProbes(target, subOff, boundNames, safeFn);
                }
                vm.label(skipL);
            }
            return;
        }
        if (pattern.type === "ArrayPattern") {
            const els = pattern.elements || [];
            // 先统计是否有可探针内容;无 → 整条跳过(免多余 tag 检查/下标读)
            let hasProbe = false;
            for (let ei = 0; ei < els.length; ei++) {
                const el = els[ei];
                if (!el || el.type === "SpreadElement" || el.type === "RestElement") continue;
                const target = el.type === "AssignmentPattern" ? el.left : el;
                const dflt = el.type === "AssignmentPattern" ? el.right : null;
                if (dflt && safeFn(dflt)) { hasProbe = true; break; }
                if (target && (target.type === "ObjectPattern" || target.type === "ArrayPattern")) { hasProbe = true; break; }
            }
            if (!hasProbe) return;
            // 源必须是数组/字符串才探针(下标读;自定义迭代器跳过)
            const okL = this.ctx.newLabel("stub_ary_ok");
            const skipL = this.ctx.newLabel("stub_ary_skip");
            vm.load(VReg.V0, VReg.FP, srcSlot);
            vm.shrImm(VReg.V1, VReg.V0, 48);
            vm.cmpImm(VReg.V1, 0x7FFE); // array
            vm.jeq(okL);
            vm.cmpImm(VReg.V1, 0x7FFC); // string
            vm.jeq(okL);
            vm.jmp(skipL);
            vm.label(okL);
            for (let ei = 0; ei < els.length; ei++) {
                const el = els[ei];
                if (!el) continue;
                if (el.type === "SpreadElement" || el.type === "RestElement") continue;
                let target = el, dflt = null;
                if (el.type === "AssignmentPattern") {
                    target = el.left;
                    dflt = el.right;
                }
                vm.load(VReg.A0, VReg.FP, srcSlot);
                vm.movImm(VReg.A1, ei);
                vm.call("_subscript_get");
                if (dflt && safeFn(dflt)) {
                    const dfltL = this.ctx.newLabel("stub_dflt");
                    const doneL = this.ctx.newLabel("stub_done");
                    vm.cmpImm(VReg.RET, 0);
                    vm.jeq(dfltL);
                    vm.shrImm(VReg.V1, VReg.RET, 48);
                    vm.cmpImm(VReg.V1, 0x7FFB);
                    vm.jeq(dfltL);
                    vm.jmp(doneL);
                    vm.label(dfltL);
                    this.compileExpression(dflt);
                    vm.label(doneL);
                }
                if (target && (target.type === "ObjectPattern" || target.type === "ArrayPattern")) {
                    const subOff = this.ctx.allocLocal(`__stubsub_${this.nextLabelId()}`);
                    vm.store(VReg.FP, subOff, VReg.RET);
                    this.emitGenStubDefaultProbes(target, subOff, boundNames, safeFn);
                }
            }
            vm.label(skipL);
            return;
        }
        // 其它形参形态(Identifier / 其它)无内层默认值,不探针
    },

    // [L2-②] 默认值表达式是否可安全地 eager 探针求值:表达式里**所有**标识符要么是
    // 未解析名(compileIdentifier 将抛 ReferenceError,正是要提前触发的错误),要么是
    // 内建常量字面量(undefined/null/NaN/Infinity,编译期即可求值,双重求值无副作用)。
    // 保守优先:任何引用可解析名(局部/参数/捕获的外层变量/函数)的默认值都返回 false
    // —— 探针求值它们会读到错误的值(探针帧无闭包捕获),宁可不探针(体内惰性绑定正确),
    // 绝不错抛/错值(零误拒)。
    _isEagerProbeSafe(expr, boundNames) {
        if (!expr) return true;
        if (expr.type === "Identifier") {
            if (expr.name === "undefined" || expr.name === "null" ||
                expr.name === "NaN" || expr.name === "Infinity") return true;
            // 同函数形参名:探针帧没绑它们 → 求值会错抛,不可探针
            if (boundNames && Object.prototype.hasOwnProperty.call(boundNames, expr.name)) return false;
            if (this.isUnresolvableIdentifier && this.isUnresolvableIdentifier(expr)) return true;
            return false;
        }
        if (expr.type === "Literal" || expr.type === "NumericLiteral" ||
            expr.type === "StringLiteral" || expr.type === "BooleanLiteral" ||
            expr.type === "RegExpLiteral" || expr.type === "NullLiteral") return true;
        for (const k in expr) {
            if (k === "type" || k === "loc" || k === "range" || k === "start" || k === "end") continue;
            // 对象字面量的非计算键不是引用
            if (expr.type === "Property" && k === "key" && !expr.computed) continue;
            if (expr.type === "MemberExpression" && k === "property" && !expr.computed) continue;
            const v = expr[k];
            if (v && typeof v === "object") {
                if (Array.isArray(v)) {
                    for (let i = 0; i < v.length; i++) {
                        if (!this._isEagerProbeSafe(v[i], boundNames)) return false;
                    }
                } else {
                    if (!this._isEagerProbeSafe(v, boundNames)) return false;
                }
            }
        }
        return true;
    },

    // [FDI 提前·发射] 在生成器 stub 入口(建协程/生成器对象之前)发解构参数的 null/undefined
    // 守卫。判据与体内 emitDestructurePattern 的入口守卫**逐条一致**(同样只看 tagged
    // JS_NULL/JS_UNDEFINED 两个值),所以本项只是把体内本就会抛的那一次抛"提前到调用时",
    // 不会在任何体内不抛的情形下引入新异常;取属性、默认值表达式求值、迭代器展开等其余
    // 绑定工作仍留在协程体内惰性执行 —— 生成器体的惰性语义不变(体不会被提前跑)。
    // 带默认值的解构参数(`function* g({a} = {}){}`)只查 null:undefined 会被默认值接住
    // (与 emitParamDestructure 的 undefined→默认值判据一致)。
    // 寄存器:守卫只用 V6(x64=R11、arm64=X14),不与 A0-A5 别名,故 A0-A4 实参与 A5=this
    // 完好流向下面的 _generator_new/回填。抛路径调 _throw_type_error(内部 _throw_unwind
    // 跨帧),不返回,故不需要平衡本帧。
    emitGenStubParamGuards(bodyLabel) {
        const vm = this.vm;
        const pats = this._genStubGuardParams(bodyLabel);
        if (!pats || pats.length === 0) return; // 无解构参数:不发任何指令
        const throwLabel = bodyLabel + "_pguard_throw";
        const okLabel = bodyLabel + "_pguard_ok";
        for (let i = 0; i < pats.length; i++) {
            const argReg = vm.getArgReg(pats[i].index);
            vm.movImm64(VReg.V6, 0x7ffa000000000000n); // JS_NULL
            vm.cmp(argReg, VReg.V6);
            vm.jeq(throwLabel);
            if (!pats[i].dflt) {
                vm.movImm64(VReg.V6, 0x7ffb000000000000n); // JS_UNDEFINED
                vm.cmp(argReg, VReg.V6);
                vm.jeq(throwLabel);
            }
        }
        vm.jmp(okLabel);
        vm.label(throwLabel);
        vm.lea(VReg.A0, this.asm.addString("Cannot destructure 'null' or 'undefined'"));
        vm.call("_js_box_string");
        vm.mov(VReg.A0, VReg.RET);
        vm.call("_throw_type_error"); // 不返回
        vm.label(okLabel);
    },

    // 解析本 stub 对应函数的形参表,挑出需要提前守卫的解构参数位(实参寄存器上限 A0-A4)。
    // 返回 [{index, dflt}];dflt=true 表示该解构参数带默认值(只守 null)。
    _genStubGuardParams(bodyLabel) {
        const params = this._genStubParams(bodyLabel);
        if (!params) return null;
        const out = [];
        const n = params.length < 5 ? params.length : 5;
        for (let i = 0; i < n; i++) {
            const p = params[i];
            if (!p) continue;
            if (p.type === "ObjectPattern" || p.type === "ArrayPattern") {
                out.push({ index: i, dflt: false });
            } else if (p.type === "AssignmentPattern" && p.left &&
                (p.left.type === "ObjectPattern" || p.left.type === "ArrayPattern")) {
                out.push({ index: i, dflt: true });
            }
        }
        return out;
    },

    // stub 只拿到 bodyLabel(=<函数标签>_gbody),形参表按标签反查:
    //  1) 函数表达式/闭包(含对象字面量方法):pendingFunctions[i].label + "_gbody"
    //  2) 顶层函数声明:"_user_" + name + "_gbody"
    //  3) 类生成器方法:标签形如 _class_<类名>_[static_]<方法名>_<labelId>(见 compileClassMethod)
    // 反查不到(计算键方法、未登记形态)→ null,即不发守卫,保持既有行为。
    _genStubParams(bodyLabel) {
        if (typeof bodyLabel !== "string") return null;
        const suf = "_gbody";
        if (bodyLabel.length <= suf.length) return null;
        if (bodyLabel.slice(bodyLabel.length - suf.length) !== suf) return null;
        const label = bodyLabel.slice(0, bodyLabel.length - suf.length);
        const pend = this.pendingFunctions;
        if (pend) {
            for (let i = 0; i < pend.length; i++) {
                if (pend[i] && pend[i].label === label && pend[i].expr) {
                    return pend[i].expr.params || [];
                }
            }
        }
        const fns = this.ctx && this.ctx.functions;
        if (fns) {
            for (const nm in fns) {
                if ("_user_" + nm === label) {
                    const f = fns[nm];
                    return (f && f.params) || [];
                }
            }
        }
        return this._genStubClassMethodParams(label);
    },

    // 类生成器方法:AST 里没有「标签 → 方法节点」的登记表(compileClassMethod 只把 method
    // 留在自己的局部变量里),故按方法标签的构成反查:扫全部模块 AST 收集
    // {前缀 "_class_<类名>_[static_]<方法名>_", 形参表},再要求余下部分是纯数字 labelId。
    // 同名类+同名方法出现多次(嵌套/局部类)时:形参形状一致才用,不一致 → 返回 null 不发
    // 守卫(宁可漏抛,不可错抛)。
    _genStubClassMethodParams(label) {
        if (label.indexOf("_class_") !== 0) return null;
        const list = this._genStubClassIndex();
        let found = null;
        for (let i = 0; i < list.length; i++) {
            const e = list[i];
            if (label.length <= e.prefix.length) continue;
            if (label.slice(0, e.prefix.length) !== e.prefix) continue;
            const rest = label.slice(e.prefix.length);
            let allDigits = true;
            for (let c = 0; c < rest.length; c++) {
                const ch = rest.charCodeAt(c);
                if (ch < 48 || ch > 57) { allDigits = false; break; }
            }
            if (!allDigits) continue;
            if (found === null) {
                found = e.params;
            } else if (!this._genStubSameParamShape(found, e.params)) {
                return null; // 歧义:放弃守卫
            }
        }
        return found;
    },

    // 两个形参表的「解构位形状」是否一致(只比较守卫用得到的信息)
    _genStubSameParamShape(a, b) {
        const ga = this._genStubShapeOf(a);
        const gb = this._genStubShapeOf(b);
        if (ga.length !== gb.length) return false;
        for (let i = 0; i < ga.length; i++) {
            if (ga[i] !== gb[i]) return false;
        }
        return true;
    },

    _genStubShapeOf(params) {
        const out = [];
        const n = params.length < 5 ? params.length : 5;
        for (let i = 0; i < n; i++) {
            const p = params[i];
            if (!p) continue;
            if (p.type === "ObjectPattern" || p.type === "ArrayPattern") {
                out.push(i + ":0");
            } else if (p.type === "AssignmentPattern" && p.left &&
                (p.left.type === "ObjectPattern" || p.left.type === "ArrayPattern")) {
                out.push(i + ":1");
            }
        }
        return out;
    },

    // 全图收集类生成器方法的 {标签前缀, 形参表}。只在真的遇到类生成器方法 stub 时才建,
    // 建一次缓存(模块图在 codegen 前已解析完毕)。下行只沿「数组」与「带 .type 的 AST 节点」,
    // 避开 importInfo/moduleAst 之类旁路引用(循环依赖下会成环)。
    _genStubClassIndex() {
        if (this._genStubClassMeths) return this._genStubClassMeths;
        const out = [];
        const asts = [];
        const order = this._moduleOrder;
        if (order) {
            for (let i = 0; i < order.length; i++) asts.push(order[i]);
        }
        const cur = this._currentModuleAst;
        if (cur) {
            let has = false;
            for (let i = 0; i < asts.length; i++) {
                if (asts[i] === cur) { has = true; break; }
            }
            if (!has) asts.push(cur);
        }
        for (let i = 0; i < asts.length; i++) this._genStubScanClasses(asts[i], out, 0);
        this._genStubClassMeths = out;
        return out;
    },

    _genStubScanClasses(node, out, depth) {
        if (!node || typeof node !== "object" || depth > 512) return;
        if (Array.isArray(node)) {
            for (let i = 0; i < node.length; i++) this._genStubScanClasses(node[i], out, depth + 1);
            return;
        }
        if (typeof node.type !== "string") return;
        if ((node.type === "ClassDeclaration" || node.type === "ClassExpression") &&
            node.id && node.id.name && Array.isArray(node.body)) {
            const cn = node.id.name;
            for (let i = 0; i < node.body.length; i++) {
                const m = node.body[i];
                if (!m || m.type !== "MethodDefinition" || m.computed) continue;
                const fv = m.value;
                if (!isGeneratorFunction(fv)) continue;
                const mn = m.key && (m.key.name || m.key.value);
                if (!mn) continue;
                const pre = "_class_" + cn + "_" + (m.static ? "static_" : "") + mn + "_";
                out.push({ prefix: pre, params: fv.params || [] });
            }
        }
        for (const k in node) {
            const v = node[k];
            if (v && typeof v === "object") this._genStubScanClasses(v, out, depth + 1);
        }
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
