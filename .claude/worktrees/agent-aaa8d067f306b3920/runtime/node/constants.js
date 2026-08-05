// asm.js Runtime - Node.js Constants
export const constants = {
    EOF: 0
};

// 系统调用号表（按平台）。shim 层统一经 getSyscall 取号，
// 避免在各模块散落魔法数字。
// 平台必须每次调用时惰性求值：模块顶层 init 可能早于 _process_init，
// 那时 __get_process() 返回 undefined，若在此捕获成常量会永久锁死为 macos，
// 导致 linux 二进制发出 macos 系统调用号(0x2000001 等) → process.exit 等 segfault。
function _currentPlatform() {
    const p = __get_process();
    return (p && p.platform) || "macos";
}

function _currentArch() {
    const p = __get_process();
    return (p && p.arch) || "arm64";
}

export function getSyscall(name) {
    const _platform = _currentPlatform();
    if (_platform === "wasi") {
        // wasi 号名空间 = linux-x64(canonical),由宿主 shim(scripts/wasm_host.mjs)
        // 实现;进程类(fork/execve/...)在 wasm 无对应物,返回 -1 走消费方降级路径。
        if (name === "exit") return 60;
        if (name === "write") return 1;
        if (name === "read") return 0;
        if (name === "close") return 3;
        if (name === "open") return 2;
        if (name === "chmod") return 90;
        if (name === "unlink") return 87;
        if (name === "mkdir") return 83;
        if (name === "rmdir") return 84;
        if (name === "getrandom") return 318;
        return -1;
    }
    if (_platform === "linux") {
        if (_currentArch() === "x64") {
            // linux-x64 调用号（与 arm64 完全不同：arm64 表的 openat=56
            // 在 x86_64 是 semget → fs shim 全挂、readFileSync 恒返空）
            if (name === "exit") return 60;
            if (name === "write") return 1;
            if (name === "read") return 0;
            if (name === "close") return 3;
            if (name === "open") return 2;
            if (name === "openat") return 257;
            if (name === "chmod") return 90;
            if (name === "fchmodat") return 268;
            if (name === "unlink") return 87;
            if (name === "unlinkat") return 263;
            if (name === "mkdir") return 83;
            if (name === "mkdirat") return 258;
            if (name === "rmdir") return 84;
            if (name === "getrandom") return 318;
            if (name === "execve") return 59;
            // child_process(execSync/spawnSync):fork+dup2+wait4 就地捕获
            if (name === "fork") return 57;
            if (name === "getpid") return 39;
            if (name === "wait4") return 61;
            if (name === "dup2") return 33;
            // net (synchronous TCP): socket family
            if (name === "socket") return 41;
            if (name === "connect") return 42;
            if (name === "accept") return 43;
            if (name === "bind") return 49;
            if (name === "listen") return 50;
            if (name === "setsockopt") return 54;
            if (name === "getsockname") return 51;
            // net readiness polling (async event loop): poll(2)
            if (name === "poll") return 7;
            if (name === "shutdown") return 48; // half-close (SHUT_WR) on socket.end()
            if (name === "sendmsg") return 46;   // dgram/UDP (linux-x64)
            if (name === "recvmsg") return 47;
            return -1;
        }
        // linux-arm64 调用号
        if (name === "exit") return 93;
        if (name === "write") return 64;
        if (name === "read") return 63;
        if (name === "close") return 57;
        if (name === "openat") return 56;
        if (name === "fchmodat") return 53; // linux-arm64：chmod 用 fchmodat(AT_FDCWD,...)
        if (name === "unlinkat") return 35; // linux-arm64 无 unlink,用 unlinkat(AT_FDCWD,...)
        if (name === "mkdirat") return 34;  // linux-arm64 无 mkdir,用 mkdirat(AT_FDCWD,...)
        if (name === "getrandom") return 278;
        if (name === "execve") return 221;
        // child_process:linux-arm64 无 fork/dup2,用 clone(SIGCHLD)/dup3
        if (name === "clone") return 220;
        if (name === "getpid") return 172;
        if (name === "wait4") return 260;
        if (name === "dup3") return 24;
        // net (synchronous TCP): socket family (linux-arm64)
        if (name === "socket") return 198;
        if (name === "bind") return 200;
        if (name === "listen") return 201;
        if (name === "accept") return 202;
        if (name === "connect") return 203;
        if (name === "setsockopt") return 208;
        if (name === "getsockname") return 205;
        // net readiness polling (async event loop): linux-arm64 has no poll(2);
        // use ppoll (73). net's poll pump detects arm64 and passes a timespec.
        if (name === "poll") return 73;
        if (name === "shutdown") return 210; // half-close (SHUT_WR) on socket.end()
        if (name === "sendmsg") return 211;  // dgram/UDP (linux-arm64)
        if (name === "recvmsg") return 212;
        return -1;
    }
    // macos (arm64/x64): 0x2000000 | n
    if (name === "exit") return 33554433;   // 0x2000001
    if (name === "read") return 33554435;   // 0x2000003
    if (name === "write") return 33554436;  // 0x2000004
    if (name === "open") return 33554437;   // 0x2000005
    if (name === "close") return 33554438;  // 0x2000006
    if (name === "unlink") return 33554442; // 0x200000A (macOS unlink = 10)
    if (name === "chmod") return 33554447;  // 0x200000F (macOS chmod = 15)
    if (name === "mkdir") return 33554568;  // 0x2000088 (macOS mkdir = 136)
    if (name === "rmdir") return 33554569;  // 0x2000089 (macOS rmdir = 137)
    if (name === "getentropy") return 33554932; // 0x20001F4 (macOS getentropy=500)
    if (name === "execve") return 33554491; // 0x200003B (macOS execve = 59)
    // child_process:macOS fork 父子 x0 同为 childpid(仅 x1 flag 区分,__syscall 只取 x0),
    // 故用 getpid()==forkRet 判子进程;pipe 亦经寄存器回传 x1,故改用临时文件重定向避开。
    if (name === "fork") return 33554434;   // 0x2000002 (macOS fork = 2)
    if (name === "getpid") return 33554452; // 0x2000014 (macOS getpid = 20)
    if (name === "wait4") return 33554439;  // 0x2000007 (macOS wait4 = 7)
    if (name === "dup2") return 33554522;   // 0x200005A (macOS dup2 = 90)
    // net (synchronous TCP): socket family (macOS BSD, 0x2000000 | n)
    if (name === "socket") return 33554529;     // 0x2000061 (socket = 97)
    if (name === "connect") return 33554530;    // 0x2000062 (connect = 98)
    if (name === "accept") return 33554462;     // 0x200001E (accept = 30)
    if (name === "bind") return 33554536;       // 0x2000068 (bind = 104)
    if (name === "listen") return 33554538;     // 0x200006A (listen = 106)
    if (name === "setsockopt") return 33554537; // 0x2000069 (setsockopt = 105)
    if (name === "getsockname") return 33554464; // 0x2000020 (getsockname = 32)
    if (name === "poll") return 33554662;        // 0x20000E6 (poll = 230)
    if (name === "shutdown") return 33554566;    // 0x2000086 (shutdown = 134)
    if (name === "sendmsg") return 33554460;     // 0x200001C (sendmsg = 28, dgram/UDP)
    if (name === "recvmsg") return 33554459;     // 0x200001B (recvmsg = 27)
    return -1;
}
// 注意：不可用返 -1 而非 0——linux-x64 的 read 调用号恰为 0，
// 消费方一律用 sc < 0 判不可用，禁止真值/|| 判断。

export default constants;
