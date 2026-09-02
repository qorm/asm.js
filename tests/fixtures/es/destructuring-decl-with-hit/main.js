var sourceKey = {
  toString: function () { return "p"; }
};
var source = {
  get p() { return undefined; }
};
var env = { varTarget: 99 };
var defaultValue = 7;

with (env) {
  var { [sourceKey]: varTarget = defaultValue } = source;
}

console.log(env.varTarget, typeof varTarget, String(varTarget));
