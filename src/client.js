// import {Comlink} from 'comlinkjs'
import createChannel from 'swivel/page'

function log (str) {
  var div = document.createElement('h4')
  div.innerHTML = str
  document.body.appendChild(div)
}
export async function useSwivel () {
  let worker = (await navigator.serviceWorker.getRegistrations())[0].active
  var swivel = createChannel().at(worker)
  swivel.once('swivel/test', console.log)
  swivel.emit('swivel/hello', {foo: 'bar'})
}
const handleMkdir = Comlink.proxyValue(function (args) {
  console.log('Received: ', args)
})
const handleWrite = Comlink.proxyValue(function (args) {
  console.log('Received: ', args)
})
export async function useComlink () {
  let worker = (await navigator.serviceWorker.getRegistrations())[0].active
  let channel = new MessageChannel();
  worker.postMessage({type: 'comlink/expose', name: 'fs'}, [channel.port2])
  let fs = Comlink.proxy(channel.port1)
  console.log(await fs.readFile('.uuid', 'utf8'))
  console.log(await fs.readdir('.'))
  
  channel = new MessageChannel();
  worker.postMessage({type: 'comlink/expose', name: 'Events'}, [channel.port2])
  let Events = Comlink.proxy(channel.port1)
  Events.on('write', handleWrite)
  Events.on('mkdir', handleMkdir)
  
  channel = new MessageChannel();
  worker.postMessage({type: 'comlink/expose', name: 'git'}, [channel.port2])
  let git = Comlink.proxy(channel.port1)
  console.log(await git.init({dir: '.'}))
  
  Events.emit('foobar', {type: 'barbarbar'})
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