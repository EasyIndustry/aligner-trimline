// threejs-material-engine, la parte pura: la definición de un material como datos, su plan
// de horneado, los modos de fusión y el registro de generadores. Corre en Node y en el
// navegador. El horneado y el MeshPhysicalMaterial están en adapters/three/engine.js.
export { CHANNELS, SETTINGS, OUTPUTS, isMappable, isHexColor } from './channels.js';
export { BLEND_MODES, blendValue, layerValue, BLEND_GLSL } from './blend.js';
export { defineMaterial, planMaterial, hashMaterial, generatorsOf, stableStringify, hexToLinear, linearToHex } from './material.js';
export { registerGenerator, getGenerator, listGenerators, resolveParams, paramUniformsGLSL, SURFACE_GLSL, NOISE_GLSL } from './generators.js';
export { help, memberNames } from './help.js';
export { ENGINE_MEMBERS } from './members.js';
