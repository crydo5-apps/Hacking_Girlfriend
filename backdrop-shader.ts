/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
const vs = `precision highp float;

in vec3 position;

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;

void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.);
}`;

const fs = `precision highp float;

out vec4 fragmentColor;

uniform vec2 resolution;
uniform float rand;
uniform float glitch;
uniform vec3 glitchColor;

float hash12(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  float aspectRatio = resolution.x / resolution.y;
  vec2 uv = gl_FragCoord.xy / resolution;
  float noise = fract(sin(dot(uv, vec2(12.9898 + rand, 78.233) * 2.0)) * 43758.5453);

  vec2 centeredUv = uv - 0.5;
  centeredUv.x *= aspectRatio;

  float factor = 4.0;
  float d = factor * length(centeredUv);
  vec3 from = vec3(3.0) / 255.0;
  vec3 to = vec3(16.0, 12.0, 20.0) / 2550.0;

  vec3 color = mix(from, to, d) + 0.005 * noise;

  if (glitch > 0.01) {
    float bandY = floor(uv.y * 44.0);
    float bandSeed = hash12(vec2(bandY, floor(rand * 0.13)));
    float thinY = floor(uv.y * 140.0);
    float thinSeed = hash12(vec2(thinY, floor(rand * 0.27)));

    float tearMask = step(0.84, bandSeed) * glitch;
    float scanLineMask = step(0.955, thinSeed) * glitch;

    float shift = (bandSeed - 0.5) * 0.14 * tearMask;
    float displacedNoise = hash12(vec2(uv.x + shift, uv.y + rand * 0.001));

    color += glitchColor * (0.045 * tearMask * displacedNoise);
    color += glitchColor * (0.14 * scanLineMask);
    color *= 1.0 - (0.28 * step(0.92, bandSeed) * glitch);
  }

  fragmentColor = vec4(color, 1.0);
}
`;

export {fs, vs};
