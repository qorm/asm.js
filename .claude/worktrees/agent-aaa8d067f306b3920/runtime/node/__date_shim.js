// asm.js Runtime - Date 本地化格式 shim(toLocaleString / toLocaleDateString /
// toLocaleTimeString)。codegen 把 d.toLocaleX() 改派成 __DATE_*(y,mo,d,h,mi,s) 调用
// (机理同 __number_shim);接收者的年/月/日/时/分/秒由调用点用 Date getter 静态派发提取,
// 本 shim 只做纯格式化。无 ICU:恒 en-US 默认格式,不解析 locale/options 参数。
//   toLocaleString      → "M/D/YYYY, H:MM:SS AM/PM"
//   toLocaleDateString  → "M/D/YYYY"
//   toLocaleTimeString  → "H:MM:SS AM/PM"
// asm.js 的 Date 无时区(getTimezoneOffset()==0):由本地分量构造的 Date 与 node 一致;
// 由裸时间戳构造的 Date(如 new Date(0))node 按机器时区、asm.js 按 UTC —— 记文档偏差。

function _p2(n) {
    n = n | 0;
    if (n < 0) n = 0;
    return n < 10 ? "0" + n : "" + n;
}

// h(0..23) mi s → "H:MM:SS AM/PM"(12 小时制,时无前导零,分秒两位)
function _time12(h, mi, s) {
    h = h | 0;
    var ampm = h < 12 ? "AM" : "PM";
    var h12 = h % 12;
    if (h12 === 0) h12 = 12;
    return h12 + ":" + _p2(mi) + ":" + _p2(s) + " " + ampm;
}

// mo 为 0 基(getMonth),显示 +1
function _date(y, mo, d) {
    return ((mo | 0) + 1) + "/" + (d | 0) + "/" + (y | 0);
}

export function __DATE_toLocaleDateString(y, mo, d) {
    return _date(y, mo, d);
}

export function __DATE_toLocaleTimeString(h, mi, s) {
    return _time12(h, mi, s);
}

export function __DATE_toLocaleString(y, mo, d, h, mi, s) {
    return _date(y, mo, d) + ", " + _time12(h, mi, s);
}

var _WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
var _MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// 星期几(0=Sun)由 y/mo(0基)/d 算出(Sakamoto)。避免多传一个 getUTCDay 实参
// (asm.js 调用约定仅 6 个参数寄存器,7 参会丢第 7 个)。
function _dow(y, mo, d) {
    y = y | 0; d = d | 0;
    var m = (mo | 0) + 1;
    var t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
    if (m < 3) y = y - 1;
    var w = (y + ((y / 4) | 0) - ((y / 100) | 0) + ((y / 400) | 0) + t[m - 1] + d) % 7;
    if (w < 0) w = w + 7;
    return w;
}

// toUTCString / toGMTString(同值):"Www, DD Mon YYYY HH:MM:SS GMT"(UTC 分量,确定性)
export function __DATE_toUTCString(y, mo, d, h, mi, s) {
    return _WD[_dow(y, mo, d)] + ", " + _p2(d) + " " + _MON[mo | 0] + " " + (y | 0) + " " +
        _p2(h) + ":" + _p2(mi) + ":" + _p2(s) + " GMT";
}

// toDateString:"Www Mon DD YYYY"(node 用本地日期;asm.js 无时区按 UTC → 本地分量构造的
// Date 与 node 一致,裸时间戳形按 UTC 记偏差)
export function __DATE_toDateString(y, mo, d) {
    return _WD[_dow(y, mo, d)] + " " + _MON[mo | 0] + " " + _p2(d) + " " + (y | 0);
}
