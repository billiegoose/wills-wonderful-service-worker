import { setupServiceWorker, waitForWorker, fs, fsEvents, git } from '../dist/client.js'

function log (str) {
  var div = document.createElement('h4')
  div.innerHTML = str
  document.body.appendChild(div)
}

export async function registerWWSW () {
  await setupServiceWorker()
}

export async function connectWithComlink () {
  await waitForWorker()
  fsEvents.on('write', function (args) {
    console.log('Received: ', args)
  })
  fsEvents.on('mkdir', function (args) {
    console.log('Received: ', args)
  })
}

export async function doThings () {
  console.log(await fs.readFile('.uuid', 'utf8'))
  console.log(await fs.readdir('.'))
  console.log(await git.init({dir: '.'}))
  fsEvents.emit('foobar', {type: 'barbarbar'})
}
