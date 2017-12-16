// Rollup plugins
import babel from 'rollup-plugin-babel';
import resolve from 'rollup-plugin-node-resolve';
import commonjs from 'rollup-plugin-commonjs';

export default [
  {
    input: 'src/index.js',
    output: {
      file: 'dist/wwsw.js',
      format: 'es'
    },
    plugins: [
      resolve({
        module: true,
        main: true,
        browser: true,
      }),
      commonjs(),
      babel({
        exclude: 'node_modules/**',
      }),
    ],
  },
  {
    input: 'src/client.js',
    output: {
      file: 'dist/client.js',
      format: 'umd',
      name: 'test'
    },
    plugins: [
      resolve({
        module: true,
        main: true,
        browser: true,
      }),
      commonjs(),
      babel({
        exclude: 'node_modules/**',
      }),
    ],
  }
]