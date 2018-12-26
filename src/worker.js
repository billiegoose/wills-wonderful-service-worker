// The Worker is used to offload intense potentially blocking work.
// The main example is "git clone". You wouldn't want "git clone" to
// block either the render loop OR block fetching resources from the service worker.
// It exposes the `isomorphic-git` API to the main thread via a MagicPortal proxy.
importScripts('https://unpkg.com/isomorphic-git@0.47.0/dist/bundle.umd.min.js')
importScripts('https://unpkg.com/magic-portal@1.0.0/dist/index.umd.js')
import { fs } from './fs.js'

git.plugins.set('fs', fs)

const portal = new MagicPortal(self)
portal.set('git', git)
portal.get('emitter').then(emitter => git.plugins.set('emitter', emitter))
