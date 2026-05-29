/**
 * useVAD - Voice Activity Detection Composables
 *
 * 基于 Web Audio API AnalyserNode 实现实时声音活动检测。
 * 提供音量变化、说话开始/结束回调。
 */
import { onBeforeUnmount, ref } from 'vue';

export type VADCallback = {
  onSpeechStart?: () => void;
  onSpeechEnd?: () => void;
  onVolumeChange?: (volume: number) => void;
};

export type VADOptions = {
  noiseFloor?: number;
  silenceThreshold?: number;
  fftSize?: number;
};

export function useVAD(callbacks: VADCallback, options: VADOptions = {}) {
  const { noiseFloor = 0.01, silenceThreshold = 1500, fftSize = 512 } = options;

  const volume = ref(0);
  const isSpeaking = ref(false);

  let audioContext: AudioContext | null = null;
  let analyserNode: AnalyserNode | null = null;
  let mediaStream: MediaStream | null = null;
  let sourceNode: MediaStreamAudioSourceNode | null = null;
  let animationId: number | null = null;
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;
  let running = false;

  /** 计算 RMS 能量 */
  function calcRMS(data: Uint8Array): number {
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const val = data[i] / 255;
      sum += val * val;
    }
    return Math.sqrt(sum / data.length);
  }

  /** 分析循环 */
  function analyze(): void {
    if (!running || !analyserNode) return;
    const data = new Uint8Array(analyserNode.frequencyBinCount);
    analyserNode.getByteFrequencyData(data);
    const rms = calcRMS(data);
    volume.value = Math.min(1, rms);

    callbacks.onVolumeChange?.(volume.value);

    const active = rms > noiseFloor;
    if (active && !isSpeaking.value) {
      isSpeaking.value = true;
      callbacks.onSpeechStart?.();
      if (silenceTimer !== null) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
      }
    } else if (!active && isSpeaking.value) {
      if (silenceTimer === null) {
        silenceTimer = setTimeout(() => {
          isSpeaking.value = false;
          callbacks.onSpeechEnd?.();
          silenceTimer = null;
        }, silenceThreshold);
      }
    } else if (active) {
      if (silenceTimer !== null) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
      }
    }

    animationId = requestAnimationFrame(analyze);
  }

  /** 启动 VAD */
  async function start(): Promise<void> {
    if (running) return;
    running = true;

    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioContext = new AudioContext();
      sourceNode = audioContext.createMediaStreamSource(mediaStream);

      analyserNode = audioContext.createAnalyser();
      analyserNode.fftSize = fftSize;
      analyserNode.smoothingTimeConstant = 0.3;

      sourceNode.connect(analyserNode);
      analyze();
    } catch (err: any) {
      running = false;
      throw err;
    }
  }

  /** 停止 VAD */
  function stop(): void {
    running = false;
    if (animationId !== null) {
      cancelAnimationFrame(animationId);
      animationId = null;
    }
    if (silenceTimer !== null) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }

    sourceNode?.disconnect();
    sourceNode = null;
    analyserNode = null;

    mediaStream?.getTracks().forEach((t) => t.stop());
    mediaStream = null;

    audioContext?.close().catch(() => {});
    audioContext = null;

    volume.value = 0;
    isSpeaking.value = false;
  }

  onBeforeUnmount(() => {
    stop();
  });

  return {
    volume,
    isSpeaking,
    start,
    stop,
  };
}

export type UseVADReturn = ReturnType<typeof useVAD>;
