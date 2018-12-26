const path = require('path')

module.exports = {
  target: "webworker",
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "wwsw.js",
    libraryTarget: "umd",
    library: "WWSW",
  },
};
