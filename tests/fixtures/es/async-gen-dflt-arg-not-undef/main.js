var obj = {};
var falseCount = 0;
var stringCount = 0;
var nanCount = 0;
var zeroCount = 0;
var nullCount = 0;
var objCount = 0;
var callCount = 0;
var ref = async function*(aFalse = falseCount += 1, aString = stringCount += 1, aNaN = nanCount += 1, a0 = zeroCount += 1, aNull = nullCount += 1, aObj = objCount += 1) {
    if (aFalse !== false) throw new Error("aFalse");
    if (aString !== "") throw new Error("aString");
    if (aNaN === aNaN) throw new Error("aNaN");
    if (a0 !== 0) throw new Error("a0=" + a0);
    if (aNull !== null) throw new Error("aNull");
    if (aObj !== obj) throw new Error("aObj");
    callCount = callCount + 1;
};
ref(false, "", NaN, 0, null, obj).next().then(function () {
    console.log(callCount, falseCount, stringCount, nanCount, zeroCount, nullCount, objCount);
});
