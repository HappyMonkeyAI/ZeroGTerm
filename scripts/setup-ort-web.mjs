// Make transformers.js treat this Node process as a web-like runtime so it
// takes the WASM path the renderer worker uses (IS_NODE_ENV checks
// process.release.name). Must run before the transformers bundle is imported.
Object.defineProperty(process.release, 'name', { value: 'electron' });
