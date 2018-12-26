import MagicPortal from 'https://unpkg.com/magic-portal@1.0.0/dist/index.es6.js'
import { fs } from './fs.js'
import Emitter from './eventemitter-2015.js'

export default function client (filepath) {
  const worker = new Worker(filepath)
  const emitter = new Emitter()
  const portal = new MagicPortal(worker)
  portal.set('emitter', emitter, {void: ['emit']})
  git = await portal.get('git')
  return { emitter, fs, git }
}

export async function setupServiceWorker (filepath) {
  if (!navigator.serviceWorker) {
    console.log(`Oh no! Your browser doesn't support a feature needed to run this app (navigator.serviceWorker). Try using a different browser.`)
    return
  }
  console.log(`Registering...`)
  let reg = await navigator.serviceWorker.register(filepath, {scope: '/'})
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
