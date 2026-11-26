
/* tslint:disable */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {LitElement, css, html} from 'lit';
import {customElement, state} from 'lit/decorators.js';
import {createBlob, decode, decodeAudioData} from './utils';
import './visual-3d';
import type {OrbStyle} from './visual-3d';

@customElement('gdm-live-audio')
export class GdmLiveAudio extends LitElement {
  @state() isRecording = false;
  @state() status = '';
  @state() error = '';
  @state() orbStyle: OrbStyle = 'reactive';

  private ws: WebSocket | null = null;
  // Fix webkitAudioContext error by casting window to any
  private inputAudioContext = new ((window as any).AudioContext ||
    (window as any).webkitAudioContext)({sampleRate: 16000});
  private outputAudioContext = new ((window as any).AudioContext ||
    (window as any).webkitAudioContext)({sampleRate: 24000});
  @state() inputNode = this.inputAudioContext.createGain();
  @state() outputNode = this.outputAudioContext.createGain();
  private nextStartTime = 0;
  private mediaStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private scriptProcessorNode: ScriptProcessorNode | null = null;
  private sources = new Set<AudioBufferSourceNode>();

  static styles = css`
    #status {
      position: absolute;
      bottom: 5vh;
      left: 0;
      right: 0;
      z-index: 10;
      text-align: center;
      color: rgba(255, 255, 255, 0.7);
      font-family: sans-serif;
      font-size: 14px;
      pointer-events: none;
    }

    .controls {
      z-index: 10;
      position: absolute;
      bottom: 10vh;
      left: 0;
      right: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      gap: 20px;
    }

    .button-group {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 15px;
    }

    .selectors {
      display: flex;
      align-items: center;
      justify-content: center;
      flex-wrap: wrap;
      gap: 16px;
    }

    .voice-selector {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      color: white;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 1px;

      select {
        background: rgba(255, 255, 255, 0.1);
        backdrop-filter: blur(10px);
        border: 1px solid rgba(255, 255, 255, 0.2);
        color: white;
        padding: 8px 16px;
        border-radius: 20px;
        outline: none;
        cursor: pointer;
        font-size: 14px;
        transition: all 0.3s ease;
        min-width: 140px;
        text-align: center;

        &:hover {
          background: rgba(255, 255, 255, 0.2);
          border-color: rgba(255, 255, 255, 0.4);
        }

        option {
          background: #1a1620;
          color: white;
        }
      }
    }

    button {
      outline: none;
      border: 1px solid rgba(255, 255, 255, 0.2);
      color: white;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.1);
      backdrop-filter: blur(10px);
      width: 64px;
      height: 64px;
      cursor: pointer;
      font-size: 24px;
      padding: 0;
      margin: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.3s ease;

      &:hover:not([disabled]) {
        background: rgba(255, 255, 255, 0.2);
        transform: scale(1.05);
      }

      &:active:not([disabled]) {
        transform: scale(0.95);
      }
    }

    button[disabled] {
      opacity: 0.3;
      cursor: default;
      pointer-events: none;
    }
  `;

  constructor() {
    super();
    this.initClient();
  }

  private initAudio() {
    this.nextStartTime = this.outputAudioContext.currentTime;
  }

  private async initClient() {
    this.initAudio();
    this.outputNode.connect(this.outputAudioContext.destination);
    this.initSession();
  }

  private closeCurrentSocket() {
    if (this.ws) {
      const oldWs = this.ws;
      this.ws = null;
      oldWs.onopen = null;
      oldWs.onmessage = null;
      oldWs.onerror = null;
      oldWs.onclose = null;
      if (
        oldWs.readyState === WebSocket.OPEN ||
        oldWs.readyState === WebSocket.CONNECTING
      ) {
        oldWs.close();
      }
    }
  }

  private stopOutputAudio() {
    for (const source of this.sources.values()) {
      try {
        source.stop();
      } catch {
        // Ignore already-stopped source
      }
      this.sources.delete(source);
    }
    this.nextStartTime = 0;
  }

