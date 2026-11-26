
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

type TerminalTheme = 'matrix' | 'amber' | 'cyber' | 'default';

const TERMINAL_THEMES: {id: TerminalTheme; label: string}[] = [
  {id: 'matrix', label: 'Matrix-Grün'},
  {id: 'amber', label: 'Bernstein'},
  {id: 'cyber', label: 'Cyber-Blau'},
  {id: 'default', label: 'Standard'},
];

interface ChatMessage {
  id: number;
  role: 'user' | 'ella';
  text: string;
  final: boolean;
}

@customElement('gdm-live-audio')
export class GdmLiveAudio extends LitElement {
  @state() isRecording = false;
  @state() isProcessing = false;
  @state() status = '';
  @state() error = '';
  @state() textInput = '';
  @state() orbStyle: OrbStyle = 'reactive';
  @state() terminalTheme: TerminalTheme = 'matrix';
  @state() messages: ChatMessage[] = [];
  @state() isHistoryOpen = true;

  private nextMessageId = 1;
  private ws: WebSocket | null = null;
  private pendingTextQueue: string[] = [];
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
    .app-shell {
      --term-font: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      --term-text: #ffffff;
      --term-muted: rgba(255, 255, 255, 0.65);
      --term-accent: #a78bfa;
      --term-bg: rgba(16, 12, 20, 0.52);
      --term-surface: rgba(255, 255, 255, 0.1);
      --term-surface-hover: rgba(255, 255, 255, 0.18);
      --term-border: rgba(255, 255, 255, 0.2);
      --term-border-strong: rgba(255, 255, 255, 0.45);
      --term-glow: rgba(167, 139, 250, 0.18);
      --term-user-bg: rgba(255, 255, 255, 0.14);
      --term-ella-bg: rgba(124, 58, 237, 0.22);
      --term-ella-border: rgba(167, 139, 250, 0.28);
      --term-scanline: 0;
    }

    .app-shell.theme-matrix {
      --term-font: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      --term-text: #b9ffd0;
      --term-muted: rgba(0, 255, 102, 0.7);
      --term-accent: #00ff66;
      --term-bg: rgba(3, 18, 9, 0.72);
      --term-surface: rgba(0, 255, 102, 0.08);
      --term-surface-hover: rgba(0, 255, 102, 0.18);
      --term-border: rgba(0, 255, 102, 0.34);
      --term-border-strong: rgba(0, 255, 102, 0.72);
      --term-glow: rgba(0, 255, 102, 0.24);
      --term-user-bg: rgba(0, 255, 102, 0.12);
      --term-ella-bg: rgba(0, 180, 72, 0.2);
      --term-ella-border: rgba(0, 255, 102, 0.4);
      --term-scanline: 1;
    }

    .app-shell.theme-amber {
      --term-font: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      --term-text: #ffe4ad;
      --term-muted: rgba(255, 176, 0, 0.72);
      --term-accent: #ffb000;
      --term-bg: rgba(20, 11, 2, 0.74);
      --term-surface: rgba(255, 176, 0, 0.09);
      --term-surface-hover: rgba(255, 176, 0, 0.19);
      --term-border: rgba(255, 176, 0, 0.36);
      --term-border-strong: rgba(255, 196, 54, 0.75);
      --term-glow: rgba(255, 176, 0, 0.24);
      --term-user-bg: rgba(255, 176, 0, 0.13);
      --term-ella-bg: rgba(190, 105, 0, 0.22);
      --term-ella-border: rgba(255, 176, 0, 0.42);
      --term-scanline: 1;
    }

    .app-shell.theme-cyber {
      --term-font: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      --term-text: #c4f7ff;
      --term-muted: rgba(0, 229, 255, 0.72);
      --term-accent: #00e5ff;
      --term-bg: rgba(2, 16, 26, 0.74);
      --term-surface: rgba(0, 229, 255, 0.08);
      --term-surface-hover: rgba(0, 229, 255, 0.18);
      --term-border: rgba(0, 229, 255, 0.35);
      --term-border-strong: rgba(0, 229, 255, 0.75);
      --term-glow: rgba(0, 229, 255, 0.24);
      --term-user-bg: rgba(0, 229, 255, 0.12);
      --term-ella-bg: rgba(0, 132, 209, 0.22);
      --term-ella-border: rgba(0, 229, 255, 0.42);
      --term-scanline: 1;
    }

    .scanline-overlay {
      pointer-events: none;
      position: fixed;
      inset: 0;
      z-index: 5;
      opacity: calc(var(--term-scanline) * 0.16);
      background: repeating-linear-gradient(
        to bottom,
        transparent 0px,
        transparent 2px,
        rgba(0, 0, 0, 0.55) 3px
      );
      transition: opacity 0.3s ease;
    }

