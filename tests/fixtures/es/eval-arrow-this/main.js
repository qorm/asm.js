var obj = {
  foo: function() { return eval("()=>this"); }
};
console.log(obj.foo()() === obj);
