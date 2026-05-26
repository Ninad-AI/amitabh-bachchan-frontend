/**
 * Audio utility functions for recording, VAD, and streaming.
 */


/* ────────────────────────────────────────────────────
 *  Continuous PCM16 streaming over WebSocket
 * ──────────────────────────────────────────────────── */

export interface StreamingMicHandle {
  stop: () => void;
}

interface StreamingMicOptions {
  /** RMS energy floor before dynamic calibration (default 0.01) */
  energyThreshold?: number;
  /** Trailing silence in ms before emitting speech_end (default 600) */
  silenceMs?: number;
  /** Called when VAD detects the user started speaking */
  onSpeechStart?: () => void;
  /** Called when VAD detects the user stopped speaking */
  onSpeechEnd?: () => void;
}

/**
 * Start streaming raw PCM16 audio to a WebSocket at 16 kHz in 20 ms frames
 * (320 samples per frame — required for server-side VAD).
 *
 * Built-in energy-based VAD automatically sends JSON
 * `{ "type": "speech_start" }` and `{ "type": "speech_end" }` messages
 * bracketing each utterance. PCM16 frames are streamed continuously.
 */
export const startStreamingMic = async (
  ws: WebSocket,
  onAudioLevel?: (level: number) => void,
  options: StreamingMicOptions = {},
): Promise<StreamingMicHandle> => {
  const {
    energyThreshold = 0.01,
    silenceMs = 600,
    onSpeechStart,
    onSpeechEnd,
  } = options;

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
  const audioContext: AudioContext = new AudioContextCtor({ sampleRate: 48000 });

  // MUST resume after user gesture
  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }

  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(1024, 1, 1);

  // Connect the graph
  source.connect(processor);
  processor.connect(audioContext.destination);

  /* ── VAD state ── */
  let framesSent = 0;
  let isSpeaking = false;
  let lastSpeechTs = 0;         // ms timestamp of last above-threshold frame
  let noiseSum = 0;
  let noiseCount = 0;
  const calibrationMs = 500;    // first 0.5 s used for noise-floor estimation
  const streamStartTime = performance.now();

  processor.onaudioprocess = (event: AudioProcessingEvent) => {
    if (ws.readyState !== WebSocket.OPEN) return;

    const input = event.inputBuffer.getChannelData(0);

    // ── Downsample to 16 kHz ──
    const targetSampleRate = 16000;
    const ratio = audioContext.sampleRate / targetSampleRate;
    const newLength = Math.floor(input.length / ratio);
    const downsampled = new Float32Array(newLength);

    for (let i = 0; i < newLength; i++) {
      downsampled[i] = input[Math.floor(i * ratio)];
    }

    // ── Compute RMS energy on downsampled buffer ──
    let energySum = 0;
    for (let i = 0; i < downsampled.length; i++) {
      energySum += downsampled[i] * downsampled[i];
    }
    const rms = Math.sqrt(energySum / downsampled.length);

    // ── Dynamic noise-floor calibration (first 0.5 s) ──
    const elapsed = performance.now() - streamStartTime;
    if (elapsed < calibrationMs) {
      noiseSum += rms;
      noiseCount += 1;
    }

    let threshold = energyThreshold;
    if (noiseCount > 0) {
      const estNoise = noiseSum / noiseCount;
      threshold = Math.max(energyThreshold, estNoise * 3.0);
    }

    // ── VAD decision ──
    const now = performance.now();

    if (rms >= threshold) {
      lastSpeechTs = now;

      if (!isSpeaking) {
        isSpeaking = true;
        ws.send(JSON.stringify({ type: "speech_start" }));
        if (typeof onSpeechStart === "function") onSpeechStart();
      }
    } else if (isSpeaking) {
      const silenceElapsed = now - lastSpeechTs;
      if (silenceElapsed >= silenceMs) {
        isSpeaking = false;
        ws.send(JSON.stringify({ type: "speech_end" }));
        if (typeof onSpeechEnd === "function") onSpeechEnd();
      }
    }

    // ── Float32 → PCM16 ──
    const pcm16 = new Int16Array(downsampled.length);
    for (let i = 0; i < downsampled.length; i++) {
      const s = Math.max(-1, Math.min(1, downsampled[i]));
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }

    // ── 20 ms frame chunking (REQUIRED FOR VAD) ──
    const FRAME_SIZE = 320; // 20 ms @ 16 kHz

    for (let i = 0; i < pcm16.length; i += FRAME_SIZE) {
      const frame = pcm16.slice(i, i + FRAME_SIZE);
      if (frame.length === FRAME_SIZE) {
        ws.send(frame.buffer);
        framesSent++;
      }
    }

    // ── Optional audio level callback ──
    if (typeof onAudioLevel === "function") {
      onAudioLevel(Math.min(rms * 8, 1));
    }
  };

  return {
    stop: () => {
      // If still speaking when stopped, send a final speech_end
      if (isSpeaking && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "speech_end" }));
        if (typeof onSpeechEnd === "function") onSpeechEnd();
      }
      processor.disconnect();
      source.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      audioContext.close();
    },
  };
};