  private initSession() {
    this.closeCurrentSocket();
    this.updateError('');

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/live?voice=${encodeURIComponent('Französin')}`;

    try {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;

      ws.onmessage = async (event: MessageEvent) => {
        if (this.ws !== ws) return;

        let msg: {
          type?: string;
          status?: string;
          message?: string;
          data?: string;
        };
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }

        if (msg.type === 'status' && msg.status) {
          this.updateStatus(msg.status);
        } else if (msg.type === 'error' && msg.message) {
          this.updateError(msg.message);
        } else if (msg.type === 'audio' && msg.data) {
          this.nextStartTime = Math.max(
            this.nextStartTime,
            this.outputAudioContext.currentTime,
          );

          const audioBuffer = await decodeAudioData(
            decode(msg.data),
            this.outputAudioContext,
            24000,
            1,
          );
          const source = this.outputAudioContext.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(this.outputNode);
          source.addEventListener('ended', () => {
            this.sources.delete(source);
          });

          source.start(this.nextStartTime);
          this.nextStartTime = this.nextStartTime + audioBuffer.duration;
          this.sources.add(source);
        } else if (msg.type === 'interrupted') {
          this.stopOutputAudio();
        }
      };

      ws.onerror = () => {
        if (this.ws !== ws) return;
        this.updateError('Failed to connect to the session.');
      };

      ws.onclose = (e: CloseEvent) => {
        if (this.ws !== ws) return;
        this.ws = null;
        if (!this.error) {
          this.updateStatus(
            'Session Closed: ' + (e.reason || 'Disconnected'),
          );
        }
      };
    } catch (e) {
      console.error(e);
      this.updateError('Failed to connect to the session.');
    }
  }

  private updateStatus(msg: string) {
    this.status = msg;
  }

  private updateError(msg: string) {
    this.error = msg;
  }

  private async startRecording() {
    if (this.isRecording) {
      return;
    }

    if (
      !this.ws ||
      (this.ws.readyState !== WebSocket.OPEN &&
        this.ws.readyState !== WebSocket.CONNECTING)
    ) {
      this.initSession();
    }

    await this.inputAudioContext.resume();
    await this.outputAudioContext.resume();
    this.updateStatus('Connecting microphone...');

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });

      this.updateStatus('Microphone active');

      this.sourceNode = this.inputAudioContext.createMediaStreamSource(
        this.mediaStream,
      );
      this.sourceNode.connect(this.inputNode);

      const bufferSize = 4096; // Standard buffer size
      this.scriptProcessorNode = this.inputAudioContext.createScriptProcessor(
        bufferSize,
        1,
        1,
      );

      this.scriptProcessorNode.onaudioprocess = (audioProcessingEvent) => {
        if (!this.isRecording) return;
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        const inputBuffer = audioProcessingEvent.inputBuffer;
        const pcmData = inputBuffer.getChannelData(0);
        const blob = createBlob(pcmData);

        this.ws.send(JSON.stringify({type: 'audio', data: blob.data}));
      };

      this.sourceNode.connect(this.scriptProcessorNode);
      this.scriptProcessorNode.connect(this.inputAudioContext.destination);

      this.isRecording = true;
      this.updateStatus('Listening...');
    } catch (err: any) {
      console.error('Error starting recording:', err);
      this.updateStatus(`Error: ${err.message}`);
      this.stopRecording();
    }
  }

  private stopRecording() {
    if (!this.isRecording && !this.mediaStream) return;

    this.isRecording = false;

    if (this.scriptProcessorNode) {
      this.scriptProcessorNode.disconnect();
      this.scriptProcessorNode = null;
    }

    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    this.updateStatus('Paused');
  }

  private reset() {
    this.stopOutputAudio();
    this.initSession();
    this.updateStatus('Session Reset');
  }

  private handleOrbChange(e: Event) {
    const select = e.target as HTMLSelectElement;
    this.orbStyle = select.value as OrbStyle;
  }

  render() {
    return html`
      <div>
        <div class="controls">
          <div class="voice-selector">
            <label for="orb-select">Orb Style</label>
            <select id="orb-select" @change=${this.handleOrbChange}>
              <option value="reactive" ?selected=${this.orbStyle === 'reactive'}>
                Reaktiv (Jetzt)
              </option>
              <option value="classic" ?selected=${this.orbStyle === 'classic'}>
                Klassisch (Vorher)
              </option>
              <option value="cyber-grid" ?selected=${this.orbStyle === 'cyber-grid'}>
                Cyber Grid (Jarvis)
              </option>
              <option value="solar-flare" ?selected=${this.orbStyle === 'solar-flare'}>
                Solar Flare (Plasma)
              </option>
              <option value="crimson-pulse" ?selected=${this.orbStyle === 'crimson-pulse'}>
                Crimson Pulse (Laser)
              </option>
            </select>
          </div>

          <div class="button-group">
            <button
              id="resetButton"
              title="Reset Session"
              @click=${this.reset}
              ?disabled=${this.isRecording}>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                height="32px"
                viewBox="0 -960 960 960"
                width="32px"
                fill="#ffffff">
                <path
                  d="M480-160q-134 0-227-93t-93-227q0-134 93-227t227-93q69 0 132 28.5T720-690v-110h80v280H520v-80h168q-32-56-87.5-88T480-720q-100 0-170 70t-70 170q0 100 70 170t170 70q77 0 139-44t87-116h84q-28 106-114 173t-196 67Z" />
              </svg>
            </button>
            
            ${!this.isRecording ? html`
              <button
                id="startButton"
                title="Start Listening"
                @click=${this.startRecording}>
                <svg
                  viewBox="0 0 100 100"
                  width="36px"
                  height="36px"
                  fill="#ff3b30"
                  xmlns="http://www.w3.org/2000/svg">
                  <circle cx="50" cy="50" r="45" />
                </svg>
              </button>
            ` : html`
              <button
                id="stopButton"
                title="Stop Listening"
                @click=${this.stopRecording}>
                <svg
                  viewBox="0 0 100 100"
                  width="30px"
                  height="30px"
                  fill="#ffffff"
                  xmlns="http://www.w3.org/2000/svg">
                  <rect x="10" y="10" width="80" height="80" rx="10" />
                </svg>
              </button>
            `}
          </div>
        </div>

        <div id="status"> 
          ${this.error ? html`<span style="color: #ff3b30;">${this.error}</span>` : this.status} 
        </div>

        <gdm-live-audio-visuals-3d
          .inputNode=${this.inputNode}
          .outputNode=${this.outputNode}
          .orbStyle=${this.orbStyle}></gdm-live-audio-visuals-3d>
      </div>
    `;
  }
}
