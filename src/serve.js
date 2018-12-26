import { fs } from './fs.js'
import { pfy } from './pfy.js'
import { renderIndex } from './render-index.js'
import Mime from './mime.js'


const stat = pfy(fs.stat.bind(fs))
const readdir = pfy(fs.readdir.bind(fs))
const readFile = pfy(fs.readFile.bind(fs))

const MimeResponse = (data, contenttype) =>
  new Response(data, { headers: { 'Content-Type': contenttype } } )

export async function serve (event) {
  let path
  // Handle either full-blown Request events or simple path names
  if (typeof event === string) {
    path = event
  } else {
    let request = event.request
    // We can only respond to GET requests obviously.
    if (request.method !== 'GET') return
    // For now, we're assuming the files only live under the current domain name.
    // In the future, it may be possible to "mount" directories to other domains.
    if (!request.url.startsWith(self.location.origin)) return
    // Turn URL into a file path
    path = new URL(request.url, self.location).pathname
  }
  // Sanity check
  if (path === '') path = '/'
  try {
    return servePath(path)
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log('return with a 404')
      return new Response(err.message, {
        status: 404,
        statusText: "Not Found"
      })
    } else {
      return new Response(err.message, {
        status: 500,
        statusText: "Internal ServiceWorker Error"
      })
    }
  }
}

async function servePath(path) {
  // Try serving from the file system.
  let stats = await stat(path)
  return stats.isDirectory() ? serveDirectory(path) : serveFile(path)
}

async function serveDirectory(path) {
  // If the directory doesn't end in a slash, redirect it
  // because otherwise relative URLs will have trouble.
  if (!path.endsWith('/')) return Response.redirect(path + '/', 302)
  let data = await readdir(path)
  // Serve directory/index.html if it exists
  if (data.includes('index.html')) {
    let data = await readFile(`${path}/index.html`)
    return MimeResponse(data, 'text/html')
  } else {
    // If it doesn't exist, generate a directory index
    let data = renderIndex(path, data)
    return MimeResponse(data, 'text/html')
  }
}

async function serveFile(path) {
  let data = readFile(path)
  return MimeResponse(data, mime.lookup(path))
}
