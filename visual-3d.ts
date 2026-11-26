
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// tslint:disable:organize-imports
// tslint:disable:ban-malformed-import-paths
// tslint:disable:no-new-decorators

import {LitElement, css, html} from 'lit';
import {customElement, property} from 'lit/decorators.js';
import {Analyser} from './analyser';

import * as THREE from 'three';
import {EXRLoader} from 'three/addons/loaders/EXRLoader.js';
import {EffectComposer} from 'three/addons/postprocessing/EffectComposer.js';
import {RenderPass} from 'three/addons/postprocessing/RenderPass.js';
import {ShaderPass} from 'three/addons/postprocessing/ShaderPass.js';
import {UnrealBloomPass} from 'three/addons/postprocessing/UnrealBloomPass.js';
import {FXAAShader} from 'three/addons/shaders/FXAAShader.js';
import {fs as backdropFS, vs as backdropVS} from './backdrop-shader';
import {vs as sphereVS} from './sphere-shader';

/**
 * 3D live audio visual.
 */
export type OrbStyle =
  | 'reactive'
  | 'classic'
  | 'cyber-grid'
  | 'solar-flare'
  | 'crimson-pulse';

@customElement('gdm-live-audio-visuals-3d')
export class GdmLiveAudioVisuals3D extends LitElement {
  private inputAnalyser!: Analyser;
  private outputAnalyser!: Analyser;
  private camera!: THREE.PerspectiveCamera;
  private backdrop!: THREE.Mesh;
  private composer!: EffectComposer;
  private bloomPass!: UnrealBloomPass;
  private sphere!: THREE.Mesh;
  private wireframeShell!: THREE.Mesh;
  private wireframeMaterial!: THREE.MeshBasicMaterial;
  private sphereMaterial!: THREE.MeshStandardMaterial;
  private ambientLight!: THREE.AmbientLight;
  private inputLight!: THREE.PointLight;
  private outputLight!: THREE.PointLight;
  private hasEnvMap = false;
  private prevTime = 0;
  private animationFrameId = 0;
  private rotation = new THREE.Vector3(0, 0, 0);
  private smoothedInput = 0;
  private smoothedOutput = 0;
  private resizeHandler?: () => void;

  @property({type: String})
  orbStyle: OrbStyle = 'reactive';

  private _outputNode!: AudioNode;

  @property()
  set outputNode(node: AudioNode) {
    this._outputNode = node;
    this.outputAnalyser = new Analyser(this._outputNode);
  }

  get outputNode() {
    return this._outputNode;
  }

  private _inputNode!: AudioNode;

  @property()
  set inputNode(node: AudioNode) {
    this._inputNode = node;
    this.inputAnalyser = new Analyser(this._inputNode);
  }

  get inputNode() {
    return this._inputNode;
  }

  private canvas!: HTMLCanvasElement;

