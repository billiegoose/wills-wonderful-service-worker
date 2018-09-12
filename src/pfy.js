export const pfy = function (fn) {
  return function (a, cb) {
    return new Promise(function(resolve, reject) {
      fn(a, (err, result) => err ? reject(err) : resolve(result))
    });
  }
}
