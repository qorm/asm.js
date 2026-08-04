// asm.js 运行时 - RegExp 支持
// 实现 JavaScript 正则表达式的基本功能
// 注意：这是一个简化版本，只支持基本的字符串匹配

import { VReg } from "../../../vm/index.js";

// RegExp 对象内存布局:
// +0:  type (8 bytes) = TYPE_REGEXP (8)
// +8:  pattern (8 bytes) - 指向模式字符串的指针
// +16: flags (8 bytes) - 标志位 (g=1, i=2, m=4)
// +24: lastIndex (8 bytes) - 上次匹配位置（用于 g 标志）

const TYPE_REGEXP = 8;
const REGEXP_SIZE = 32;

export class RegExpGenerator {
    constructor(vm) {
        this.vm = vm;
    }

    generate() {
        const vm = this.vm;

        // _regexp_new - 创建新的 RegExp 对象
        // A0 = 模式字符串指针
        // A1 = 标志 (整数: g=1, i=2, m=4)
        vm.label("_regexp_new");
        vm.prologue(16, [VReg.S0, VReg.S1]);

        vm.mov(VReg.S0, VReg.A0); // 保存模式
        vm.mov(VReg.S1, VReg.A1); // 保存标志

        // 分配 RegExp 对象
        vm.movImm(VReg.A0, REGEXP_SIZE);
        vm.call("_alloc");

        // 设置类型
        vm.movImm(VReg.V1, TYPE_REGEXP);
        vm.store(VReg.RET, 0, VReg.V1);

        // 设置模式
        vm.store(VReg.RET, 8, VReg.S0);

        // 设置标志
        vm.store(VReg.RET, 16, VReg.S1);

        // 初始化 lastIndex 为 0
        vm.movImm(VReg.V1, 0);
        vm.store(VReg.RET, 24, VReg.V1);

        vm.epilogue([VReg.S0, VReg.S1], 16);

        // _regexp_test - 测试字符串是否匹配
        // A0 = RegExp 对象指针
        // A1 = 输入字符串指针
        // 返回: 1 = 匹配, 0 = 不匹配
        vm.label("_regexp_test");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);

        vm.mov(VReg.S0, VReg.A0); // regexp 对象
        vm.mov(VReg.S1, VReg.A1); // 输入字符串

        // 加载模式字符串
        vm.load(VReg.S2, VReg.S0, 8); // pattern
        // 加载标志
        vm.load(VReg.S3, VReg.S0, 16); // flags

        // 调用简单的字符串包含检查
        // 简化版本：只检查输入是否包含模式
        vm.mov(VReg.A0, VReg.S1); // 输入字符串
        vm.mov(VReg.A1, VReg.S2); // 模式字符串
        vm.call("_strstr"); // 搜索子字符串

        // 如果返回值 != 0，表示找到了
        vm.cmpImm(VReg.RET, 0);
        const notFoundLabel = "_regexp_test_not_found";
        const doneLabel = "_regexp_test_done";
        vm.jeq(notFoundLabel);

        vm.movImm(VReg.RET, 1);
        vm.jmp(doneLabel);

        vm.label(notFoundLabel);
        vm.movImm(VReg.RET, 0);

