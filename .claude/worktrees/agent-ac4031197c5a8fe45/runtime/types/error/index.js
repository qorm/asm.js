// asm.js 运行时 - Error 类型
// 提供 JavaScript Error 对象支持

import { VReg } from "../../../vm/index.js";

// Error 对象布局:
// +0:  type (TYPE_ERROR = 31)
// +8:  message (字符串指针)
// +16: name (字符串指针，如 "Error", "TypeError" 等)
// +24: stack (字符串指针)
// +32: cause (可选，异常原因)

const TYPE_ERROR = 31;
const ERROR_SIZE = 40;

// Error 子类型常量 (存储在 subtype 字段)
const ERROR_TYPE_ERROR = 0; // Error
const ERROR_TYPE_TYPEERROR = 1; // TypeError
const ERROR_TYPE_REFERENCEERROR = 2; // ReferenceError
const ERROR_TYPE_SYNTAXERROR = 3; // SyntaxError
const ERROR_TYPE_RANGEERROR = 4; // RangeError
const ERROR_TYPE_EVALERROR = 5; // EvalError
const ERROR_TYPE_URIERROR = 6; // URIError

export class ErrorGenerator {
    constructor(vm, ctx) {
        this.vm = vm;
        this.ctx = ctx;
    }

    generate() {
        this.generateErrorNew();
        this.generateErrorNewWithType();
        this.generateErrorGetMessage();
        this.generateErrorGetName();
        this.generateErrorGetCause();
        this.generateErrorSetCause();
        this.generateErrorToString();
        this.generateErrorNewWithCause();

        // 生成各种 Error 类型的工厂函数
        this.generateTypeErrorNew();
        this.generateReferenceErrorNew();
        this.generateSyntaxErrorNew();
        this.generateRangeErrorNew();
        this.generateEvalErrorNew();
        this.generateURIErrorNew();

        // 调用栈管理
        this.generateStackPush();
        this.generateStackPop();
        this.generateStackCapture();
    }

    // _stack_push(name_ptr) -> void
    // 将函数名压入调用栈
    generateStackPush() {
        const vm = this.vm;

        vm.label("_stack_push");
        vm.prologue(0, [VReg.S0, VReg.S1]);

        vm.mov(VReg.S0, VReg.A0); // S0 = name_ptr

        // 获取当前栈顶索引
        vm.lea(VReg.S1, "_call_stack_top");
        vm.load(VReg.V0, VReg.S1, 0);

        // 检查是否超出最大深度 (64)
        vm.cmpImm(VReg.V0, 64);
        vm.jge("_stack_push_done");

        // 计算栈槽位置: _call_stack + index * 8
        vm.shlImm(VReg.V1, VReg.V0, 3); // V1 = index * 8
        vm.lea(VReg.V2, "_call_stack");
        vm.add(VReg.V2, VReg.V2, VReg.V1); // V2 = &_call_stack[index]

        // 存储函数名指针
        vm.store(VReg.V2, 0, VReg.S0);

        // 增加栈顶索引
        vm.addImm(VReg.V0, VReg.V0, 1);
        vm.store(VReg.S1, 0, VReg.V0);

        vm.label("_stack_push_done");
        vm.epilogue([VReg.S0, VReg.S1], 0);
    }

    // _stack_pop() -> void
    // 弹出调用栈顶
    generateStackPop() {
        const vm = this.vm;

        vm.label("_stack_pop");
        vm.prologue(0, [VReg.S0]);

        // 获取当前栈顶索引
        vm.lea(VReg.S0, "_call_stack_top");
        vm.load(VReg.V0, VReg.S0, 0);

        // 检查是否已空
        vm.cmpImm(VReg.V0, 0);
        vm.jeq("_stack_pop_done");

        // 减少栈顶索引
        vm.subImm(VReg.V0, VReg.V0, 1);
        vm.store(VReg.S0, 0, VReg.V0);

        vm.label("_stack_pop_done");
        vm.epilogue([VReg.S0], 0);
    }

