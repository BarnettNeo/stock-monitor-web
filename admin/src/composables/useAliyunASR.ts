/**
 * useAliyunASR — 阿里云 NLS WebSocket 流式语音识别 Composables
 *
 * 与 useASR (浏览器 Web Speech API) 保持相同的接口签名，
 * 上层调用方通过 createASR() 根据 asrProvider 分发。
 */
import { ref } from 'vue';
import { api } from '../api';

export interface ASRResult {
  transcript: string;
  isFinal: boolean;
  confidence?: number;
}

interface AliyunAsrConfig {
  region: string;
  appkey: string;
  gatewayUrl: string;
  sampleRate: number;
  maxSentenceSilence: number;
  enableIntermediateResult: boolean;
  enablePunctuationPrediction: boolean;
  enableInverseTextNormalization: boolean;
}

interface UseAliyunASROptions {
  onResult?: (result: ASRResult) => void;
  onError?: (error: string) => void;
  onStart?: () => void;
  onEnd?: () => void;
}

// ── 工具函数 ─────────────────────────────────────────────────

function mergeTranscript(existing: string, nextText: string): string {
  const base = existing.trim();
  const addition = nextText.trim();
  if (!addition) return base;
  if (!base) return addition;
  if (/[。！？.!?；;，,]$/.test(base)) return `${base}${addition}`;
  return `${base} ${addition}`;
}

function createAliyunPcmChunk(
  input: Float32Array,
  inputSampleRate: number,
  outputSampleRate: number,
): ArrayBuffer {
  let source: Float32Array = input;

  // 重采样
  if (inputSampleRate !== outputSampleRate && input.length > 0) {
    const ratio = inputSampleRate / outputSampleRate;
    const newLength = Math.max(1, Math.round(input.length / ratio));
    const resampled = new Float32Array(newLength);
    let offset = 0;
    for (let i = 0; i < newLength; i += 1) {
      const start = Math.floor(i * ratio);
      const end = Math.floor((i + 1) * ratio);
      let sum = 0;
      let count = 0;
      for (let j = start; j < end && j < input.length; j += 1) {
        sum += input[j];
        count += 1;
      }
      resampled[offset] = count ? sum / count : input[start] || 0;
      offset += 1;
    }
    source = resampled;
  }

  // Float32 → PCM S16LE
  const buffer = new ArrayBuffer(source.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < source.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, source[i] || 0));
    view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return buffer;
}

