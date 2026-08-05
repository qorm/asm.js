// asm.js 运行时 - Windows 文件系统面(自举需要)
// _win_open/_win_read/_win_write/_win_close:windows 目标发射真实 kernel32 IAT
// 调用(CreateFileA/ReadFile/WriteFile/CloseHandle,槽 5-8);其它平台发射
// 恒返 -1 的桩——fs shim 里 `platform === "windows"` 分支是运行时判断,
// 调用点在所有目标的产物里都存在,标签必须全平台可解析。

import { VReg } from "../../vm/registers.js";

export class WinFsGenerator {
    constructor(vm) {
        this.vm = vm;
    }

    generate() {
        const vm = this.vm;
        const isWin = vm.platform === "windows" || vm.os === "windows";

        vm.label("_win_open");
        if (isWin) {
            vm.backend.emitWinOpenBody();
        } else {
            this._stub();
        }

        vm.label("_win_read");
        if (isWin) {
            vm.backend.emitWinReadBody();
        } else {
            this._stub();
        }

        vm.label("_win_write");
        if (isWin) {
            vm.backend.emitWinWriteBody();
        } else {
            this._stub();
        }

        vm.label("_win_close");
        if (isWin) {
            vm.backend.emitWinCloseBody();
        } else {
            this._stub();
        }
    }

    _stub() {
        const vm = this.vm;
        vm.prologue(0, []);
        vm.movImm(VReg.RET, -1);
        vm.epilogue([], 0);
    }
}
