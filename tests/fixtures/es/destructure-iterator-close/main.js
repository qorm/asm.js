var nextCount = 0;
var returnCount = 0;

var iterable = {};
iterable[Symbol.iterator] = function () {
  var values = [10, 20, 30];
  var index = 0;
  return {
    next: function () {
      nextCount += 1;
      return index < values.length
        ? { value: values[index++], done: false }
        : { value: undefined, done: true };
    },
    return: function () {
      returnCount += 1;
      return { done: true };
    }
  };
};

var [value] = iterable;
console.log(value);
console.log(nextCount + " " + returnCount);
