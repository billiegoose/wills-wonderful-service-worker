import { fs, fsReady } from './fs'
import { renderIndex } from './render-index.js'
export async function serve (path) {
  await fsReady
  return new Promise(function(resolve, reject) {
    fs.stat(path, (err, stats) => {
      if (err) {
        if (err.code === 'ENOENT') {
          console.log('return with a 404')
          return resolve(new Response(err.message, {
            status: 404,
            statusText: "Not Found"
          }))
        } else {
          return resolve(new Response(err.message, {
            status: 500,
            statusText: "Internal ServiceWorker Error"
          }))
        }
      } else if (stats.isDirectory()) {
        // If the directory doesn't end in a slash, redirect it
        // because otherwise relative URLs will have trouble.
        if (!path.endsWith('/')) return resolve(Response.redirect(path + '/', 302))
        fs.readdir(path, (err, data) => {
          if (err) {
            return resolve(new Response(err.message, {
              status: 500,
              statusText: "Internal ServiceWorker Error"
            }))
          }
          // Serve directory/index.html if it exists
          if (data.includes('index.html')) {
            fs.readFile(`${path}/index.html`, (err, data) => {
              if (err) {
                return resolve(new Response(err.message, {
                  status: 500,
                  statusText: "Internal ServiceWorker Error"
                }))
              }
              return resolve(new Response(data, {
                headers: {
                  'Content-Type': 'text/html'
                }
              }))
            })
          } else {
            // If it doesn't exist, generate a directory index
            try {
              data = renderIndex(path, data)
            } catch (err) {
              return resolve(new Response(err.message, {
                status: 500,
                statusText: "Internal ServiceWorker Error"
              }))
            }
            return resolve(new Response(data, {
              headers: {
                'Content-Type': 'text/html'
              }
            }))
          }
        })
      } else {
        fs.readFile(path, (err, data) => {
          if (err) {
            return resolve(new Response(err.message, {
              status: 500,
              statusText: "Internal ServiceWorker Error"
            }))
          }
          return resolve(new Response(data, {
            headers: {
              'Content-Type': mime.lookup(path)
            }
          }))
        })
      }
    })
  })
}