function extractAliyunTranscript(payload: any): string {
  const candidates = [
    payload?.result,
    payload?.text,
    payload?.transcript,
    payload?.content,
    payload?.data?.result,
    payload?.data?.text,
    payload?.data?.transcript,
    payload?.payload?.result,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      const value = candidate.trim();
      try {
        const parsed = JSON.parse(value);
        const nested = extractAliyunTranscript(parsed);
        if (nested) return nested;
      } catch {
        return value;
      }
    }
  }

  if (payload && typeof payload === 'object') {
    for (const value of Object.values(payload)) {
      if (typeof value === 'string' && value.trim()) {
        const text = value.trim();
        if (text.length > 1 && /^[\[{]/.test(text)) {
          try {
            const parsed = JSON.parse(text);
            const nested = extractAliyunTranscript(parsed);
            if (nested) return nested;
          } catch {
            // not JSON, skip
          }
        }
      }
      if (Array.isArray(value)) {
        const nestedArray = value
          .map((item: any) => extractAliyunTranscript(item))
          .filter(Boolean)
          .join('');
        if (nestedArray) return nestedArray;
      }
      if (value && typeof value === 'object') {
        const nested = extractAliyunTranscript(value);
        if (nested) return nested;
      }
    }
  }

  return '';
}

// ── Composable ───────────────────────────────────────────────

export function useAliyunASR(options: UseAliyunASROptions = {}) {
  const { onResult, onError, onStart, onEnd } = options;

  const isListening = ref(false);

  let config: AliyunAsrConfig | null = null;
  let socket: WebSocket | null = null;
  let audioContext: AudioContext | null = null;
  let inputStream: MediaStream | null = null;
  let sourceNode: MediaStreamAudioSourceNode | null = null;
  let workletNode: AudioWorkletNode | null = null;
  let gainNode: GainNode | null = null;
  let sessionId = '';
  let committedText = '';
  let interimText = '';
  let finalized = false;
  let stopTimer: number | null = null;

  // ── 私有方法 ─────────────────────────────────────────────

  async function loadConfig(): Promise<AliyunAsrConfig | null> {
    try {
      const res = await api.get('/voice/asr/aliyun/config');
      const c = res.data?.config;
      if (!c) return null;
      return {
        region: String(c.region || 'cn-shanghai'),
        appkey: String(c.appkey || ''),
        gatewayUrl: String(c.gatewayUrl || ''),
        sampleRate: Number(c.sampleRate || 16000),
        maxSentenceSilence: Number(c.maxSentenceSilence || 800),
        enableIntermediateResult: Boolean(c.enableIntermediateResult),
        enablePunctuationPrediction: Boolean(c.enablePunctuationPrediction),
        enableInverseTextNormalization: Boolean(c.enableInverseTextNormalization),
      };
    } catch {
      return null;
    }
  }

  function stopTransport(): void {
    try {
      workletNode?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      sourceNode?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      gainNode?.disconnect();
    } catch {
      /* ignore */
    }
    workletNode = null;
    sourceNode = null;
    gainNode = null;

    inputStream?.getTracks().forEach((t) => t.stop());
    inputStream = null;

    try {
      socket?.close();
    } catch {
      /* ignore */
    }
    socket = null;

    try {
      audioContext?.close();
    } catch {
      /* ignore */
    }
    audioContext = null;
  }

  function finalizeSession(): void {
    if (finalized) return;
    finalized = true;
    // committedText 已在每句 SentenceEnd 时通过 onResult(isFinal=true) 报告给 UI，
    // 此处不再重复发送。只发送尚未被 SentenceEnd 收尾的 interimText（如果有）。
    const text = committedText.trim() ? '' : interimText.trim();
    stopTransport();
    isListening.value = false;
    if (text) {
      onResult?.({ transcript: text, isFinal: true });
    }
    // 任何时候会话结束都应调用 onEnd 以复位 UI 状态
    onEnd?.();
  }

  function finalizeLater(delayMs = 600): void {
    if (stopTimer !== null) {
      window.clearTimeout(stopTimer);
    }
    stopTimer = window.setTimeout(() => {
      finalizeSession();
    }, delayMs);
  }

  // ── 公共 API ─────────────────────────────────────────────

  async function start(): Promise<void> {
    if (isListening.value) return;
    finalized = false;
    committedText = '';
    interimText = '';

    onStart?.();

    if (!config) {
      config = await loadConfig();
    }
    if (!config || !config.appkey) {
      onError?.(
        '阿里云 NLS 未配置，请先填写环境变量 ALIYUN_NLS_ACCESS_KEY_ID / ALIYUN_NLS_ACCESS_KEY_SECRET / ALIYUN_NLS_APPKEY',
      );
      isListening.value = false;
      return;
    }

    try {
      // 1) 获取临时 Token
      const tokenRes = await api.get('/voice/asr/aliyun/token');
      const token = String(tokenRes.data?.token || '').trim();
      if (!token) throw new Error('无法获取阿里云 NLS Token');

      // 阿里云 NLS 要求 message_id / task_id 为 32 位紧凑 hex 字符串（不带横杠）
      const aliyunId = (): string => {
        if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
          return crypto.randomUUID().replace(/-/g, '');
        }
        return `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`.padEnd(32, '0');
      };
      sessionId = aliyunId();

      // 2) 创建 AudioContext + 麦克风流
      audioContext = new AudioContext({ sampleRate: config.sampleRate });
      await audioContext.resume();
      inputStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      sourceNode = audioContext.createMediaStreamSource(inputStream);
      gainNode = audioContext.createGain();
      gainNode.gain.value = 0;

      // 3) 注册 AudioWorklet（替代已弃用的 ScriptProcessorNode）
      await audioContext.audioWorklet.addModule('/aliyun-asr-worklet.js');
      workletNode = new AudioWorkletNode(audioContext, 'aliyun-asr-processor');

      // 4) 建立 WebSocket 连接
      const url = new URL(config.gatewayUrl);
      url.searchParams.set('token', token);
      socket = new WebSocket(url.toString());
      socket.binaryType = 'arraybuffer';

      // 5) 音频管线
      sourceNode.connect(workletNode);
      workletNode.connect(gainNode);
      gainNode.connect(audioContext.destination);

      workletNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
        if (!socket || socket.readyState !== WebSocket.OPEN) return;
        const pcm = createAliyunPcmChunk(
          event.data,
          audioContext!.sampleRate,
          config!.sampleRate,
        );
        socket.send(pcm);
      };

      // 6) WebSocket 事件
      socket.onopen = () => {
        const startMsg = {
          header: {
            message_id: crypto.randomUUID().replace(/-/g, ''),
            appkey: config!.appkey,
            namespace: 'SpeechTranscriber',
            name: 'StartTranscription',
            task_id: sessionId,
            status: 20000000,
          },
          payload: {
            format: 'pcm',
            sample_rate: config!.sampleRate,
            enable_intermediate_result: config!.enableIntermediateResult,
            enable_punctuation_prediction: config!.enablePunctuationPrediction,
            enable_inverse_text_normalization: config!.enableInverseTextNormalization,
            max_sentence_silence: config!.maxSentenceSilence,
          },
        };
        socket?.send(JSON.stringify(startMsg));
        isListening.value = true;
      };

      socket.onmessage = (event: MessageEvent<string>) => {
        let data: any = event.data;
        if (typeof data === 'string') {
          try {
            data = JSON.parse(data);
          } catch {
            return;
          }
        }
        const headerName = String(data?.header?.name || data?.name || '');
        const transcript = extractAliyunTranscript(data);
        if (!transcript) return;

        if (headerName === 'SentenceEnd') {
          committedText = mergeTranscript(committedText, transcript);
          interimText = '';
          onResult?.({ transcript, isFinal: true });
        } else if (
          headerName === 'TranscriptionResultChanged' ||
          headerName === 'TranscriptionResultChangedEvent'
        ) {
          interimText = transcript;
          onResult?.({ transcript, isFinal: false });
        } else {
          interimText = transcript;
          onResult?.({ transcript, isFinal: false });
        }
      };

      socket.onerror = () => {
        onError?.('阿里云实时识别连接异常');
        isListening.value = false;
        finalizeLater(0);
      };

      socket.onclose = () => {
        finalizeLater(0);
      };
    } catch (err: any) {
      stopTransport();
      isListening.value = false;
      onError?.(err?.message || '阿里云语音识别启动失败');
    }
  }

  function stop(): void {
    if (!isListening.value && !socket) return;

    // 发送 StopTranscription 指令
    if (socket && socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(
          JSON.stringify({
            header: {
              message_id: crypto.randomUUID().replace(/-/g, ''),
              appkey: config?.appkey || '',
              namespace: 'SpeechTranscriber',
              name: 'StopTranscription',
              task_id: sessionId,
              status: 20000000,
            },
            payload: {},
          }),
        );
      } catch {
        /* ignore */
      }
    }

    stopTransport();
    finalizeLater(300);
  }

  function abort(): void {
    if (stopTimer !== null) {
      window.clearTimeout(stopTimer);
      stopTimer = null;
    }
    stopTransport();
    committedText = '';
    interimText = '';
    isListening.value = false;
  }

  return {
    isListening,
    start,
    stop,
    abort,
  };
}

export type UseAliyunASRReturn = ReturnType<typeof useAliyunASR>;
