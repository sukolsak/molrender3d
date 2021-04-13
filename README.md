# molrender3d

[![License](http://img.shields.io/badge/license-MIT-blue.svg?style=flat)](./LICENSE)

A tool for creating macromolecular images and 3D models. It is based on [molrender](https://github.com/molstar/molrender), which is based on [Mol\*](https://github.com/molstar/molstar). It can create PNG, JPEG, OBJ, GLB, and USDZ files.

The tool is being used on [MolAR](https://stanford.edu/~sukolsak/ar/) to create 3D models of proteins for augmented reality.

## Usage

### Create an image or 3D model
    molrender3d model [options] IN OUT MODEL_INDEX
    molrender3d assembly [options] IN OUT ASSEMBLY_INDEX
    molrender3d chain [options] IN OUT CHAIN_NAME
    molrender3d models [options] IN OUT
    molrender3d all [options] IN OUT

The `options` are

    --width WIDTH    image height
    --height HEIGHT  image width
    --format FORMAT  image format (png, jpeg, obj, glb, or usdz)

For example, the following command will create `6vxx.obj` in the `out` folder. The `6vxx.cif` file (structure data of SARS-CoV-2 spike glycoprotein) can be downloaded from https://files.rcsb.org/download/6vxx.cif.

    molrender3d assembly 6vxx.cif out 0 --format obj

## Building

### Build:
    npm install
    npm run build

### Build automatically on file save:
    npm run watch

### Build with debug mode enabled:
    DEBUG=molstar npm run watch

### Build for production:
    NODE_ENV=production npm run build

### Scripts installation
    npm run build
    npm install -g

## Contributing
Just open an issue or make a pull request. All contributions are welcome.
