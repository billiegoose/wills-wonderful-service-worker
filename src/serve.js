import { renderIndex } from './render-index.js'
const mime = require('mime/lite');

const MimeResponse = (data, contenttype) =>
  new Response(data, { headers: { 'Content-Type': contenttype } } )

export function Serve (fs) {
  return request => serve(request, fs)
}

async function serve (request, fs) {
  let path
  // Handle either full-blown Requests or simple path names
  if (typeof request === 'string') {
    path = request
  } else {
    // We can only respond to GET requests obviously.
    if (request.method !== 'GET') throw new Error('Cannot serve')
    // For now, we're assuming the files only live under the current domain name.
    // In the future, it may be possible to "mount" directories to other domains.
    if (!request.url.startsWith(self.location.origin)) throw new Error('Cannot serve')
    // Turn URL into a file path
    path = new URL(request.url, self.location).pathname
  }
  // Sanity check
  if (path === '') path = '/'
  try {
    return servePath(path, fs)
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

const removeTrailingSlash = path => path.replace(/\/$/, '')

async function servePath(path, fs) {
  // Try serving from the file system.
  // We need to remove trailing slashes because... well... I didn't write LightningFS with that in mind.
  let stats = await fs.stat(removeTrailingSlash(path))
  return stats.isDirectory() ? serveDirectory(path, fs) : serveFile(path, fs)
}

async function serveDirectory(path, fs) {
  // If the directory doesn't end in a slash, redirect it
  // because otherwise relative URLs will have trouble.
  if (!path.endsWith('/')) return Response.redirect(path + '/', 302)
  let data = await fs.readdir(removeTrailingSlash(path))
  // Serve directory/index.html if it exists
  if (data.includes('index.html')) {
    data = await fs.readFile(`${path}/index.html`)
    return MimeResponse(data, 'text/html')
  } else {
    // If it doesn't exist, generate a directory index
    data = renderIndex(path, data)
    return MimeResponse(data, 'text/html')
  }
}

async function serveFile(path, fs) {
  // Filenames with no file extension are mistaken for directories (sometimes)
  // We need to correct this.
  if (path.endsWith('/')) return Response.redirect(path.slice(0, -1), 302)
  let data = await fs.readFile(path)
  return MimeResponse(data, mime.getType(path))
}