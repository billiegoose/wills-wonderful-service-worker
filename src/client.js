import { Comlink } from 'comlinkjs'
export let fs = null
export let fsEvents = null
export let git = null

export async function waitForWorker () {
  let reg = await navigator.serviceWorker.ready
  console.log('Ready!')
  let worker = reg.active
  console.log('worker =', worker)
  let channel = new MessageChannel();
  worker.postMessage({type: 'comlink/expose', name: 'fs'}, [channel.port2])
  fs = Comlink.proxy(channel.port1)

  channel = new MessageChannel();
  worker.postMessage({type: 'comlink/expose', name: 'Events'}, [channel.port2])
  fsEvents = proxyEventEmitter(Comlink.proxy(channel.port1))

  channel = new MessageChannel();
  worker.postMessage({type: 'comlink/expose', name: 'git'}, [channel.port2])
  git = proxyGit(Comlink.proxy(channel.port1))
}

export async function setupServiceWorker () {
  if (!navigator.serviceWorker) {
    console.log(`Oh no! Your browser doesn't support a feature needed to run this app (navigator.serviceWorker). Try using a different browser.`)
    return
  }
  console.log(`Registering...`)
  let reg = await navigator.serviceWorker.register('./wwsw.js', {scope: '/'})
  console.log(`Registered.`)
  reg.addEventListener('updatefound', () => {
    console.log(`Update found...`)
    let newWorker = reg.installing
    newWorker.addEventListener('statechange', () => {
      console.log(newWorker.state)
      if (newWorker.state === 'activated') {
      }
    })
  })
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

function proxyGit(obj) {
  const handler = {
    get(target, propKey, receiver) {
      return function (...args) {
        // Wrap callbacks
        for (let i = 0; i < args.length; i++) {
          if (typeof args[i] === 'function') {
            args[i] = Comlink.proxyValue(args[i])
          }
        }
        let result = target[propKey](...args);
        return result;
      }
    }
  };
  return new Proxy(obj, handler);
}

