const path = require('path');
const webpack = require('webpack');

module.exports = [
    {
        target: 'node',
        node: {
            __dirname: false,
            __filename: false,
        },
        externals: {
            argparse: 'require("argparse")',
            gl: 'require("gl")',
            pngjs: 'require("pngjs")',
            'jpeg-js': 'require("jpeg-js")'
        },
        plugins: [
            new webpack.DefinePlugin({
                __PLUGIN_VERSION_TIMESTAMP__: webpack.DefinePlugin.runtimeValue(() => `${new Date().valueOf()}`, true),
                'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV),
                'process.env.DEBUG': JSON.stringify(process.env.DEBUG)
            }),
            new webpack.BannerPlugin({ banner: "#!/usr/bin/env node", raw: true, entryOnly: true }),
        ],
        resolve: {
            modules: [
                'node_modules',
                path.resolve(__dirname, 'build/src/')
            ],
        },
        entry: path.resolve(__dirname, `build/src/index.js`),
        output: { filename: `molrender3d.js`, path: path.resolve(__dirname, `build/bin`) },
    }
]