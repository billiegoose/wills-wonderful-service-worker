// Depending on how it is run, this file is the Client, the WebWorker, or the ServiceWorker
import MagicPortal from 'magic-portal'
import * as git from 'isomorphic-git'
import pify from 'pify'
import LightningFS from '@isomorphic-git/lightning-fs'

import { EventEmitter } from './eventemitter-2015.js'
import { Serve } from './serve.js'

export const fs = new LightningFS("fs")

const promiseFs = {
  stat: pify(fs.stat.bind(fs)),
  readFile: pify(fs.readFile.bind(fs)),
  writeFile: pify(fs.writeFile.bind(fs)),
  unlink: pify(fs.unlink.bind(fs)),
  readdir: pify(fs.readdir.bind(fs)),
  mkdir: pify(fs.mkdir.bind(fs)),
  rmdir: pify(fs.rmdir.bind(fs)),
}

// This is premised off the idea that having a global function called 'skipWaiting'
// is highly unlikely, thus only true of ServiceWorker environments
const detect = () => {
  if (typeof window !== 'undefined' && !self.skipWaiting) {
    return 'window'
  } else if (typeof self !== 'undefined' && !self.skipWaiting) {
    return 'Worker'
  } else if (typeof self !== 'undefined' && self.skipWaiting) {
    return 'ServiceWorker'
  }
}
console.log('detect', detect())

// CLIENT
export async function client (IMPORT_META_URL) {
  const worker = new Worker(IMPORT_META_URL)
  const emitter = new EventEmitter()
  const portal = new MagicPortal(worker)
  console.log('setting emitter')
  const magicPortalDoesntUnderstandPrototype = {
    emit: emitter.emit.bind(emitter)
  }
  portal.set('emitter', magicPortalDoesntUnderstandPrototype, {void: ['emit']})
  console.log('awaiting git')
  const gitProxy = await portal.get('git')
  return { emitter, fs: promiseFs, git: gitProxy }
}

export async function setupServiceWorker (IMPORT_META_URL) {
  if (!navigator.serviceWorker) {
    throw new Error('unsupported')
  }
  console.log(`Registering...`)
  let reg = await navigator.serviceWorker.register(IMPORT_META_URL, {scope: '/'})
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
// End CLIENT

// WebWorker
// The Worker is used to offload intense potentially blocking work.
// The main example is "git clone". You wouldn't want "git clone" to
// block either the render loop OR block fetching resources from the service worker.
// It exposes the `isomorphic-git` API to the main thread via a MagicPortal proxy
if (detect() === 'Worker') {
  git.plugins.set('fs', fs)

  const portal = new MagicPortal(self)
  console.log('setting git')
  portal.set('git', git)
  console.log('awaiting emitter')
  portal.get('emitter').then(emitter => git.plugins.set('emitter', emitter) && console.log('got emitter'))
}

// End WebWorker

// ServiceWorker
// The Service Worker acts like an HTTP server, serving all your "local" files
// so they are accessible. You can navigate to "local" HTML pages, use "local"
// files as the 'src' for image tags, CSS tags, and script tags.

if (detect() === 'ServiceWorker') {
  const serve = new Serve(promiseFs)

  // Eagerly claim pages
  self.addEventListener('activate', event => {
    return event.waitUntil(self.clients.claim())
  })

  // Try serving from the file system.
  self.addEventListener('fetch', event => event.respondWith(
    (async event => {
      try {
        let result = await serve(event.request)
        return result
      } catch (err) {
        return fetch(event.request)
      }
    })(event)
  ))
}

// End ServiceWorker
