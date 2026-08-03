/**
 * useTTS — 语音合成（Text-to-Speech）Composable（Vue 版本）
 *
 * 双供应商架构：
 *   - browser: 浏览器原生 Web Speech Synthesis API（零延迟，无需网络）
 *   - edge:    Edge-TTS 后端代理（Microsoft 免费神经网络 TTS，音质接近 Azure）
 *
 * 对外统一接口，底层实现按 provider 分发。
 */

import { onBeforeUnmount, ref } from 'vue';
import { api } from '../api';
import type { TTSConfig } from './useTTSConfig';

export interface UseTTSOptions {
  onStart?: () => void;
  onEnd?: () => void;
  onError?: (error: string) => void;
}

/** 浏览器 TTS 支持检测 */
const isBrowserTTSSupported = typeof window !== 'undefined' && 'speechSynthesis' in window;

/**
 * 选择浏览器内置语音
 * 优先级：微软中文声音 > 系统中文声音
 */
function getBrowserVoice(lang: string): SpeechSynthesisVoice | null {
  if (!isBrowserTTSSupported) return null;
  const voices = window.speechSynthesis.getVoices();

  if (lang === 'zh-CN') {
    const preferred = voices.find(v =>
      v.name.includes('Xiaoxiao') ||
      v.name.includes('Microsoft Huihui') ||
      v.name.includes('Microsoft Kangkang') ||
      (v.lang === 'zh-CN' && v.name.includes('Microsoft'))
    );
    return preferred || voices.find(v => v.lang === 'zh-CN') || null;
  }

  // en-US
  return voices.find(v => v.lang === 'en-US') || voices.find(v => v.lang.startsWith('en')) || null;
}

// ── Browser TTS 播放 ──────────────────────────────────────

function speakWithBrowser(
  text: string,
  config: TTSConfig,
  callbacks: { onStart?: () => void; onEnd?: () => void; onError?: (err: string) => void },
): void {
  if (!isBrowserTTSSupported) {
    callbacks.onError?.('当前浏览器不支持语音播放，请使用 Chrome 或 Edge 浏览器');
    return;
  }
  if (!text.trim()) return;

  window.speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);

  // 音色
  if (config.voice === 'system') {
    const voice = getBrowserVoice(config.lang);
    if (voice) utterance.voice = voice;
  } else {
    const voices = window.speechSynthesis.getVoices();
    const found = voices.find(v => v.name === config.voice);
    if (found) utterance.voice = found;
  }

  utterance.lang = config.lang || 'zh-CN';

  // 语速
  const rateNum = parseFloat(config.rate.replace(/[+%]/g, '')) / 100 + 1;
  utterance.rate = Math.min(Math.max(rateNum || 1, 0.1), 10);
  utterance.volume = 1;

  utterance.onstart = () => callbacks.onStart?.();
  utterance.onend = () => callbacks.onEnd?.();
  utterance.onerror = (evt) => {
    if (evt.error === 'interrupted' || evt.error === 'canceled') return;
    callbacks.onError?.(`TTS 播放出错: ${evt.error}`);
  };

  window.speechSynthesis.speak(utterance);
}

function stopBrowser(): void {
  if (isBrowserTTSSupported) {
    window.speechSynthesis.cancel();
  }
}

// ── Edge TTS 播放 ─────────────────────────────────────────

let edgeAudio: HTMLAudioElement | null = null;

async function speakWithEdge(
  text: string,
  config: TTSConfig,
  callbacks: { onStart?: () => void; onEnd?: () => void; onError?: (err: string) => void },
): Promise<void> {
  if (!text.trim()) return;

  try {
    // 调用后端 Edge-TTS 端点，获取音频流
    const response = await api.post(
      '/voice/tts',
      {
        text,
        voice: config.voice,
        lang: config.lang,
        rate: config.rate,
      },
      { responseType: 'blob' },
    );

    const audioBlob = response.data as Blob;
    if (!audioBlob || audioBlob.size === 0) {
      callbacks.onError?.('Edge-TTS 返回空音频');
      return;
    }

    const audioUrl = URL.createObjectURL(audioBlob);

    // 停止之前的播放
    stopEdge();

    const audio = new Audio(audioUrl);
    edgeAudio = audio;

    audio.onplay = () => callbacks.onStart?.();
    audio.onended = () => {
      cleanup();
      callbacks.onEnd?.();
    };
    audio.onerror = () => {
      cleanup();
      callbacks.onError?.('Edge-TTS 音频播放失败');
    };

    await audio.play();
  } catch (e: any) {
    callbacks.onError?.(`Edge-TTS 请求失败: ${e?.message || e}`);
  }
}

function stopEdge(): void {
  if (edgeAudio) {
    edgeAudio.pause();
    edgeAudio.currentTime = 0;
    cleanup();
  }
}

function cleanup(): void {
  if (edgeAudio?.src) {
    URL.revokeObjectURL(edgeAudio.src);
  }
  edgeAudio = null;
}

// ── Composable ────────────────────────────────────────────

export function useTTS(options: UseTTSOptions = {}) {
  const { onStart, onEnd, onError } = options;

  const isSpeaking = ref(false);
  const isSupported = true; // 总是可用（至少有 browser fallback）

  const callbacks = {
    onStart: () => { isSpeaking.value = true; onStart?.(); },
    onEnd: () => { isSpeaking.value = false; onEnd?.(); },
    onError: (err: string) => { isSpeaking.value = false; onError?.(err); },
  };

  /**
   * 播放文本
   * @param text  要朗读的文本
   * @param config  TTS 配置（provider/voice/rate/lang）
   */
  function speak(text: string, config: TTSConfig): void {
    // 先停止当前播放
    stop();

    if (config.provider === 'edge') {
      // Edge-TTS 是异步的，但 speak 接口保持同步（fire-and-forget）
      void speakWithEdge(text, config, callbacks);
    } else {
      speakWithBrowser(text, config, callbacks);
    }
  }

  /**
   * 停止播放
   */
  function stop(): void {
    stopBrowser();
    stopEdge();
    isSpeaking.value = false;
  }

  // 组件卸载时自动清理
  onBeforeUnmount(() => {
    stop();
  });

  return {
    isSupported,
    isSpeaking,
    speak,
    stop,
  };
}

export type UseTTSReturn = ReturnType<typeof useTTS>;
