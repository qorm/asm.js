var obj = {};
var objCount = 0;
var callCount = 0;
async function ref(aFalse, aString, aNaN, a0, aNull, aObj = objCount += 1) {
    if (aObj !== obj) throw new Error("sixth argument lost");
    callCount = callCount + 1;
}
ref(false, "", NaN, 0, null, obj).then(function () {
    console.log(callCount, objCount);
});
