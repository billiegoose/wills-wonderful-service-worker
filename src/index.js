global = self
window = global
importScripts('https://unpkg.com/omnipath@1.1.5/dist/omnipath.min.js')
importScripts('https://gundb-git-app-manager.herokuapp.com/gun.js')
importScripts('https://unpkg.com/isomorphic-git@0.0.33/dist/service-worker-bundle.umd.min.js')
import { Comlink } from 'comlinkjs'
import pify from 'pify' // commonjs module
import Mime from './mime'
import { fs, fsReady } from './fs'
import { useMyFilesystem } from './git'
import { rimraf } from './rimraf'
import { serve } from './serve'
global.fs = fs
console.log('fs =', fs)
console.log('git =', git)
console.log('OmniPath =', OmniPath)
console.log('gun =', Gun)

let API = {
  fs: pify(fs),
  Events: fs.Events,
  git: useMyFilesystem(git)
  // git: {
  //   async init (args) {
  //     let {dir, gitdir, workdir} = args
  //     console.log({fs, dir, gitdir, workdir}, args)
  //     return git.init(new git.Git({fs, dir, gitdir, workdir}), args)
  //   },
  //   async clone (args) {
  //     let {dir, gitdir, workdir} = args
  //     return git.clone(new git.Git({fs, dir, gitdir, workdir}), args)
  //   }
  // }
}
self.API = API

// for fun
fs.Events.once('foobar', function (data) {
  console.log('foobar = ', data)
})

async function getGun () {
  global.gun = Gun(['https://gundb-git-app-manager.herokuapp.com/gun']);
  return global.gun
}

async function getUUID () {
  await fsReady
  return await new Promise((resolve, reject) => {
    fs.readFile('.uuid', 'utf8', async (err, contents) => {
      if (typeof contents === 'string' && contents.length > 1) return resolve(contents)
      if (err.code === 'ENOENT') {
        let gun = await getGun()
        let uuid = gun._.opt.uuid()
        let me = gun.get(`client/${uuid}`).put({birthdate: Date.now()})
        gun.get('clients').set(me)
        fs.writeFile('/.uuid', uuid, 'utf8', err => err ? reject(err) : resolve(uuid))
      } else {
        reject(err)
      }
    })
  })
}

async function clone ({ref, repo, name}) {
  await fsReady
  function handleProgress (e) {
    let msg = {
      type: 'status',
      status: 'progress',
      regarding: {ref, repo, name},
      progress: e.loaded / e.total
    }
    global.clients.matchAll({includeUncontrolled: true}).then(all => all.map(client => client.postMessage(msg)));
  }
  
  let dir = name
  return git.clone(new git.Git({fs, dir}), {
    depth: 1,
    ref: ref,
    onprogress: handleProgress,
    url: `https://cors-buster-jfpactjnem.now.sh/github.com/${repo}`
  })
}

async function UpdatedDirectoryList (event) {
  await fsReady
  return new Promise(function(resolve, reject) {
    fs.readdir('/', (err, files) => {
      files = files.filter(x => !x.startsWith('.')).filter(x => x !== 'index.html')
      let msg = {
        type: 'UpdatedDirectoryList',
        regarding: event.data,
        list: files
      }
      self.clients.matchAll({includeUncontrolled: true}).then(all => all.map(client => client.postMessage(msg)))
      resolve()
    })
  })
}

self.addEventListener('install', event => {
  return event.waitUntil((async () => {
    await fsReady
    let res = await fetch('/index.html')
    let text = await res.text()
    await new Promise(function(resolve, reject) {
      fs.writeFile('/index.html', text, 'utf8', err => err ? reject(err) : resolve())
    })
    let uuid = await getUUID()
    console.log(uuid)
    console.log('skipWaiting()')
    await self.skipWaiting()
    console.log('skipWaiting() complete')
  })())
})

self.addEventListener('activate', event => {
  return event.waitUntil((async () => {
    await fsReady
    console.log('claim()')
    await self.clients.claim()
    console.log('claim() complete')
  })())
})

