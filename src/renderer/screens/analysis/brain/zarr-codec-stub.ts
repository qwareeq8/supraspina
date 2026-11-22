/**
 * Stands in for the numcodecs Blosc, LZ4, and Zstandard codecs that NiiVue's
 * Zarr support imports on demand. The brain viewer reads only MGZ volumes and
 * FreeSurfer surfaces, and those codecs embed WebAssembly that the renderer's
 * CSP would refuse to compile, so the renderer build aliases them here and
 * ships neither.
 */

/** A codec that refuses every use. */
const unavailableCodec = {
  fromConfig(): never {
    throw new Error('Zarr compression codecs are not part of Supraspina.')
  },
}

export default unavailableCodec
