// Because isaacs "rimraf" is too Node-specific
import { fs } from './fs'
const pfy = function (fn) {
  return function (a, cb) {
    return new Promise(function(resolve, reject) {
      fn(a, (err, result) => err ? reject(err) : resolve(result))
    });
  }
}

const readdir = pfy(fs.readdir.bind(fs))
const unlink = pfy(fs.unlink.bind(fs))
const rmdir = pfy(fs.rmdir.bind(fs))

// It's elegant in it's naivety
export async function rimraf (path) {
  try {
    // First assume path is itself a file
    await unlink(path)
    // if that worked we're done
    return
  } catch (err) {
    // Otherwise, path must be a directory
    if (err.code !== 'EISDIR') throw err
  }
  // Knowing path is a directory,
  // first, assume everything inside path is a file.
  let files = await readdir(path)
  for (let file of files) {
    let child = path + '/' + file
    try {
      await fs.unlink(child)
    } catch (err) {
      if (err.code !== 'EISDIR') throw err
    }
  }
  // Assume what's left are directories and recurse.
  let dirs = await readdir(path)
  for (let dir of dirs) {
    let child = path + '/' + dir
    await rimraf(child)
  }
  // Finally, delete the empty directory
  await rmdir(path)
}