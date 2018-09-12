import { Comlink } from 'comlinkjs'

export function proxyEventEmitter (com) {
  return {
    on (namespace, callback) {
      com.on(namespace, Comlink.proxyValue(callback))
    },
    addEventListener (namespace, callback) {
      com.addEventListener(namespace, Comlink.proxyValue(callback))
    },
    off (namespace, callback) {
      com.off(namespace, Comlink.proxyValue(callback))
    },
    removeEventListener (namespace, callback) {
      com.removeEventListener(namespace, Comlink.proxyValue(callback))
    },
    once (namespace, callback) {
      com.once(namespace, Comlink.proxyValue(callback))
    },
    emit (namespace, data) {
      com.emit(namespace, data)
    },
    postMessage (namespace, data) {
      com.postMessage(namespace, data)
    }
  }
}