self.addEventListener('message', async event => {
  await fsReady
  console.log(event.data)
  if (event.data.type === 'comlink/expose') {
    console.log(event.ports[0].postMessage);
    // Comlink.expose(myfs, event.ports[0]);
    Comlink.expose(self.API[event.data.name], event.ports[0]);
  } else if (event.data.type === 'clone') {
    clone(event.data).then(async () => {
      console.log('Done cloning.')
      // Tell all local browser windows and workers the clone is complete.
      let msg = {
        type: 'status',
        status: 'complete',
        regarding: event.data
      }
      console.log('event =', event)
      // Tell all the peers that we have a copy of this repository.
      let gun = await getGun()
      let uuid = await getUUID()
      gun.get(`client/${uuid}`).val(me => {
        console.log('me = ', me)
        gun.get('repos').get(`github.com/${event.data.repo}`).get('seeders').set(me).val(foo =>
          console.log('foo = ', foo)
        )
      })
      self.clients.matchAll({includeUncontrolled: true}).then(all => all.map(client => client.postMessage(msg)));
    }).catch(err => {
      let msg = {
        type: 'status',
        status: 'error',
        regarding: event.data,
        error: {
          message: err.message
        }
      }
      self.clients.matchAll().then(all => all.map(client => client.postMessage(msg)));
    })
  } else if (event.data.type === 'list') {
    console.log('listing')
    fs.readdir('/', (err, files) => {
      UpdatedDirectoryList(event)
    })
  } else if (event.data.type == 'delete') {
    console.log('deleting')
    rimraf(event.data.directory).then(() => {
      UpdatedDirectoryList(event)
    })
  }
})

self.addEventListener('fetch', event => {
  let request = event.request
  // We need to cache GET (readFile) and HEAD (getFileSize) requests for proper offline support.
  if (request.method !== 'GET' && request.method !== 'HEAD') return
  // Is it for a package CDN?
  const requestHost = OmniPath.parse(request.url).hostname
  if (requestHost === 'unpkg.com') return event.respondWith(permaCache(request, 'unpkg'))
  if (requestHost === 'wzrd.in') return event.respondWith(permaCache(request, 'wzrd'))
  if (requestHost === 'cdnjs.cloudflare.com') return event.respondWith(permaCache(request, 'cdnjs'))
  if (requestHost === 'api.cdnjs.com') return event.respondWith(permaCache(request, 'cdnjs'))
  if (requestHost === 'rawgit.com') return event.respondWith(permaCache(request, 'rawgit'))
  // For now, ignore other domains. We might very well want to cache them later though.
  if (!request.url.startsWith(self.location.origin)) return
  // Turn URL into a file path
  let path = OmniPath.parse(request.url).pathname //.replace(/^(https?:)?\/\/[^\/]+/, '')
  if (OmniPath.parse(request.url).query.uri && OmniPath.parse(request.url).query.uri === 'web+gitapp://0fda723910a6952176e73eeb5bbeaece1ef99110') {
    console.log('OH HEY COOL I KNOW THIS ONE HASH: ' + request.url)
    return event.respondWith(fetch('https://wmhilton.github.io/favicon/favicon-96x96.png'))
  }
  // Sanity check
  if (path === '') path = '/'
  // Otherwise, try fetching from the "file system".
  event.respondWith(serve(path))
})

async function permaCache (request, name) {
  let betterRequest = new Request(request.url, {
    mode: 'cors',
    credentials: 'omit',
    redirect: 'follow'
  })
  let cache = await caches.open(name)
  let response = await cache.match(betterRequest.url)
  if (response) {
    return response
  }
  response = fetch(betterRequest)
  response.then(res => {
    // Let's just cache the redirected result,
    // because that gives us true offline support,
    // and (unintentionally) pins module versions on first use.
    // TODO: Add a way to un-pin the cached version of an unpkg library.
    if (res.status === 200) cache.put(request.url, res.clone())
  })
  return response
}
