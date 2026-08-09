// Dynamic property descriptors must distinguish an absent field from a field
// whose value is explicitly undefined, including inherited descriptor fields.
var first = {};
var accessorDescriptor = { get: undefined };
Object.defineProperty(first, "accessor", accessorDescriptor);
var accessor = Object.getOwnPropertyDescriptor(first, "accessor");
console.log(
  Object.hasOwn(accessor, "get"),
  Object.hasOwn(accessor, "set"),
  Object.hasOwn(accessor, "value"),
  accessor.get,
  accessor.set
);

var frozenAccessor = {};
var getter = function () { return 1; };
Object.defineProperty(frozenAccessor, "value", {
  get: getter,
  configurable: false
});
var changedGetter = false;
try {
  var clearGetter = { get: undefined };
  Object.defineProperty(frozenAccessor, "value", clearGetter);
} catch (error) {
  changedGetter = error instanceof TypeError;
}
console.log(changedGetter, frozenAccessor.value);

var frozenData = {};
Object.defineProperty(frozenData, "value", {
  value: 1,
  writable: false,
  configurable: false
});
var changedValue = false;
try {
  var clearValue = { value: undefined };
  Object.defineProperty(frozenData, "value", clearValue);
} catch (error) {
  changedValue = error instanceof TypeError;
}
console.log(changedValue, frozenData.value);

var attributes = { writable: undefined, configurable: undefined };
var assigned = { value: 1 };
Object.defineProperty(assigned, "value", attributes);
var assignedDescriptor = Object.getOwnPropertyDescriptor(assigned, "value");
console.log(assignedDescriptor.writable, assignedDescriptor.configurable);

var inherited = Object.create({ get: undefined });
var inheritedTarget = {};
Object.defineProperty(inheritedTarget, "value", inherited);
var inheritedResult = Object.getOwnPropertyDescriptor(inheritedTarget, "value");
console.log(
  Object.hasOwn(inheritedResult, "get"),
  Object.hasOwn(inheritedResult, "value")
);

var viaProperties = {};
var descriptorMap = { value: { get: undefined } };
Object.defineProperties(viaProperties, descriptorMap);
var propertiesResult = Object.getOwnPropertyDescriptor(viaProperties, "value");
console.log(
  Object.hasOwn(propertiesResult, "get"),
  Object.hasOwn(propertiesResult, "value")
);

// Exotic containers store named properties in a side table that the generic
// `in` helper does not currently inspect. Preserve their non-undefined fields.
var arrayDescriptor = [];
arrayDescriptor.writable = true;
var arrayDescriptorTarget = {};
Object.defineProperty(arrayDescriptorTarget, "value", arrayDescriptor);
arrayDescriptorTarget.value = 2;
console.log(arrayDescriptorTarget.value);

// ToPropertyDescriptor observes fields in specification order, independent of
// the source order in which the descriptor object's properties were created.
var order = [];
var orderedDescriptor = {};
["set", "get", "writable", "value", "configurable", "enumerable"].forEach(function (key) {
  Object.defineProperty(orderedDescriptor, key, {
    get: function () {
      order.push(key);
      return key === "get" || key === "set" ? undefined : true;
    },
    configurable: true
  });
});
try {
  Object.defineProperty({}, "ordered", orderedDescriptor);
} catch (error) {
  // The descriptor deliberately mixes data and accessor fields.
}
console.log(order.join(","));

// A callable descriptor map may expose an enumerable descriptor through its
// function-property side table.
var functionMapAccessed = false;
var functionMap = function () {};
Object.defineProperty(functionMap, "fromFunction", {
  get: function () {
    functionMapAccessed = true;
    return {};
  },
  enumerable: true
});
Object.defineProperties({}, functionMap);
console.log(functionMapAccessed);
