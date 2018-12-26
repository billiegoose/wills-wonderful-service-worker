// Because sometimes you have to write somethign yourself to make it right.

export class EventEmitter {
  constructor () {
    this.listeners = new Map()
    this.onceListeners = new Map()
    this.others = new Set()
  }

  on (namespace, callback) {
    let set = this.listeners.get(namespace)
    if (!set) {
      set = new Set()
      this.listeners.set(namespace, set)
    }
    set.add(callback)
  }
  addEventListener (namespace, callback) {
    this.on(namespace, callback)
  }

  off (namespace, callback) {
    if (callback) {
      this.listeners.get(namespace).delete(callback)
    } else {
      this.listeners.delete(namespace)
    }
  }
  removeEventListener (namespace, callback) {
    this.off(namespace, callback)
  }

  once (namespace, callback) {
    let set = this.onceListeners.get(namespace)
    if (!set) {
      set = new Set()
      this.onceListeners.set(namespace, set)
    }
    set.add(callback)
  }

  emit (namespace, data) {
    let set = this.listeners.get(namespace) || []
    for (let callback of set) {
      callback(data)
    }
    let onceSet = this.onceListeners.get(namespace) || []
    for (let callback of onceSet) {
      callback(data)
      onceSet.delete(callback)
    }
  }
  postMessage (namespace, data) {
    this.emit(namespace, data)
  }
}