    #status {
      position: absolute;
      bottom: 2.5vh;
      left: 0;
      right: 0;
      z-index: 10;
      text-align: center;
      color: var(--term-muted);
      font-family: var(--term-font);
      font-size: 13px;
      pointer-events: none;
      transition: color 0.25s ease;
    }

    .controls {
      z-index: 10;
      position: absolute;
      bottom: 6.5vh;
      left: 0;
      right: 0;
      padding: 0 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      gap: 14px;
    }

    .top-controls {
      display: flex;
      align-items: flex-end;
      justify-content: center;
      flex-wrap: wrap;
      gap: 14px;
    }

    @keyframes inputFadeIn {
      0% {
        opacity: 0.45;
        transform: translateY(8px);
      }
      100% {
        opacity: 1;
        transform: translateY(0);
      }
    }

    .chat-history {
      z-index: 10;
      position: absolute;
      top: 20px;
      left: 20px;
      width: min(360px, calc(100vw - 40px));
      background: var(--term-bg);
      backdrop-filter: blur(14px);
      border: 1px solid var(--term-border);
      box-shadow: 0 0 24px var(--term-glow);
      border-radius: 16px;
      color: var(--term-text);
      font-family: var(--term-font);
      overflow: hidden;
      box-sizing: border-box;
      transition: all 0.25s ease;
    }

    .chat-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px;
      border-bottom: 1px solid var(--term-border);
      font-size: 12px;
      letter-spacing: 0.8px;
      text-transform: uppercase;
      color: var(--term-accent);
    }

    .chat-history.collapsed .chat-header {
      border-bottom: none;
    }

    .history-toggle {
      width: auto;
      height: auto;
      border-radius: 8px;
      padding: 4px 10px;
      font-family: var(--term-font);
      font-size: 11px;
      letter-spacing: 0.5px;
      text-transform: uppercase;
      background: var(--term-surface);
      border: 1px solid var(--term-border);
      color: var(--term-text);
    }

    .chat-messages {
      max-height: 32vh;
      overflow-y: auto;
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      scrollbar-width: thin;
      scrollbar-color: var(--term-border) transparent;
    }

    .chat-empty {
      font-size: 13px;
      color: var(--term-muted);
      margin: 4px 0;
    }

    .chat-message {
      display: flex;
      flex-direction: column;
      gap: 3px;
      padding: 8px 12px;
      border-radius: 12px;
      font-size: 13px;
      line-height: 1.45;
      word-break: break-word;
    }

    .chat-message.user {
      align-self: flex-end;
      max-width: 85%;
      background: var(--term-user-bg);
      border: 1px solid var(--term-border);
    }

    .chat-message.ella {
      align-self: flex-start;
      max-width: 88%;
      background: var(--term-ella-bg);
      border: 1px solid var(--term-ella-border);
    }

    .chat-role {
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.7px;
      text-transform: uppercase;
      color: var(--term-accent);
    }

    .text-input-form {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      max-width: 440px;
      background: var(--term-bg);
      backdrop-filter: blur(12px);
      border: 1px solid var(--term-border);
      border-radius: 16px;
      padding: 6px 6px 6px 16px;
      box-sizing: border-box;
      opacity: 0.65;
      transform: translateY(4px);
      transition: opacity 0.35s ease, transform 0.35s ease, background 0.25s ease, border-color 0.25s ease, box-shadow 0.35s ease;

      &:hover,
      &:focus-within {
        opacity: 1;
        transform: translateY(0);
        border-color: var(--term-border-strong);
        box-shadow: 0 0 22px var(--term-glow);
      }

      &.active {
        opacity: 1;
        transform: translateY(0);
        animation: inputFadeIn 0.45s cubic-bezier(0.22, 1, 0.36, 1);
        border-color: var(--term-border-strong);
        box-shadow: 0 0 24px var(--term-glow);
      }

      input {
        flex: 1;
        min-width: 0;
        background: transparent;
        border: none;
        outline: none;
        color: var(--term-text);
        font-family: var(--term-font);
        font-size: 14px;

        &::placeholder {
          color: var(--term-muted);
        }
      }

      .send-button {
        width: 40px;
        height: 40px;
        flex-shrink: 0;
        border-radius: 50%;
        border: 1px solid var(--term-border);
        background: var(--term-surface);
        color: var(--term-accent);
      }
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
      color: var(--term-accent);
      font-family: var(--term-font);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 1px;

      select {
        background: var(--term-bg);
        backdrop-filter: blur(10px);
        border: 1px solid var(--term-border);
        color: var(--term-text);
        padding: 8px 16px;
        border-radius: 20px;
        outline: none;
        cursor: pointer;
        font-family: var(--term-font);
        font-size: 14px;
        transition: all 0.3s ease;
        min-width: 140px;
        text-align: center;

        &:hover {
          background: var(--term-surface-hover);
          border-color: var(--term-border-strong);
        }

        option {
          background: #100c14;
          color: #ffffff;
        }
      }
    }

    .theme-button {
      width: auto;
      height: 38px;
      border-radius: 20px;
      padding: 0 16px;
      gap: 8px;
      font-family: var(--term-font);
      font-size: 13px;
      background: var(--term-bg);
      border: 1px solid var(--term-border);
      color: var(--term-text);
      box-shadow: 0 0 16px var(--term-glow);

      &:hover:not([disabled]) {
        background: var(--term-surface-hover);
        border-color: var(--term-border-strong);
        transform: translateY(-1px);
      }
    }

    .theme-dot {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: var(--term-accent);
      box-shadow: 0 0 8px var(--term-accent);
      flex-shrink: 0;
    }

    button {
      outline: none;
      border: 1px solid var(--term-border);
      color: var(--term-text);
      border-radius: 50%;
      background: var(--term-surface);
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
        background: var(--term-surface-hover);
        border-color: var(--term-border-strong);
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
    try {
      const saved = localStorage.getItem('ella-terminal-theme') as TerminalTheme | null;
      if (saved && TERMINAL_THEMES.some((t) => t.id === saved)) {
        this.terminalTheme = saved;
      }
    } catch {
      // Ignore storage access restrictions
    }
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

  private appendTranscript(role: 'user' | 'ella', chunk: string) {
    if (!chunk) return;
    const updated = [...this.messages];
    const last = updated[updated.length - 1];

    if (last && last.role === role && !last.final) {
      updated[updated.length - 1] = {
        ...last,
        text: `${last.text}${chunk}`,
      };
    } else {
      for (let i = 0; i < updated.length; i++) {
        if (!updated[i].final) {
          updated[i] = {...updated[i], final: true};
        }
      }
      updated.push({
        id: this.nextMessageId++,
        role,
        text: chunk.trimStart(),
        final: false,
      });
    }

    this.messages = updated;
  }

  private finalizeMessages() {
    if (!this.messages.some((m) => !m.final)) return;
    this.messages = this.messages.map((m) =>
      m.final ? m : {...m, final: true},
    );
  }

  protected updated(changedProperties: Map<string, unknown>) {
    if (changedProperties.has('messages') || changedProperties.has('isHistoryOpen')) {
      const container = this.renderRoot.querySelector('.chat-messages');
      if (container) {
        container.scrollTop = container.scrollHeight;
      }
    }
  }

  private initSession() {
    this.closeCurrentSocket();
    this.updateError('');

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/live?voice=${encodeURIComponent('Französin')}`;

    try {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;

      ws.onopen = () => {
        if (this.ws !== ws) return;
        while (this.pendingTextQueue.length > 0 && ws.readyState === WebSocket.OPEN) {
          const text = this.pendingTextQueue.shift();
          if (text) {
            ws.send(JSON.stringify({type: 'text', text}));
          }
        }
      };

      ws.onmessage = async (event: MessageEvent) => {
        if (this.ws !== ws) return;

        let msg: {
          type?: string;
          status?: string;
          message?: string;
          data?: string;
          text?: string;
        };
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }

        if (msg.type === 'status' && msg.status) {
          this.updateStatus(msg.status);
        } else if (msg.type === 'error' && msg.message) {
          this.isProcessing = false;
          this.updateError(msg.message);
        } else if (msg.type === 'inputTranscript' && msg.text) {
          this.isProcessing = true;
          this.appendTranscript('user', msg.text);
        } else if (msg.type === 'outputTranscript' && msg.text) {
          this.isProcessing = true;
          this.appendTranscript('ella', msg.text);
        } else if (msg.type === 'audio' && msg.data) {
          this.isProcessing = true;
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
            if (this.sources.size === 0) {
              this.isProcessing = false;
              if (!this.isRecording) {
                this.updateStatus('Session Active');
              }
            }
          });

          source.start(this.nextStartTime);
          this.nextStartTime = this.nextStartTime + audioBuffer.duration;
          this.sources.add(source);
        } else if (msg.type === 'turnComplete') {
          this.finalizeMessages();
          if (this.sources.size === 0) {
            this.isProcessing = false;
          }
        } else if (msg.type === 'interrupted') {
          this.stopOutputAudio();
          this.finalizeMessages();
          this.isProcessing = false;
        }
      };

      ws.onerror = () => {
        if (this.ws !== ws) return;
        this.isProcessing = false;
        this.updateError('Failed to connect to the session.');
      };

      ws.onclose = (e: CloseEvent) => {
        if (this.ws !== ws) return;
        this.ws = null;
        this.isProcessing = false;
        if (!this.error) {
          this.updateStatus(
            'Session Closed: ' + (e.reason || 'Disconnected'),
          );
        }
      };
    } catch (e) {
      console.error(e);
      this.isProcessing = false;
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
    this.messages = [];
    this.isProcessing = false;
    this.initSession();
    this.updateStatus('Session Reset');
  }

  private handleOrbChange(e: Event) {
    const select = e.target as HTMLSelectElement;
    this.orbStyle = select.value as OrbStyle;
  }

  private toggleHistory() {
    this.isHistoryOpen = !this.isHistoryOpen;
  }

  private cycleTerminalTheme() {
    const idx = TERMINAL_THEMES.findIndex((t) => t.id === this.terminalTheme);
    const next = TERMINAL_THEMES[(idx + 1) % TERMINAL_THEMES.length];
    this.terminalTheme = next.id;
    try {
      localStorage.setItem('ella-terminal-theme', next.id);
    } catch {
      // Ignore storage access restrictions
    }
  }

  private handleTextInput(e: Event) {
    const input = e.target as HTMLInputElement;
    this.textInput = input.value;
  }

  private async handleTextSubmit(e: Event) {
    e.preventDefault();
    const text = this.textInput.trim();
    if (!text) return;

    this.textInput = '';
    this.finalizeMessages();
    this.messages = [
      ...this.messages,
      {id: this.nextMessageId++, role: 'user', text, final: true},
    ];
    this.isProcessing = true;
    this.stopOutputAudio();
    await this.outputAudioContext.resume();

    if (
      !this.ws ||
      (this.ws.readyState !== WebSocket.OPEN &&
        this.ws.readyState !== WebSocket.CONNECTING)
    ) {
      this.pendingTextQueue.push(text);
      this.initSession();
      this.updateStatus('Connecting...');
      return;
    }

    if (this.ws.readyState === WebSocket.CONNECTING) {
      this.pendingTextQueue.push(text);
      return;
    }

    this.ws.send(JSON.stringify({type: 'text', text}));
    if (!this.isRecording) {
      this.updateStatus('Responding...');
    }
  }

  render() {
    const isInputActive = this.isRecording || this.isProcessing;
    const currentThemeLabel =
      TERMINAL_THEMES.find((t) => t.id === this.terminalTheme)?.label ??
      'Matrix-Grün';

    return html`
      <div class="app-shell theme-${this.terminalTheme}">
        <div class="scanline-overlay"></div>

        <div class="chat-history ${this.isHistoryOpen ? '' : 'collapsed'}">
          <div class="chat-header">
            <span>Chat-Verlauf · Ella</span>
            <button
              class="history-toggle"
              type="button"
              @click=${this.toggleHistory}>
              ${this.isHistoryOpen ? 'Ausblenden' : 'Anzeigen'}
            </button>
          </div>
          ${this.isHistoryOpen
            ? html`
                <div class="chat-messages">
                  ${this.messages.length === 0
                    ? html`<p class="chat-empty">Noch keine Nachrichten. Sprich oder schreib Ella.</p>`
                    : this.messages.map(
                        (m) => html`
                          <div class="chat-message ${m.role}">
                            <span class="chat-role">
                              ${m.role === 'user' ? 'Du' : 'Ella'}
                            </span>
                            <span>${m.text}</span>
                          </div>
                        `,
                      )}
                </div>
              `
            : ''}
        </div>

        <div class="controls">
          <div class="top-controls">
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

            <div class="voice-selector">
              <label>Terminal-Farbe</label>
              <button
                id="themeButton"
                class="theme-button"
                type="button"
                title="Hacker-Terminal-Farbe umschalten"
                @click=${this.cycleTerminalTheme}>
                <span class="theme-dot"></span>
                <span>${currentThemeLabel}</span>
              </button>
            </div>
          </div>

          <form
            class="text-input-form ${isInputActive ? 'active' : ''}"
            @submit=${this.handleTextSubmit}>
            <input
              id="text-input"
              type="text"
              .value=${this.textInput}
              @input=${this.handleTextInput}
              placeholder="Nachricht an Ella..."
              autocomplete="off"
              aria-label="Nachricht an Ella" />
            <button
              class="send-button"
              type="submit"
              title="Nachricht senden"
              ?disabled=${!this.textInput.trim()}>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                height="20px"
                viewBox="0 -960 960 960"
                width="20px"
                fill="currentColor">
                <path d="M120-160v-640l760 320-760 320Zm80-120 474-200-474-200v140l240 60-240 60v140Zm0 0v-400 400Z" />
              </svg>
            </button>
          </form>

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
