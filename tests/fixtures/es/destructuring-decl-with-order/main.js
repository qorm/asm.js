var log = [];

var sourceKey = {
  toString: function () {
    log.push("sourceKey");
    return "p";
  }
};

var source = {
  get p() {
    log.push("get source");
    return undefined;
  }
};

var env = new Proxy({}, {
  has: function (target, propertyKey) {
    log.push("binding::" + propertyKey);
    return false;
  }
});

var defaultValue = 0;

with (env) {
  var { [sourceKey]: varTarget = defaultValue } = source;
}

console.log(log.join(","));
