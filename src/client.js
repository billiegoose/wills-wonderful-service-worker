import { Comlink } from 'comlinkjs'
export let fs = null
export let fsEvents = null
export let git = null
export { Comlink }
export async function establishComlink () {
  let worker = (await navigator.serviceWorker.getRegistrations())[0].active

  let channel = new MessageChannel();
  worker.postMessage({type: 'comlink/expose', name: 'fs'}, [channel.port2])
  fs = Comlink.proxy(channel.port1)

  channel = new MessageChannel();
  worker.postMessage({type: 'comlink/expose', name: 'Events'}, [channel.port2])
  fsEvents = proxyEventEmitter(Comlink.proxy(channel.port1))

  channel = new MessageChannel();
  worker.postMessage({type: 'comlink/expose', name: 'git'}, [channel.port2])
  git = Comlink.proxy(channel.port1)
}

function proxyEventEmitter (com) {
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