    // _stack_capture() -> 字符串 (stack trace)
    // 捕获当前调用栈并格式化为字符串（纯 char* 格式）
    generateStackCapture() {
        const vm = this.vm;

        vm.label("_stack_capture");
        vm.prologue(32, [VReg.S0, VReg.S1, VReg.S2, VReg.S3]);

        // 分配结果字符串缓冲区（纯 char*，无头部）
        vm.movImm(VReg.A0, 1024);
        vm.call("_alloc");
        vm.mov(VReg.S0, VReg.RET); // S0 = 结果字符串

        // S1 = 写入位置（直接从开始）
        vm.mov(VReg.S1, VReg.S0);

        // 获取栈顶索引
        vm.lea(VReg.S2, "_call_stack_top");
        vm.load(VReg.S2, VReg.S2, 0); // S2 = 栈深度

        // 从栈顶开始遍历 (逆序)
        vm.subImm(VReg.S3, VReg.S2, 1); // S3 = 当前索引

        vm.label("_stack_capture_loop");
        vm.cmpImm(VReg.S3, 0);
        vm.jlt("_stack_capture_done");

        // 写入 "    at "
        vm.lea(VReg.A0, "_str_at");
        vm.call("_getStrContent");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_strcpy");
        // 更新写入位置
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_raw_strlen");
        vm.add(VReg.S1, VReg.S1, VReg.RET);

        // 获取函数名
        vm.shlImm(VReg.V0, VReg.S3, 3);
        vm.lea(VReg.V1, "_call_stack");
        vm.add(VReg.V0, VReg.V1, VReg.V0);
        vm.load(VReg.V0, VReg.V0, 0); // V0 = 函数名指针

        // 复制函数名
        vm.mov(VReg.A0, VReg.V0);
        vm.call("_getStrContent");
        vm.mov(VReg.A1, VReg.RET);
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_strcpy");
        // 更新写入位置
        vm.mov(VReg.A0, VReg.S1);
        vm.call("_raw_strlen");
        vm.add(VReg.S1, VReg.S1, VReg.RET);

        // 写入换行符
        vm.movImm(VReg.V0, 10); // '\n'
        vm.storeByte(VReg.S1, 0, VReg.V0);
        vm.addImm(VReg.S1, VReg.S1, 1);

        // 下一个
        vm.subImm(VReg.S3, VReg.S3, 1);
        vm.jmp("_stack_capture_loop");

        vm.label("_stack_capture_done");
        // 写入 null 终止符
        vm.movImm(VReg.V0, 0);
        vm.storeByte(VReg.S1, 0, VReg.V0);

        // 纯 char* 格式，直接返回
        vm.mov(VReg.RET, VReg.S0);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2, VReg.S3], 32);
    }

    // _error_new(message) -> Error 对象
    // message 可以是字符串或 undefined
    generateErrorNew() {
        const vm = this.vm;

        vm.label("_error_new");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2]);

        vm.mov(VReg.S0, VReg.A0); // S0 = message

        // 分配 Error 对象
        vm.movImm(VReg.A0, ERROR_SIZE);
        vm.call("_alloc");
        vm.mov(VReg.S1, VReg.RET); // S1 = Error 对象

        // 设置类型
        vm.movImm(VReg.V0, TYPE_ERROR);
        vm.store(VReg.S1, 0, VReg.V0);

        // 设置 message
        vm.store(VReg.S1, 8, VReg.S0);

        // 设置 name 为 "Error"
        vm.lea(VReg.V0, "_str_Error");
        vm.store(VReg.S1, 16, VReg.V0);

        // 捕获调用栈
        vm.call("_stack_capture");
        vm.store(VReg.S1, 24, VReg.RET);

        // cause 设为 undefined
        vm.lea(VReg.V0, "_js_undefined");
        vm.store(VReg.S1, 32, VReg.V0);

        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 16);
    }

    // _error_get_message(err) -> message 字符串
    generateErrorGetMessage() {
        const vm = this.vm;

        vm.label("_error_get_message");
        vm.prologue(0, []);
        vm.load(VReg.RET, VReg.A0, 8);
        vm.epilogue([], 0);
    }

    // _error_get_name(err) -> name 字符串
    generateErrorGetName() {
        const vm = this.vm;

        vm.label("_error_get_name");
        vm.prologue(0, []);
        vm.load(VReg.RET, VReg.A0, 16);
        vm.epilogue([], 0);
    }

    // _error_get_cause(err) -> cause 值
    generateErrorGetCause() {
        const vm = this.vm;

        vm.label("_error_get_cause");
        vm.prologue(0, []);
        vm.load(VReg.RET, VReg.A0, 32);
        vm.epilogue([], 0);
    }

    // _error_set_cause(err, cause) -> void
    generateErrorSetCause() {
        const vm = this.vm;

        vm.label("_error_set_cause");
        vm.prologue(0, []);
        vm.store(VReg.A0, 32, VReg.A1);
        vm.epilogue([], 0);
    }

    // _error_new_with_type(message, name_ptr) -> Error 对象
    // 通用的带类型名的 Error 创建函数
    generateErrorNewWithType() {
        const vm = this.vm;

        vm.label("_error_new_with_type");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2]);

        vm.mov(VReg.S0, VReg.A0); // S0 = message
        vm.mov(VReg.S2, VReg.A1); // S2 = name_ptr

        // 分配 Error 对象
        vm.movImm(VReg.A0, ERROR_SIZE);
        vm.call("_alloc");
        vm.mov(VReg.S1, VReg.RET); // S1 = Error 对象

        // 设置类型
        vm.movImm(VReg.V0, TYPE_ERROR);
        vm.store(VReg.S1, 0, VReg.V0);

        // 设置 message
        vm.store(VReg.S1, 8, VReg.S0);

        // 设置 name
        vm.store(VReg.S1, 16, VReg.S2);

        // 捕获调用栈
        vm.call("_stack_capture");
        vm.store(VReg.S1, 24, VReg.RET);

        // cause 设为 undefined
        vm.lea(VReg.V0, "_js_undefined");
        vm.store(VReg.S1, 32, VReg.V0);

        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 16);
    }

    // _error_new_with_cause(message, cause) -> Error 对象
    // 创建带 cause 的 Error 对象
    generateErrorNewWithCause() {
        const vm = this.vm;

        vm.label("_error_new_with_cause");
        vm.prologue(16, [VReg.S0, VReg.S1, VReg.S2]);

        vm.mov(VReg.S0, VReg.A0); // S0 = message
        vm.mov(VReg.S2, VReg.A1); // S2 = cause

        // 分配 Error 对象
        vm.movImm(VReg.A0, ERROR_SIZE);
        vm.call("_alloc");
        vm.mov(VReg.S1, VReg.RET); // S1 = Error 对象

        // 设置类型
        vm.movImm(VReg.V0, TYPE_ERROR);
        vm.store(VReg.S1, 0, VReg.V0);

        // 设置 message
        vm.store(VReg.S1, 8, VReg.S0);

        // 设置 name 为 "Error"
        vm.lea(VReg.V0, "_str_Error");
        vm.store(VReg.S1, 16, VReg.V0);

        // stack 设为 undefined
        vm.lea(VReg.V0, "_js_undefined");
        vm.store(VReg.S1, 24, VReg.V0);

        // 设置 cause
        vm.store(VReg.S1, 32, VReg.S2);

        vm.mov(VReg.RET, VReg.S1);
        vm.epilogue([VReg.S0, VReg.S1, VReg.S2], 16);
    }

    // TypeError 工厂函数
    generateTypeErrorNew() {
        const vm = this.vm;
        vm.label("_typeerror_new");
        vm.prologue(0, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, "_str_TypeError");
        vm.call("_error_new_with_type");
        vm.epilogue([VReg.S0], 0);
    }

    // ReferenceError 工厂函数
    generateReferenceErrorNew() {
        const vm = this.vm;
        vm.label("_referenceerror_new");
        vm.prologue(0, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, "_str_ReferenceError");
        vm.call("_error_new_with_type");
        vm.epilogue([VReg.S0], 0);
    }

    // SyntaxError 工厂函数
    generateSyntaxErrorNew() {
        const vm = this.vm;
        vm.label("_syntaxerror_new");
        vm.prologue(0, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, "_str_SyntaxError");
        vm.call("_error_new_with_type");
        vm.epilogue([VReg.S0], 0);
    }

    // RangeError 工厂函数
    generateRangeErrorNew() {
        const vm = this.vm;
        vm.label("_rangeerror_new");
        vm.prologue(0, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, "_str_RangeError");
        vm.call("_error_new_with_type");
        vm.epilogue([VReg.S0], 0);
    }

    // EvalError 工厂函数
    generateEvalErrorNew() {
        const vm = this.vm;
        vm.label("_evalerror_new");
        vm.prologue(0, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, "_str_EvalError");
        vm.call("_error_new_with_type");
        vm.epilogue([VReg.S0], 0);
    }

    // URIError 工厂函数
    generateURIErrorNew() {
        const vm = this.vm;
        vm.label("_urierror_new");
        vm.prologue(0, [VReg.S0]);
        vm.mov(VReg.S0, VReg.A0);
        vm.mov(VReg.A0, VReg.S0);
        vm.lea(VReg.A1, "_str_URIError");
        vm.call("_error_new_with_type");
        vm.epilogue([VReg.S0], 0);
    }

    // _error_to_string(err) -> "Error: message" 字符串
    generateErrorToString() {
        const vm = this.vm;

        vm.label("_error_to_string");
        vm.prologue(16, [VReg.S0]);

        vm.mov(VReg.S0, VReg.A0); // S0 = Error 对象

        // 获取 name
        vm.load(VReg.A0, VReg.S0, 16);
        vm.push(VReg.A0);

        // 获取 message
        vm.load(VReg.A1, VReg.S0, 8);

        // 检查 message 是否为 undefined
        vm.lea(VReg.V0, "_js_undefined");
        vm.cmp(VReg.A1, VReg.V0);
        vm.jeq("_error_to_string_no_msg");

        // 有 message: 返回 "name: message"
        vm.pop(VReg.A0); // name
        vm.push(VReg.A1); // 保存 message

        // 连接 name + ": "
        vm.lea(VReg.A1, "_str_colon_space");
        vm.call("_strconcat");

        // 连接结果 + message
        vm.mov(VReg.A0, VReg.RET);
        vm.pop(VReg.A1);
        vm.call("_strconcat");
        vm.jmp("_error_to_string_done");

        vm.label("_error_to_string_no_msg");
        // 无 message: 只返回 name
        vm.pop(VReg.RET);

        vm.label("_error_to_string_done");
        vm.epilogue([VReg.S0], 16);
    }

    // 生成数据段
    generateDataSection(asm) {
        // 辅助函数：添加静态字符串（纯 char* 格式，无头部）
        const addStaticString = (label, str) => {
            asm.addDataLabel(label);
            const bytes = Buffer.from(str, "utf8");
            // 直接写入字符串内容
            for (let j = 0; j < bytes.length; j++) {
                asm.addDataByte(bytes[j]);
            }
            asm.addDataByte(0); // null terminator
        };

        // Error 类型名称字符串
        addStaticString("_str_Error", "Error");
        addStaticString("_str_TypeError", "TypeError");
        addStaticString("_str_ReferenceError", "ReferenceError");
        addStaticString("_str_SyntaxError", "SyntaxError");
        addStaticString("_str_RangeError", "RangeError");
        addStaticString("_str_EvalError", "EvalError");
        addStaticString("_str_URIError", "URIError");

        // ": " 分隔符
        addStaticString("_str_colon_space", ": ");

        // 堆栈相关字符串
        addStaticString("_str_at", "    at ");
        addStaticString("_str_newline", "\n");
        addStaticString("_str_anonymous", "<anonymous>");

        // Error 属性名字符串 (用于 _object_get 访问 Error 属性)
        addStaticString("_str_message", "message");
        addStaticString("_str_name", "name");
        addStaticString("_str_stack", "stack");
        addStaticString("_str_cause", "cause");

        // 调用栈数据结构
        // _call_stack_top: 当前栈顶索引 (8 字节)
        asm.addDataLabel("_call_stack_top");
        for (let i = 0; i < 8; i++) {
            asm.addDataByte(0);
        }

        // _call_stack: 函数名指针数组 (64 个槽位 * 8 字节 = 512 字节)
        asm.addDataLabel("_call_stack");
        for (let i = 0; i < 64 * 8; i++) {
            asm.addDataByte(0);
        }
    }
}