        vm.label(doneLabel);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);

        // _strstr - 简单的子字符串搜索
        // A0 = 主字符串
        // A1 = 模式字符串
        // 返回: 匹配位置指针，0 表示不匹配
        vm.label("_strstr");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);

        vm.mov(VReg.S0, VReg.A0); // 主字符串
        vm.mov(VReg.S1, VReg.A1); // 模式字符串

        // 外层循环：遍历主字符串
        const outerLoop = "_strstr_outer";
        const innerLoop = "_strstr_inner";
        const matchedLabel = "_strstr_matched";
        const nextPosLabel = "_strstr_next";
        const notFoundLabel2 = "_strstr_not_found";
        const doneLabel2 = "_strstr_done";

        vm.label(outerLoop);
        // 检查主字符串是否结束
        vm.loadByte(VReg.V1, VReg.S0, 0);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq(notFoundLabel2);

        // 内层循环：比较模式
        vm.mov(VReg.S2, VReg.S0); // 当前主字符串位置
        vm.mov(VReg.S3, VReg.S1); // 模式字符串起始

        vm.label(innerLoop);
        // 检查主字符串是否结束（先检查，避免越界）
        vm.loadByte(VReg.V2, VReg.S2, 0);
        vm.cmpImm(VReg.V2, 0);
        vm.jeq(notFoundLabel2); // 主字符串结束，模式未完成

        // 检查模式是否结束
        vm.loadByte(VReg.V1, VReg.S3, 0);
        vm.cmpImm(VReg.V1, 0);
        vm.jeq(matchedLabel); // 模式全部匹配

        // 比较字符
        vm.cmp(VReg.V1, VReg.V2);
        vm.jne(nextPosLabel); // 不匹配，尝试下一个位置

        // 字符匹配，继续下一个
        vm.addImm(VReg.S2, VReg.S2, 1);
        vm.addImm(VReg.S3, VReg.S3, 1);
        vm.jmp(innerLoop);

        vm.label(matchedLabel);
        // 返回匹配位置
        vm.mov(VReg.RET, VReg.S0);
        vm.jmp(doneLabel2);

        vm.label(nextPosLabel);
        // 尝试下一个位置
        vm.addImm(VReg.S0, VReg.S0, 1);
        vm.jmp(outerLoop);

        vm.label(notFoundLabel2);
        vm.movImm(VReg.RET, 0);

        vm.label(doneLabel2);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);

        // _regexp_exec - 执行正则匹配并返回结果数组
        // A0 = RegExp 对象指针
        // A1 = 输入字符串指针
        // 返回: 结果数组指针，null (0) 表示不匹配
        // 注意：简化版本，总是返回 null。完整的 exec() 已由纯 JS 的
        // __regexp_shim 路线取代（builtin_methods.js 正则方法分派），
        // 此标号保留为回退 stub。
        vm.label("_regexp_exec");
        vm.prologue(48, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);

        vm.mov(VReg.S0, VReg.A0); // regexp 对象
        vm.mov(VReg.S1, VReg.A1); // 输入字符串

        // 加载模式字符串
        vm.load(VReg.S2, VReg.S0, 8); // pattern

        // 搜索匹配位置
        vm.mov(VReg.A0, VReg.S1); // 输入字符串
        vm.mov(VReg.A1, VReg.S2); // 模式字符串
        vm.call("_strstr");

        // 检查是否找到
        vm.mov(VReg.S3, VReg.RET); // 保存匹配位置
        vm.cmpImm(VReg.S3, 0);
        const noMatchLabel = "_regexp_exec_no_match";
        const doneLabelExec = "_regexp_exec_done";
        vm.jeq(noMatchLabel);

        // 找到匹配，但简化版本只返回匹配位置指针（作为字符串）
        // 返回匹配开始位置的字符串
        vm.mov(VReg.RET, VReg.S3);
        vm.jmp(doneLabelExec);

        vm.label(noMatchLabel);
        vm.movImm(VReg.RET, 0);

        vm.label(doneLabelExec);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 48);

        // _memcpy - 内存复制
        // A0 = dest
        // A1 = src
        // A2 = len
        vm.label("_memcpy");
        vm.prologue(16, [VReg.S0, VReg.S1]);

        vm.mov(VReg.S0, VReg.A0); // dest
        vm.mov(VReg.S1, VReg.A1); // src
        vm.mov(VReg.V2, VReg.A2); // len

        const copyLoop = "_memcpy_loop";
        const copyDone = "_memcpy_done";

        vm.label(copyLoop);
        vm.cmpImm(VReg.V2, 0);
        vm.jeq(copyDone);

        vm.loadByte(VReg.V1, VReg.S1, 0);
        vm.storeByte(VReg.S0, 0, VReg.V1);

        vm.addImm(VReg.S0, VReg.S0, 1);
        vm.addImm(VReg.S1, VReg.S1, 1);
        vm.subImm(VReg.V2, VReg.V2, 1);
        vm.jmp(copyLoop);

        vm.label(copyDone);
        vm.mov(VReg.RET, VReg.A0); // 返回 dest
        vm.epilogue([VReg.S0, VReg.S1], 16);

        // _regexp_search(regexp_raw, string_ptr) → match index or -1
        // A0 = RegExp 对象原始指针
        // A1 = 输入字符串裸指针
        // 返回: 裸整数(匹配位置,未匹配=-1)
        vm.label("_regexp_search");
        vm.prologue(16, [VReg.S0, VReg.S1]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.S1, VReg.A1);
        vm.load(VReg.A1, VReg.S0, 8); // regexp.pattern
        vm.call("_strstr");           // RET = match ptr 或 0
        vm.cmpImm(VReg.RET, 0);
        vm.jne("_res_found");
        vm.movImm(VReg.RET, -1); // not found
        vm.jmp("_res_ret");
        vm.label("_res_found");
        vm.sub(VReg.RET, VReg.RET, VReg.S1); // offset = matchPtr - strPtr
        vm.label("_res_ret");
        vm.epilogue([VReg.S0, VReg.S1], 16);

        // _regexp_split(re_ptr, str_ptr, limit_boxed) → 装箱数组
        // A0 = RegExp 对象原始指针
        // A1 = 输入字符串裸指针
        // A2 = limit(装箱 JSNumber)
        vm.label("_regexp_split");
        vm.prologue(64, [VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4]);
        vm.mov(VReg.S0, VReg.A0); // re_ptr
        vm.mov(VReg.S1, VReg.A1); // str_ptr
        // 结果数组
        vm.movImm(VReg.A0, 0);
        vm.call("_array_new_with_size");
        vm.mov(VReg.S2, VReg.RET); // S2 = 装箱结果数组
        // 当前偏移 S3 = 0
        vm.movImm(VReg.S3, 0);
        // pattern 在 re_ptr+8; load once
        vm.load(VReg.S4, VReg.S0, 8); // S4 = pattern 指针
        const reSpLoop = "_respl_loop_v2";
        const reSpDone = "_respl_done_v2";
        const reSpPush = "_respl_push_v2";
        vm.label(reSpLoop);
        // 从当前偏移开始搜索: _strstr(strPtr + S3, pattern)
        vm.mov(VReg.A0, VReg.S1);
        vm.add(VReg.A0, VReg.A0, VReg.S3); // A0 = strPtr + offset
        vm.mov(VReg.A1, VReg.S4);          // pattern
        vm.call("_strstr");
        vm.mov(VReg.V0, VReg.RET);         // V0 = match ptr or 0
        vm.cmpImm(VReg.V0, 0);
        vm.jeq(reSpPush);                  // no more matches → push remainder
        // 切段 str.substr(S3, matchPtr - (strPtr + S3))
        vm.sub(VReg.A2, VReg.V0, VReg.S1); // A2 = match absolute offset
        vm.sub(VReg.A2, VReg.A2, VReg.S3); // A2 = len = matchOffset - currentOffset
        vm.push(VReg.A2);                  // save len
        vm.mov(VReg.A0, VReg.S1);          // str base
        vm.mov(VReg.A1, VReg.S3);          // start offset
        vm.pop(VReg.A2);                   // restore len
        vm.call("_str_substring_raw");
        vm.mov(VReg.A1, VReg.RET);         // 装箱段
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_array_push");
        // 跳过匹配文本: S3 = matchOffset + patternLen
        vm.mov(VReg.A0, VReg.S4);
        vm.call("_strlen");               // pattern len
        vm.sub(VReg.S3, VReg.V0, VReg.S1); // S3 = matchPtr - strPtr (= matchOffset)
        vm.add(VReg.S3, VReg.S3, VReg.RET); // S3 = matchOffset + patternLen
        vm.jmp(reSpLoop);
        // push 最后一段
        vm.label(reSpPush);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_strlen");               // total len
        vm.mov(VReg.A1, VReg.S3);          // offset
        vm.sub(VReg.A2, VReg.RET, VReg.S1); // len = total - offset
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_str_substring_raw");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S2);
        vm.call("_array_push");
        vm.label(reSpDone);
        vm.mov(VReg.RET, VReg.S2);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3, VReg.S4], 64);
    }
}