  static styles = css`
    canvas {
      width: 100% !important;
      height: 100% !important;
      position: absolute;
      inset: 0;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = 0;
    }
    if (this.resizeHandler) {
      window.removeEventListener('resize', this.resizeHandler);
      this.resizeHandler = undefined;
    }
  }

  private getAverageLevel(data: Uint8Array): number {
    if (!data || data.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      sum += data[i];
    }
    return sum / (data.length * 255);
  }

  private init() {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x100c14);

    const backdrop = new THREE.Mesh(
      new THREE.IcosahedronGeometry(10, 5),
      new THREE.RawShaderMaterial({
        uniforms: {
          resolution: {value: new THREE.Vector2(1, 1)},
          rand: {value: 0},
        },
        vertexShader: backdropVS,
        fragmentShader: backdropFS,
        glslVersion: THREE.GLSL3,
      }),
    );
    backdrop.material.side = THREE.BackSide;
    scene.add(backdrop);
    this.backdrop = backdrop;

    const camera = new THREE.PerspectiveCamera(
      75,
      window.innerWidth / window.innerHeight,
      0.1,
      1000,
    );
    camera.position.set(2, -2, 5);
    this.camera = camera;

    const ambientLight = new THREE.AmbientLight(0x3a2a55, 1.2);
    scene.add(ambientLight);
    this.ambientLight = ambientLight;

    const inputLight = new THREE.PointLight(0xff4f8b, 2.5, 20);
    inputLight.position.set(3, 2, 3);
    scene.add(inputLight);
    this.inputLight = inputLight;

    const outputLight = new THREE.PointLight(0x4f9cff, 2.5, 20);
    outputLight.position.set(-3, -2, 3);
    scene.add(outputLight);
    this.outputLight = outputLight;

    const renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
    });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    const geometry = new THREE.IcosahedronGeometry(1, 10);

    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    pmremGenerator.compileEquirectangularShader();

    const sphereMaterial = new THREE.MeshStandardMaterial({
      color: 0x0b0818,
      metalness: 0.6,
      roughness: 0.15,
      emissive: 0x1a1038,
      emissiveIntensity: 1.5,
    });
    this.sphereMaterial = sphereMaterial;

    new EXRLoader().load(
      'piz_compressed.exr',
      (texture: THREE.Texture) => {
        texture.mapping = THREE.EquirectangularReflectionMapping;
        const exrCubeRenderTarget = pmremGenerator.fromEquirectangular(texture);
        sphereMaterial.envMap = exrCubeRenderTarget.texture;
        sphereMaterial.needsUpdate = true;
        this.hasEnvMap = true;
        texture.dispose();
        pmremGenerator.dispose();
      },
      undefined,
      () => {
        pmremGenerator.dispose();
      },
    );

    sphereMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.time = {value: 0};
      shader.uniforms.orbMode = {value: 1};
      shader.uniforms.inputData = {value: new THREE.Vector4()};
      shader.uniforms.outputData = {value: new THREE.Vector4()};

      sphereMaterial.userData.shader = shader;

      shader.vertexShader = sphereVS;
    };

    const sphere = new THREE.Mesh(geometry, sphereMaterial);
    scene.add(sphere);
    this.sphere = sphere;

    const wireframeMaterial = new THREE.MeshBasicMaterial({
      color: 0x00f5d4,
      wireframe: true,
      transparent: true,
      opacity: 0.45,
    });
    this.wireframeMaterial = wireframeMaterial;

    const wireframeShell = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1.24, 2),
      wireframeMaterial,
    );
    wireframeShell.visible = false;
    scene.add(wireframeShell);
    this.wireframeShell = wireframeShell;

    const renderPass = new RenderPass(scene, camera);

    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      1.6,
      0.55,
      0.1,
    );
    this.bloomPass = bloomPass;

    const fxaaPass = new ShaderPass(FXAAShader);

    const composer = new EffectComposer(renderer);
    composer.addPass(renderPass);
    composer.addPass(bloomPass);

    this.composer = composer;

    const onWindowResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      const dPR = renderer.getPixelRatio();
      const w = window.innerWidth;
      const h = window.innerHeight;
      backdrop.material.uniforms.resolution.value.set(w * dPR, h * dPR);
      renderer.setSize(w, h);
      composer.setSize(w, h);
      fxaaPass.material.uniforms['resolution'].value.set(
        1 / (w * dPR),
        1 / (h * dPR),
      );
    };

    this.resizeHandler = onWindowResize;
    window.addEventListener('resize', onWindowResize);
    onWindowResize();

    this.prevTime = performance.now();
    this.animation();
  }

  private animation() {
    this.animationFrameId = requestAnimationFrame(() => this.animation());

    this.inputAnalyser?.update();
    this.outputAnalyser?.update();

    const t = performance.now();
    const dt = Math.min((t - this.prevTime) / (1000 / 60), 3);
    this.prevTime = t;

    const backdropMaterial = this.backdrop.material as THREE.RawShaderMaterial;
    const sphereMaterial = this.sphereMaterial;

    backdropMaterial.uniforms.rand.value = Math.random() * 10000;

    const inLow = this.inputAnalyser ? this.inputAnalyser.data[0] / 255 : 0;
    const inMid = this.inputAnalyser ? this.inputAnalyser.data[1] / 255 : 0;
    const inHigh = this.inputAnalyser ? this.inputAnalyser.data[2] / 255 : 0;

    const outLow = this.outputAnalyser ? this.outputAnalyser.data[0] / 255 : 0;
    const outMid = this.outputAnalyser ? this.outputAnalyser.data[1] / 255 : 0;
    const outHigh = this.outputAnalyser ? this.outputAnalyser.data[2] / 255 : 0;

    if (this.orbStyle === 'classic') {
      this.wireframeShell.visible = false;
      this.canvas.style.imageRendering = 'pixelated';
      this.ambientLight.intensity = this.hasEnvMap ? 0 : 0.4;
      this.inputLight.intensity = 0;
      this.outputLight.intensity = 0;

      sphereMaterial.color.setHex(0x000010);
      sphereMaterial.metalness = 0.5;
      sphereMaterial.roughness = 0.1;
      sphereMaterial.emissive.setHex(0x000010);
      sphereMaterial.emissiveIntensity = 1.5;

      this.bloomPass.strength = 5;
      this.bloomPass.radius = 0.5;
      this.bloomPass.threshold = 0;

      this.sphere.scale.setScalar(1 + 0.2 * outMid);

      const f = 0.001;
      this.rotation.x += dt * f * 0.5 * outMid;
      this.rotation.z += dt * f * 0.5 * inMid;
      this.rotation.y += dt * f * 0.25 * inHigh;
      this.rotation.y += dt * f * 0.25 * outHigh;

      const euler = new THREE.Euler(
        this.rotation.x,
        this.rotation.y,
        this.rotation.z,
      );
      const quaternion = new THREE.Quaternion().setFromEuler(euler);
      const vector = new THREE.Vector3(0, 0, 5);
      vector.applyQuaternion(quaternion);
      this.camera.position.copy(vector);
      this.camera.lookAt(this.sphere.position);

      if (sphereMaterial.userData.shader) {
        sphereMaterial.userData.shader.uniforms.orbMode.value = 0;
        sphereMaterial.userData.shader.uniforms.time.value +=
          dt * 0.1 * outLow;
        sphereMaterial.userData.shader.uniforms.inputData.value.set(
          1 * inLow,
          0.1 * inMid,
          10 * inHigh,
          0,
        );
        sphereMaterial.userData.shader.uniforms.outputData.value.set(
          2 * outLow,
          0.1 * outMid,
          10 * outHigh,
          0,
        );
      }
    } else {
      this.canvas.style.imageRendering = 'auto';

      const inputLevel = this.inputAnalyser
        ? this.getAverageLevel(this.inputAnalyser.data)
        : 0;
      const outputLevel = this.outputAnalyser
        ? this.getAverageLevel(this.outputAnalyser.data)
        : 0;

      this.smoothedInput += (inputLevel - this.smoothedInput) * 0.25;
      this.smoothedOutput += (outputLevel - this.smoothedOutput) * 0.25;

      const combinedIntensity = Math.min(
        1,
        this.smoothedInput * 1.6 + this.smoothedOutput * 1.6,
      );

      let orbModeValue = 1;
      this.wireframeShell.visible = false;

      if (this.orbStyle === 'solar-flare') {
        orbModeValue = 2;
        this.ambientLight.color.setHex(0x552208);
        this.ambientLight.intensity = 1.4;
        this.inputLight.color.setHex(0xff5500);
        this.outputLight.color.setHex(0xffcc33);
        this.inputLight.intensity = 3.0 + this.smoothedInput * 10.0;
        this.outputLight.intensity = 3.0 + this.smoothedOutput * 10.0;

        sphereMaterial.color.setHex(0x260900);
        sphereMaterial.metalness = 0.35;
        sphereMaterial.roughness = 0.25;
        sphereMaterial.emissiveIntensity = 1.5 + combinedIntensity * 2.5;
        sphereMaterial.emissive.setRGB(
          0.55 + combinedIntensity * 0.45,
          0.14 + this.smoothedOutput * 0.38,
          0.02 + this.smoothedInput * 0.08,
        );

        this.bloomPass.strength = 2.0;
        this.bloomPass.radius = 0.65;
        this.bloomPass.threshold = 0.1;
      } else if (this.orbStyle === 'crimson-pulse') {
        orbModeValue = 3;
        this.ambientLight.color.setHex(0x450b24);
        this.ambientLight.intensity = 1.2;
        this.inputLight.color.setHex(0xff1e56);
        this.outputLight.color.setHex(0xff6bcb);
        this.inputLight.intensity = 2.5 + this.smoothedInput * 9.0;
        this.outputLight.intensity = 2.5 + this.smoothedOutput * 9.0;

        sphereMaterial.color.setHex(0x18020b);
        sphereMaterial.metalness = 0.85;
        sphereMaterial.roughness = 0.08;
        sphereMaterial.emissiveIntensity = 1.4 + combinedIntensity * 2.4;
        sphereMaterial.emissive.setRGB(
          0.35 + combinedIntensity * 0.55,
          0.02 + this.smoothedOutput * 0.08,
          0.12 + this.smoothedInput * 0.3,
        );

        this.bloomPass.strength = 1.8;
        this.bloomPass.radius = 0.45;
        this.bloomPass.threshold = 0.12;
      } else if (this.orbStyle === 'cyber-grid') {
        orbModeValue = 4;
        this.wireframeShell.visible = true;
        this.wireframeShell.scale.setScalar(
          1 + 0.28 * this.smoothedInput + 0.3 * this.smoothedOutput,
        );
        this.wireframeShell.rotation.y -= dt * (0.004 + combinedIntensity * 0.02);
        this.wireframeShell.rotation.x += dt * (0.002 + combinedIntensity * 0.015);
        this.wireframeMaterial.opacity = 0.35 + combinedIntensity * 0.6;
        this.wireframeMaterial.color.setRGB(
          0.0 + this.smoothedInput * 0.2,
          0.85 + combinedIntensity * 0.15,
          0.75 + this.smoothedOutput * 0.25,
        );

        this.ambientLight.color.setHex(0x0b3a42);
        this.ambientLight.intensity = 1.2;
        this.inputLight.color.setHex(0x00ffa3);
        this.outputLight.color.setHex(0x00d9ff);
        this.inputLight.intensity = 2.2 + this.smoothedInput * 9.0;
        this.outputLight.intensity = 2.2 + this.smoothedOutput * 9.0;

        sphereMaterial.color.setHex(0x02141c);
        sphereMaterial.metalness = 0.75;
        sphereMaterial.roughness = 0.12;
        sphereMaterial.emissiveIntensity = 1.3 + combinedIntensity * 2.1;
        sphereMaterial.emissive.setRGB(
          0.01,
          0.22 + this.smoothedInput * 0.4,
          0.3 + this.smoothedOutput * 0.55,
        );

        this.bloomPass.strength = 1.7;
        this.bloomPass.radius = 0.5;
        this.bloomPass.threshold = 0.1;
      } else {
        orbModeValue = 1;
        this.ambientLight.color.setHex(0x3a2a55);
        this.ambientLight.intensity = 1.2;
        this.inputLight.color.setHex(0xff4f8b);
        this.outputLight.color.setHex(0x4f9cff);
        this.inputLight.intensity = 2.0 + this.smoothedInput * 8.0;
        this.outputLight.intensity = 2.0 + this.smoothedOutput * 8.0;

        sphereMaterial.color.setHex(0x0b0818);
        sphereMaterial.metalness = 0.6;
        sphereMaterial.roughness = 0.15;
        sphereMaterial.emissiveIntensity = 1.3 + combinedIntensity * 2.2;
        sphereMaterial.emissive.setRGB(
          0.1 + this.smoothedInput * 0.45,
          0.06 + combinedIntensity * 0.14,
          0.22 + this.smoothedOutput * 0.45,
        );

        this.bloomPass.strength = 1.6;
        this.bloomPass.radius = 0.55;
        this.bloomPass.threshold = 0.1;
      }

      this.sphere.scale.setScalar(
        1 + 0.22 * this.smoothedInput + 0.24 * this.smoothedOutput,
      );

      const f = 0.0015;
      this.rotation.x += dt * (0.0008 + f * (outMid + inMid * 0.8));
      this.rotation.z += dt * (0.0005 + f * (inMid + outLow * 0.5));
      this.rotation.y += dt * (0.0012 + f * 0.5 * (inHigh + outHigh));

      const euler = new THREE.Euler(
        this.rotation.x,
        this.rotation.y,
        this.rotation.z,
      );
      const quaternion = new THREE.Quaternion().setFromEuler(euler);
      const vector = new THREE.Vector3(0, 0, 5);
      vector.applyQuaternion(quaternion);
      this.camera.position.copy(vector);
      this.camera.lookAt(this.sphere.position);

      if (sphereMaterial.userData.shader) {
        sphereMaterial.userData.shader.uniforms.orbMode.value = orbModeValue;
        sphereMaterial.userData.shader.uniforms.time.value +=
          dt * (0.015 + 0.14 * (this.smoothedInput + this.smoothedOutput));
        sphereMaterial.userData.shader.uniforms.inputData.value.set(
          Math.max(this.smoothedInput * 1.4, inLow),
          Math.max(this.smoothedInput, inMid),
          2.5 + 8.0 * inHigh,
          0,
        );
        sphereMaterial.userData.shader.uniforms.outputData.value.set(
          Math.max(this.smoothedOutput * 1.4, outLow),
          Math.max(this.smoothedOutput, outMid),
          2.5 + 8.0 * outHigh,
          0,
        );
      }
    }

    this.composer.render();
  }

  protected firstUpdated() {
    // Use renderRoot instead of shadowRoot to fix TypeScript property error.
    this.canvas = (this.renderRoot as HTMLElement).querySelector('canvas') as HTMLCanvasElement;
    this.init();
  }

  protected render() {
    return html`<canvas></canvas>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gdm-live-audio-visuals-3d': GdmLiveAudioVisuals3D;
  }
}
