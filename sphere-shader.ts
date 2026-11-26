/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
const vs = `#define STANDARD
varying vec3 vViewPosition;
#ifdef USE_TRANSMISSION
  varying vec3 vWorldPosition;
#endif
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <shadowmap_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>

uniform float time;
uniform float orbMode;

uniform vec4 inputData;
uniform vec4 outputData;

vec3 calc( vec3 pos ) {
  vec3 dir = normalize( pos );
  if ( orbMode < 0.5 ) {
    return pos +
      1. * inputData.x * inputData.y * dir * (.5 + .5 * sin(inputData.z * pos.x + time)) +
      1. * outputData.x * outputData.y * dir * (.5 + .5 * sin(outputData.z * pos.y + time));
  }
  if ( orbMode < 1.5 ) {
    float inputWave = sin(inputData.z * pos.x + time * 1.4) * cos(inputData.z * pos.z * 0.7 - time);
    float outputWave = sin(outputData.z * pos.y + time * 1.4) * cos(outputData.z * pos.x * 0.7 + time);
    return pos +
      dir * (inputData.x * 0.32 * (0.5 + 0.5 * inputWave) + inputData.y * 0.16 * sin(pos.y * 4.0 + time * 2.0)) +
      dir * (outputData.x * 0.32 * (0.5 + 0.5 * outputWave) + outputData.y * 0.16 * cos(pos.x * 4.0 - time * 2.0));
  }
  if ( orbMode < 2.5 ) {
    float energy = inputData.x + outputData.x;
    float flare = sin(pos.x * 6.0 + time * 2.5) * sin(pos.y * 6.0 - time * 2.1) * cos(pos.z * 6.0 + time * 1.7);
    float corona = abs(sin((pos.x + pos.y + pos.z) * 4.0 + time * 3.0));
    return pos + dir * (0.04 + energy * 0.42 * (0.5 + 0.5 * flare) + (inputData.y + outputData.y) * 0.22 * corona);
  }
  if ( orbMode < 3.5 ) {
    float energy = inputData.x + outputData.x;
    float ridge = abs(sin(pos.x * 5.0 + time * 1.6)) + abs(cos(pos.y * 5.0 - time * 1.3));
    return pos + dir * (energy * 0.24 * ridge + (inputData.y + outputData.y) * 0.15 * sin(pos.z * 7.0 + time * 2.4));
  }
  float scan = 0.5 + 0.5 * sin(pos.y * 10.0 - time * 3.5);
  float pulse = (inputData.x + outputData.x) * 0.3 + (inputData.y + outputData.y) * 0.15;
  return pos + dir * (pulse * (0.35 + 0.65 * scan));
}

vec3 spherical( float r, float theta, float phi ) {
  return r * vec3(
    cos( theta ) * cos( phi ),
    sin( theta ) * cos( phi ),
    sin( phi )
  );
}

void main() {
  #include <uv_vertex>
  #include <color_vertex>
  #include <morphinstance_vertex>
  #include <morphcolor_vertex>
  #include <batching_vertex>
  #include <beginnormal_vertex>
  #include <morphnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <defaultnormal_vertex>
  #include <normal_vertex>
  #include <begin_vertex>

  float inc = 0.001;

  float r = length( position );
  float theta = ( uv.x + 0.5 ) * 2. * PI;
  float phi = -( uv.y + 0.5 ) * PI;

  vec3 np = calc( spherical( r, theta, phi ) );

  vec3 dTheta = calc( spherical( r, theta + inc, phi ) ) - np;
  vec3 dPhi = calc( spherical( r, theta, phi + inc ) ) - np;
  vec3 crossN = cross( dTheta, dPhi );
  if ( length( crossN ) > 1e-7 ) {
    transformedNormal = -normalMatrix * normalize( crossN );
  }

  vNormal = normalize( transformedNormal );

  transformed = np;

  #include <morphtarget_vertex>
  #include <skinning_vertex>
  #include <displacementmap_vertex>
  #include <project_vertex>
  #include <logdepthbuf_vertex>
  #include <clipping_planes_vertex>
  vViewPosition = - mvPosition.xyz;
  #include <worldpos_vertex>
  #include <shadowmap_vertex>
  #include <fog_vertex>
  #ifdef USE_TRANSMISSION
    vWorldPosition = worldPosition.xyz;
  #endif
}`;

export {vs};
