import { Comlink, establishComlink, fs, fsEvents, git } from '../dist/client.js'

function log (str) {
  var div = document.createElement('h4')
  div.innerHTML = str
  document.body.appendChild(div)
}
const handleMkdir = function (args) {
  console.log('Received: ', args)
}
const handleWrite = function (args) {
  console.log('Received: ', args)
}

export async function connectWithComlink () {
  await establishComlink()
  fsEvents.on('write', handleWrite)
  fsEvents.on('mkdir', handleMkdir)
}
export async function doThings () {
  console.log(await fs.readFile('.uuid', 'utf8'))
  console.log(await fs.readdir('.'))
  console.log(await git.init({dir: '.'}))
  fsEvents.emit('foobar', {type: 'barbarbar'})
}
export function registerWWSW () {
  if (!navigator.serviceWorker) {
    log(`Oh no! Your browser doesn't support a feature needed to run this app (navigator.serviceWorker). Try using a different browser.`)
  } else {
    log(`Registering...`)
    navigator.serviceWorker
    .register('./wwsw.js', {scope: '/'})
    .then((reg) => {
      log(`Registered.`)
      reg.addEventListener('updatefound', () => {
        log(`Update found...`)
        let newWorker = reg.installing
        newWorker.addEventListener('statechange', () => {
          log(newWorker.state)
          if (newWorker.state === 'activated') {
            // log('Begin cloning...')
            // let msg = {
            //   type: "clone",
            //   repo: 'wmhilton/nde',
            //   ref: 'master',
            //   name: 'nde'
            // }
            // newWorker.postMessage(msg)
            // navigator.serviceWorker.addEventListener('message', event => {
            //   let data = event.data
            //   console.log('data =', data)
            //   if (data.type === 'status') {
            //     if (data.status === 'complete') {
            //       window.location = '/nde/'
            //     } else if (data.status === 'progress') {
            //       console.log(data.progress)
            //       let loader = document.getElementById('loader')
            //       loader.style.color = '#FFF'
            //       loader.style.background = '#3498db'
            //       loader.style.width = Math.floor(data.progress * 100) + '%'
            //       loader.innerHTML = (loader.style.width === '100%' ? 'Checking out master branch...' : loader.style.width)
            //     } else if (data.status === 'error') {
            //       alert('Error! ' + data.error.message)
            //     }
            //   }
            // })
          }
        })
      })
    })
  }
}