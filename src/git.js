import { fs, fsReady } from './fs'

function useMyFilesystem(obj) {
  const handler = {
    get(target, propKey, receiver) {
      const targetValue = Reflect.get(target, propKey, receiver);
      if (typeof targetValue === 'function') {
        return function (...args) {
          // I reject your "fs" and substitute my own.
          Object.assign(args[0], {fs})
          let result = targetValue.apply(this, args);
          return result;
        }
      } else {
        return targetValue;
      }
    }
  };
  return new Proxy(obj, handler);
}

export { useMyFilesystem }
