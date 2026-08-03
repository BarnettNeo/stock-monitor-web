<template>
  <teleport to="body">
    <div class="agent-float-root">
      <!-- 悬浮按钮 -->
      <div v-if="!open" class="agent-float-btn" @click="open = true">
        <el-icon size="20"><ChatDotRound /></el-icon>
        <span class="agent-float-btn-text">AI 助手</span>
      </div>

      <!-- 悬浮窗口 -->
      <div v-else class="agent-float-panel">
        <div class="agent-float-header">
          <div class="agent-float-title">
            <el-icon><ChatLineRound /></el-icon>
            <span>AI 助手</span>
          </div>
          <div class="agent-float-actions">
            <!-- 语音配置按钮 + 浮窗 -->
            <el-popover
              placement="bottom-end"
              :width="240"
              trigger="click"
              popper-class="agent-float-voice-popover"
            >
              <template #reference>
                <el-button size="small" class="agent-float-voice-btn">
                  <el-icon><Setting /></el-icon>
                  <span>语音配置</span>
                </el-button>
              </template>
              <div class="voice-config-content">
                <div class="voice-config-item">
                  <label class="voice-config-label">ASR 服务</label>
                  <el-select
                    v-model="asrProvider"
                    size="small"
                    class="voice-config-select"
                    placeholder="ASR 服务"
                    @change="onAsrProviderChange"
                  >
                    <el-option label="浏览器内置" value="browser" />
                    <el-option label="阿里云 NLS" value="aliyun" :disabled="!aliyunAsrEnabled" />
                  </el-select>
                </div>
                <div class="voice-config-item">
                  <label class="voice-config-label">ASR 语言</label>
                  <el-select
                    v-model="asrLanguage"
                    size="small"
                    class="voice-config-select"
                    placeholder="语言"
                  >
                    <el-option label="中文" value="zh-CN" />
                    <el-option label="英文" value="en-US" />
                  </el-select>
                </div>
                <div class="voice-config-divider" />
                <div class="voice-config-item">
                  <label class="voice-config-label">🔊 TTS 服务</label>
                  <el-select
                    v-model="ttsConfig.provider"
                    size="small"
                    class="voice-config-select"
                    @change="ttsConfigManager.update('provider', ttsConfig.provider)"
                  >
                    <el-option label="浏览器内置" value="browser" />
                    <el-option label="Edge-TTS（高质量）" value="edge" />
                  </el-select>
                </div>
                <div class="voice-config-item">
                  <label class="voice-config-label">合成语言</label>
                  <el-select
                    v-model="ttsConfig.lang"
                    size="small"
                    class="voice-config-select"
                    @change="ttsConfigManager.update('lang', ttsConfig.lang)"
                  >
                    <el-option label="中文" value="zh-CN" />
                    <el-option label="英文" value="en-US" />
                  </el-select>
                </div>
                <div class="voice-config-item">
                  <label class="voice-config-label">播报音色</label>
                  <el-select
                    v-model="ttsConfig.voice"
                    size="small"
                    class="voice-config-select"
                    @change="ttsConfigManager.update('voice', ttsConfig.voice)"
                  >
                    <el-option
                      v-for="v in ttsConfigManager.currentVoices()"
                      :key="v.value"
                      :label="v.label"
                      :value="v.value"
                    />
                  </el-select>
                </div>
                <div class="voice-config-item">
                  <label class="voice-config-label">语速</label>
                  <div class="voice-config-slider-row">
                    <span class="voice-config-slider-label">慢</span>
                    <el-slider
                      :model-value="ttsConfigManager.rateValue()"
                      :min="-50"
                      :max="100"
                      :step="10"
                      class="voice-config-slider"
                      @change="handleTTSRateChange"
                    />
                    <span class="voice-config-slider-label">快</span>
                  </div>
                </div>
                <div class="voice-config-divider" />
                <div class="voice-config-item">
                  <label class="voice-config-label">🧪 测试播报</label>
                  <div class="voice-config-test-row">
                    <el-input
                      v-model="ttsTestText"
                      size="small"
                      placeholder="输入测试文本"
                      class="voice-config-test-input"
                    />
                    <el-button
                      size="small"
                      type="primary"
                      :disabled="!ttsTestText.trim() || tts.isSpeaking.value"
                      @click="handleTestTTS"
                    >
                      {{ tts.isSpeaking.value ? '播报中...' : '试听' }}
                    </el-button>
                    <el-button
                      v-if="tts.isSpeaking.value"
                      size="small"
                      type="danger"
                      plain
                      @click="tts.stop()"
                    >
                      停止
                    </el-button>
                  </div>
                </div>
              </div>
            </el-popover>
            <el-select
              v-model="model"
              size="small"
              filterable
              allow-create
              default-first-option
              class="agent-float-model"
              popper-class="agent-float-model-popper"
              placeholder="LLM 模型"
            >
              <el-option v-for="m in modelOptions" :key="m" :label="m" :value="m" />
            </el-select>
            <el-button size="small" @click="clearMessages">清空</el-button>
            <el-button size="small" type="primary" plain @click="open = false">收起</el-button>
          </div>
        </div>

        <div ref="listEl" class="agent-float-body">
          <div v-if="messages.length === 0 && !isListening" class="agent-float-empty">
            你可以试试：<span class="agent-float-hint">"列出策略"</span> 或 <span class="agent-float-hint">"新增策略，监控 sh600519，阈值 2%"</span>
          </div>

          <div v-for="(m, idx) in viewMessages" :key="idx" class="agent-msg" :class="m.role">
            <!-- <div class="agent-msg-role">{{ m.roleLabel }}</div> -->
            <div class="agent-msg-content" :class="{ 'is-streaming': m.streaming }">
              {{ m.content }}<span v-if="m.streaming" class="streaming-cursor" />
            </div>
            <!-- AI 回复播放按钮 -->
            <button
              v-if="m.role === 'assistant'"
              class="msg-tts-btn"
              :class="{ active: playingMsgIdx === idx }"
              :title="playingMsgIdx === idx ? '停止播放' : '播放语音'"
              @click="handlePlayMessage(m.content, idx)"
            >
              <el-icon :size="14">
                <VideoPause v-if="playingMsgIdx === idx" />
                <VideoPlay v-else />
              </el-icon>
            </button>
          </div>

          <!-- 识别中间结果气泡 -->
          <div v-if="isListening && (recognizedText || interimText)" class="agent-msg user">
            <!-- <div class="agent-msg-role">我</div> -->
            <div class="agent-msg-content interim-bubble">
              <span class="final-text">{{ recognizedText }}</span>
              <span v-if="interimText" class="interim-text"> {{ interimText }}</span>
              <span class="interim-cursor" />
            </div>
          </div>

          <div v-if="sending" class="agent-msg assistant">
            <div class="agent-msg-content sending-bubble">
              <span class="dot-typing" />
              <span class="dot-typing dot-typing-2" />
              <span class="dot-typing dot-typing-3" />
            </div>
          </div>
        </div>

        <!-- 语音状态栏 -->
        <div v-if="stateLabel" class="voice-status-bar">
          <span class="voice-status-label">{{ stateLabel }}</span>
          <button
            v-if="voiceState === 'speaking'"
            class="voice-status-btn"
            @click="handleStopSpeaking"
          >
            停止
          </button>
          <button
            v-if="isListening"
            class="voice-status-btn cancel-btn"
            @click="handleCancelRecording"
          >
            取消
          </button>
        </div>

        <div class="agent-float-footer">
          <!-- 录音波形动画 -->
          <div v-if="isListening" class="waveform-container">
            <VoiceWaveformAnimation :active="true" :volume="volume" />
          </div>

          <el-input
            ref="inputRef"
            v-model="draft"
            type="textarea"
            :autosize="{ minRows: 2, maxRows: 4 }"
            :placeholder="inputPlaceholder"
            @keydown.enter.exact.prevent="send"
            @keydown.space.prevent="handleInputSpaceDown"
            @keyup.space.prevent="handleInputSpaceUp"
          />
          <div class="agent-float-footer-actions">
            <!-- 麦克风按钮（放在发送按钮左边） -->
            <VoiceMicButton
              :voice-state="voiceState"
              trigger-mode="click"
              :disabled="sending || voiceState === 'responding'"
              @activate="handleActivateMic"
              @deactivate="handleDeactivateMic"
            />
            <el-button :disabled="sending || !draft.trim()" type="primary" @click="send">发送</el-button>
          </div>
        </div>
      </div>

      <!-- 权限引导弹窗 -->
      <VoicePermissionModal
        v-if="showPermissionModal"
        @close="showPermissionModal = false"
        @retry="handleRetryPermission"
      />
    </div>
  </teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { ChatDotRound, ChatLineRound, Setting, VideoPlay, VideoPause } from '@element-plus/icons-vue';
import { api, getAuthToken } from '../api';
import { useASR } from '../composables/useASR';
import { useAliyunASR } from '../composables/useAliyunASR';
import { useTTS } from '../composables/useTTS';
import { useTTSConfig } from '../composables/useTTSConfig';
import { useVAD } from '../composables/useVAD';
import VoiceMicButton from './VoiceMicButton.vue';
import VoiceWaveformAnimation from './VoiceWaveformAnimation.vue';
import VoicePermissionModal from './VoicePermissionModal.vue';

type MsgRole = 'user' | 'assistant' | 'system';
type Msg = { role: MsgRole; content: string; ts: number; streaming?: boolean };
type VoiceState = 'idle' | 'requesting' | 'listening' | 'recording' | 'processing' | 'responding' | 'speaking' | 'error';

const STORAGE_MODEL_KEY = 'agent_llm_model';

const open = ref(false);

const draft = ref('');
const sending = ref(false);
const messages = ref<Msg[]>([]);

const modelOptions = ref<string[]>(['qwen3.6-flash', 'qwen3.7-plus', 'deepseek-v4-flash']);
const model = ref<string>('qwen3.6-flash');

const listEl = ref<HTMLElement | null>(null);

// ── ASR 配置 ──────────────────────────────────────────────
const asrProvider = ref<'browser' | 'aliyun'>('browser');
const asrLanguage = ref('zh-CN');
const aliyunAsrEnabled = ref(false);

// ── 语音状态 ──────────────────────────────────────────────
const voiceState = ref<VoiceState>('idle');
const volume = ref(0);
const interimText = ref('');
const recognizedText = ref('');
const showPermissionModal = ref(false);

// ── TTS 配置 ──────────────────────────────────────────────
const ttsConfigManager = useTTSConfig();
const ttsConfig = ttsConfigManager.config;

function handleTTSRateChange(v: number): void {
  ttsConfigManager.setRate(v);
}

const ttsTestText = ref(ttsConfig.value.lang === 'en-US'
  ? 'Hello! This is a test of the text-to-speech engine.'
  : '你好！这是语音合成引擎的测试。祝你投资顺利，收益长虹。');

function handleTestTTS(): void {
  const text = ttsTestText.value.trim();
  if (!text) return;
  tts.speak(text, ttsConfig.value);
}

// ── 消息 TTS 播放 ──────────────────────────────────────────
const playingMsgIdx = ref(-1);

function handlePlayMessage(content: string, idx: number): void {
  // 点击正在播放的消息 → 停止
  if (playingMsgIdx.value === idx) {
    tts.stop();
    playingMsgIdx.value = -1;
    return;
  }
  if (!content.trim()) return;
  playingMsgIdx.value = idx;
  tts.speak(content, ttsConfig.value);
}

// 保存最终识别的文本，用于取消/重录
const transcriptBuffer = ref('');
// 记录当前输入是否来自语音，用于 LLM 回复后自动保存录音记录
const lastVoiceInput = ref(false);

const isListening = computed(() => voiceState.value === 'listening' || voiceState.value === 'recording');
const inputPlaceholder = computed(() => {
  if (isListening.value) return '正在聆听... 或直接在此输入文字';
  return '输入内容，回车发送（Shift+Enter 换行）';
});

// ── TTS 语音合成 ──────────────────────────────────────────
const tts = useTTS({
  onStart: () => {
    voiceState.value = 'speaking';
  },
  onEnd: () => {
    voiceState.value = 'idle';
  },
  onError: (err) => {
    ElMessage.warning(err);
    voiceState.value = 'idle';
  },
});

// TTS 结束时清除播放标记
watch(() => tts.isSpeaking.value, (speaking) => {
  if (!speaking) playingMsgIdx.value = -1;
});

// ── ASR 语音识别 ──────────────────────────────────────────
// 每次启动时重新创建 ASR 实例以应用最新配置
function createASR() {
  const callbacks = {
    onResult: (result: { transcript: string; isFinal: boolean }) => {
      console.log('语音识别', result);
      if (result.isFinal) {
        transcriptBuffer.value += result.transcript;
        // recognizedText.value = transcriptBuffer.value;
        interimText.value = '';
        // 同时填入输入框方便编辑
        draft.value = transcriptBuffer.value;
      } else {
        interimText.value = result.transcript;
      }
    },
    onError: (err: string) => {
      if (err.includes('权限') || err.includes('not-allowed') || err.includes('denied')) {
        showPermissionModal.value = true;
      } else {
        ElMessage.warning(err);
      }
      voiceState.value = 'idle';
    },
    onStart: () => {
      voiceState.value = 'listening';
      transcriptBuffer.value = '';
      recognizedText.value = '';
      interimText.value = '';
    },
    onEnd: () => {
      if (voiceState.value === 'listening') {
        voiceState.value = 'idle';
      }
    },
  };

  if (asrProvider.value === 'aliyun') {
    return useAliyunASR(callbacks);
  }

  return useASR({ ...callbacks, language: asrLanguage.value });
}

let asr = createASR();

// ── VAD 声音活动检测 ──────────────────────────────────────
const vad = useVAD(
  {
    onSpeechStart: () => {
      // 有声音时清除静音定时器
    },
    onSpeechEnd: () => {
      // 静音一段时间，识别结果填入输入框
      if (transcriptBuffer.value.trim() || interimText.value.trim()) {
        const text = transcriptBuffer.value || interimText.value;
        if (text.trim()) {
          asr.stop();
          vad.stop();
          fillInputWithText(text.trim());
        }
      }
    },
    onVolumeChange: (vol) => {
      volume.value = vol;
    },
  },
  { noiseFloor: 0.01, silenceThreshold: 1500 },
);

// ── 激活麦克风 ───────────────────────────────────────────
async function handleActivateMic(): Promise<void> {
  // 如果 TTS 正在播报，先停止播报
  if (voiceState.value === 'speaking') {
    tts.stop();
    voiceState.value = 'idle';
  }

  if (voiceState.value === 'listening') {
    // 点击停止录音
    stopRecordingAndSubmit();
    return;
  }

  if (voiceState.value !== 'idle' && voiceState.value !== 'error') return;

  voiceState.value = 'requesting';
  transcriptBuffer.value = '';
  recognizedText.value = '';
  interimText.value = '';
  draft.value = '';

  // 检查麦克风权限
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  } catch {
    showPermissionModal.value = true;
    voiceState.value = 'idle';
    return;
  }

  // 启动 VAD（可选，提供音量检测和自动静音提交）
  try {
    await vad.start();
  } catch {
    // VAD 非核心功能，失败不影响 ASR
    console.warn('[VAD] start failed, continuing without VAD');
  }

  // 启动 ASR
  asr.start();
}

function handleDeactivateMic(): void {
  stopRecordingAndSubmit();
}

function stopRecordingAndSubmit(): void {
  asr.stop();
  vad.stop();
  const text = transcriptBuffer.value || interimText.value;
  if (text.trim()) {
    fillInputWithText(text.trim());
  } else {
    voiceState.value = 'idle';
  }
}

/** 将语音识别结果填入输入框，不自动发送 */
function fillInputWithText(text: string): void {
  if (!text.trim()) return;
  voiceState.value = 'idle';
  draft.value = text.trim();
  lastVoiceInput.value = true;
}

// ── ASR 提供商加载 ────────────────────────────────────
async function onAsrProviderChange(): Promise<void> {
  if (asrProvider.value === 'aliyun') {
    try {
      const res = await api.get('/voice/asr/aliyun/config');
      if (res.data?.config) {
        aliyunAsrEnabled.value = true;
        ElMessage.success('阿里云 ASR 已就绪');
      }
    } catch {
      aliyunAsrEnabled.value = false;
      ElMessage.warning('阿里云 ASR 未配置（需设置 ALIYUN_NLS_ACCESS_KEY_ID/KEY_SECRET/APPKEY），已切回浏览器 ASR');
      asrProvider.value = 'browser';
    }
  }
  // 重新创建 ASR 实例以应用新配置
  asr.abort();
  asr = createASR();
}

async function loadVoiceProviders(): Promise<void> {
  try {
    const res = await api.get('/voice/asr/providers');
    const data = res.data || {};
    const providers = Array.isArray(data.providers) ? data.providers : [];
    const aliyunItem = providers.find((p: any) => p.id === 'aliyun');
    aliyunAsrEnabled.value = Boolean(aliyunItem?.enabled);
    if (data.defaultProvider === 'aliyun' && aliyunAsrEnabled.value) {
      asrProvider.value = 'aliyun';
    }
  } catch {
    // 语音服务未配置，默认使用浏览器 ASR
  }
}

// ── 录音上传与保存 ────────────────────────────────────
let mediaRecorderForSave: MediaRecorder | null = null;
let recordingChunksForSave: BlobPart[] = [];
let recordingStreamForSave: MediaStream | null = null;

async function startVoiceRecordingForSave(): Promise<void> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordingStreamForSave = stream;
    recordingChunksForSave = [];
    const mimeType = 'audio/webm;codecs=opus';
    mediaRecorderForSave = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported(mimeType) ? mimeType : 'audio/webm' });
    mediaRecorderForSave.ondataavailable = (event: BlobEvent) => {
      if (event.data && event.data.size > 0) {
        recordingChunksForSave.push(event.data);
      }
    };
    mediaRecorderForSave.start();
  } catch {
    // 静默失败，录音保存为非核心功能
  }
}

async function stopRecordingAndSaveToServer(userText: string, llmReply: string): Promise<void> {
  if (!mediaRecorderForSave || mediaRecorderForSave.state === 'inactive') {
    mediaRecorderForSave = null;
    recordingStreamForSave = null;
    return;
  }

  return new Promise<void>((resolve) => {
    const recorder = mediaRecorderForSave!;
    const stream = recordingStreamForSave;

    recorder.onstop = async () => {
      const blob = new Blob(recordingChunksForSave, { type: 'audio/webm' });
      recordingChunksForSave = [];
      recordingStreamForSave = null;
      mediaRecorderForSave = null;
      stream?.getTracks().forEach((t) => t.stop());

      try {
        const fileName = `voice-${Date.now()}-${crypto.randomUUID?.()?.slice(0,8) || Math.random().toString(36).slice(2,10)}.webm`;
        await api.post('/voice/recordings', blob, {
          headers: {
            'Content-Type': 'audio/webm',
            'X-Voice-Duration-Ms': String(0),
            'X-Voice-File-Name': encodeURIComponent(fileName),
            'X-Voice-Source': 'agent-chat',
            'X-Voice-Transcript': encodeURIComponent(userText),
            'X-Voice-Llm-Reply': encodeURIComponent(llmReply),
          },
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
        });
      } catch {
        // 静默失败
      }
      resolve();
    };

    recorder.stop();
  });
}

/** 取消录音（丢弃结果） */
function handleCancelRecording(): void {
  asr.abort();
  vad.stop();
  transcriptBuffer.value = '';
  recognizedText.value = '';
  interimText.value = '';
  draft.value = '';
  voiceState.value = 'idle';
}

/** 重新授权麦克风 */
function handleRetryPermission(): void {
  showPermissionModal.value = false;
  setTimeout(() => handleActivateMic(), 100);
}

/** 停止 TTS 朗读 */
function handleStopSpeaking(): void {
  tts.stop();
  voiceState.value = 'idle';
}

// ── 空格键触发（仅在非输入框焦点时） ────────────────────
function handleInputSpaceDown(e: KeyboardEvent): void {
  // 如果焦点在输入框且有文本输入，不拦截
  const target = e.target as HTMLElement;
  if (target?.tagName === 'TEXTAREA' || target?.tagName === 'INPUT') return;
  if (e.repeat) return;
  e.preventDefault();
  if (voiceState.value === 'idle' || voiceState.value === 'error') {
    handleActivateMic();
  }
}

function handleInputSpaceUp(e: KeyboardEvent): void {
  const target = e.target as HTMLElement;
  if (target?.tagName === 'TEXTAREA' || target?.tagName === 'INPUT') return;
  if (e.repeat) return;
  e.preventDefault();
  if (isListening.value) {
    handleDeactivateMic();
  }
}

// ── 全局空格键监听（用于非输入框场景） ──────────────────
function globalKeyDown(e: KeyboardEvent): void {
  if (e.code === 'Space' && !e.repeat) {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    // 检查是否在悬浮窗内
    const root = (e.target as HTMLElement)?.closest('.agent-float-root');
    if (!root) return;
    e.preventDefault();
    if (voiceState.value === 'idle' || voiceState.value === 'error') {
      handleActivateMic();
    }
  }
}

function globalKeyUp(e: KeyboardEvent): void {
  if (e.code === 'Space') {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const root = (e.target as HTMLElement)?.closest('.agent-float-root');
    if (!root) return;
    e.preventDefault();
    if (isListening.value) {
      handleDeactivateMic();
    }
  }
}

// ── 语音状态标签 ────────────────────────────────────────
const stateLabel = computed(() => {
  switch (voiceState.value) {
    case 'listening':
    case 'recording':
      return '🎤 正在聆听... 说话结束后等待识别';
    case 'processing':
      return '⚡ 语音识别中...';
    case 'responding':
      return '🤖 AI 思考中...';
    case 'speaking':
      return '🔊 AI 播报中...';
    case 'requesting':
      return '🔐 请求麦克风权限...';
    case 'error':
      return '❌ 出现错误，请重试';
    default:
      return '';
  }
});

// ── 消息列表 ─────────────────────────────────────────────
const viewMessages = computed(() => {
  return messages.value.map((m) => ({
    ...m,
    roleLabel: m.role === 'user' ? '我' : m.role === 'assistant' ? 'AI' : '系统',
    streaming: m.streaming ?? false,
  }));
});

function scrollToBottom(): void {
  nextTick(() => {
    const el = listEl.value;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  });
}

function clearMessages(): void {
  messages.value = [];
}

function loadModelFromStorage(): void {
  try {
    const m = localStorage.getItem(STORAGE_MODEL_KEY);
    if (m && m.trim()) {
      model.value = m.trim();
      if (!modelOptions.value.includes(model.value)) {
        modelOptions.value = [model.value, ...modelOptions.value];
      }
    }
  } catch {
    // ignore
  }
}

function saveModelToStorage(): void {
  try {
    localStorage.setItem(STORAGE_MODEL_KEY, model.value);
  } catch {
    // ignore
  }
}

// 发送消息（支持 SSE 流式输出）
async function send(): Promise<void> {
  const text = draft.value.trim();
  if (!text || sending.value) return;

  draft.value = '';
  messages.value.push({ role: 'user', content: text, ts: Date.now() });
  scrollToBottom();
  sending.value = true;

  // 如果来自语音输入，开始录制音频用于后续保存
  const isVoiceInput = lastVoiceInput.value;
  lastVoiceInput.value = false;
  if (isVoiceInput && mediaRecorderForSave === null) {
    await startVoiceRecordingForSave().catch(() => {});
  }

  try {
    // 使用 fetch 读取 SSE 流（浏览器原生支持）
    const token = getAuthToken() || '';
    const apiBase = (api.defaults?.baseURL || '').replace(/\/+$/, '');
    const fetchRes = await fetch(`${apiBase}/agent/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ message: text, context: { model: model.value } }),
    });
    sending.value = false;
    const contentType = fetchRes.headers.get('content-type') || '';

    if (contentType.includes('text/event-stream') && fetchRes.body) {
      // SSE 流式响应：逐 token 显示（打字机效果）
      const msgIdx = messages.value.length;
      messages.value.push({ role: 'assistant', content: '', ts: Date.now(), streaming: true });

      const reader = fetchRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullReply = '';

      /** 强制 Vue 检测到数组元素的变更 */
      function updateAssistantContent(newContent: string): void {
        const arr = [...messages.value];
        arr[msgIdx] = { ...arr[msgIdx], content: newContent };
        messages.value = arr;
      }

      /** 安全结束流式状态：清除 streaming 标记 */
      function finalizeStream(): void {
        if (messages.value[msgIdx]?.streaming) {
          const arr = [...messages.value];
          arr[msgIdx] = { ...arr[msgIdx], streaming: false };
          messages.value = arr;
        }
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // 解析 SSE 行
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // 保留未完成的行

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const payload = JSON.parse(line.slice(6));
            if (payload.error) {
              // 后端错误事件
              const errMsg = payload.message || '请求出错';
              updateAssistantContent(fullReply || '');
              messages.value.push({ role: 'system', content: errMsg, ts: Date.now() });
              break;
            }
            if (payload.toolExecuting) {
              // 工具执行中（Node 正在调用后端工具）
              const toolNames = Array.isArray(payload.tools) ? payload.tools.join(', ') : '';
              messages.value.push({
                role: 'system',
                content: `⚙️ 正在执行工具：${toolNames || '...'}`,
                ts: Date.now(),
              });
              scrollToBottom();
              continue;
            }
            if (payload.token) {
              fullReply += payload.token;
              updateAssistantContent(fullReply);
              scrollToBottom();
            }
            if (payload.done) {
              fullReply = payload.reply || fullReply;
              // 流结束，移除 streaming 标记
              const arr = [...messages.value];
              arr[msgIdx] = { ...arr[msgIdx], content: fullReply || 'AI 未能生成回复，请重试。', streaming: false };
              messages.value = arr;
            }
          } catch { /* ignore parse errors */ }
        }
      }

      // 确保最终状态正确（移除 streaming 标记）
      finalizeStream();

      const reply = fullReply.trim();

      // 语音输入场景：自动播报 AI 回复
      if (reply && isVoiceInput && tts.isSupported) {
        tts.speak(reply, ttsConfig.value);
      }
      if (isVoiceInput && reply) {
        void stopRecordingAndSaveToServer(text, reply);
      }
    } else {
      // JSON 响应（兜底）
      const data: any = await fetchRes.json();
      const reply = String(data?.reply || '').trim();
      messages.value.push({ role: 'assistant', content: reply || 'AI 未能生成回复，请重试。', ts: Date.now() });

      if (reply && isVoiceInput && tts.isSupported) {
        tts.speak(reply, ttsConfig.value);
      }
      if (isVoiceInput && reply) {
        void stopRecordingAndSaveToServer(text, reply);
      }
    }
  } catch (e: any) {
    const data = e?.response?.data;
    const status = Number(e?.response?.status || 0);
    const msg = data?.message || e?.message || '发送失败';

    ElMessage.error(String(msg));

    const extra: string[] = [];

    // agents 服务不可用：给出可操作的提示
    if (String(msg).includes('agents 服务不可用')) {
      extra.push('可能原因：agents 服务未启动 / AGENTS_BASE_URL 配置错误 / 端口不通。');
      extra.push('你可以：先启动 Python agents 服务（确保 /health 正常），再重试。');
    }

    // Node 编排失败时可能携带 toolResults：把失败原因汇总给用户
    const toolResults = Array.isArray(data?.toolResults) ? data.toolResults : [];
    const failed = toolResults.filter((tr: any) => tr && tr.ok === false);
    if (failed.length > 0) {
      extra.push(`本次有 ${failed.length} 个工具执行失败：`);
      for (const tr of failed.slice(0, 3)) {
        extra.push(`- ${String(tr.name || '')}: ${String(tr.error || 'unknown error')}`);
      }
      if (failed.length > 3) extra.push('- ...');
    }

    const statusHint = status ? `（HTTP ${status}）` : '';
    const content = [`请求失败${statusHint}：${String(msg)}`, ...extra].join('\n');
    messages.value.push({ role: 'system', content, ts: Date.now() });
  } finally {
    sending.value = false;
    // 兜底：清除所有残留的 streaming 状态（防止流异常断开时蓝色光标不消失）
    const hasStreaming = messages.value.some((m) => m.streaming);
    if (hasStreaming) {
      messages.value = messages.value.map((m) => ({ ...m, streaming: false }));
    }
    scrollToBottom();
  }
}

onMounted(() => {
  loadModelFromStorage();
  loadVoiceProviders();
  document.addEventListener('keydown', globalKeyDown);
  document.addEventListener('keyup', globalKeyUp);
});

onBeforeUnmount(() => {
  document.removeEventListener('keydown', globalKeyDown);
  document.removeEventListener('keyup', globalKeyUp);
  asr.abort();
  vad.stop();
  // 清理录音资源
  mediaRecorderForSave?.stream?.getTracks().forEach((t) => t.stop());
  recordingStreamForSave?.getTracks().forEach((t) => t.stop());
  mediaRecorderForSave = null;
  recordingStreamForSave = null;
});

watch(
  () => model.value,
  () => {
    saveModelToStorage();
    if (model.value && !modelOptions.value.includes(model.value)) {
      modelOptions.value = [model.value, ...modelOptions.value];
    }
  },
);

// 新消息时自动滚动
watch(
  () => [messages.value.length, interimText.value, voiceState.value],
  () => scrollToBottom(),
);
</script>

<style scoped>
.agent-float-root {
  position: fixed;
  right: 16px;
  bottom: 16px;
  /* 保持悬浮窗在页面之上，同时不要盖住 Element Plus 的下拉弹层 */
  z-index: 1999;
}

/* el-select 的下拉框 Teleport 到 body，需要显式抬高 z-index 才不会被悬浮窗压住 */
::global(.agent-float-model-popper) {
  z-index: 4000 !important;
}

.agent-float-btn {
  width: 52px;
  height: 52px;
  border-radius: 999px;
  background: var(--el-color-primary);
  color: white;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  cursor: pointer;
  user-select: none;
}

.agent-float-btn-text {
  font-size: 12px;
  line-height: 12px;
}

.agent-float-panel {
  width: 800px;
  max-width: calc(100vw - 32px);
  height: 700px;
  max-height: calc(100vh - 32px);
  background: #fff;
  border: 1px solid var(--el-border-color-light);
  border-radius: 12px;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.18);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.agent-float-header {
  padding: 10px 12px;
  border-bottom: 1px solid var(--el-border-color-light);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.agent-float-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 700;
}

.agent-float-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.agent-float-model {
  width: 150px;
}

/* ── 语音配置按钮 ─────────────────────────────────── */
.agent-float-voice-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.voice-config-content {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.voice-config-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.voice-config-label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  font-weight: 500;
}

.voice-config-select {
  width: 100%;
}

.voice-config-divider {
  height: 1px;
  background: var(--el-border-color-lighter);
  margin: 4px 0;
}

.voice-config-slider-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.voice-config-slider-label {
  font-size: 11px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}

.voice-config-slider {
  flex: 1;
}

.voice-config-test-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.voice-config-test-input {
  flex: 1;
}

.agent-float-body {
  flex: 1;
  padding: 12px;
  overflow: auto;
  background: #fafafa;
}

.agent-float-empty {
  color: #6b7280;
  font-size: 13px;
  line-height: 20px;
  padding: 8px;
}

.agent-float-hint {
  color: var(--el-color-primary);
}

.agent-msg {
  margin-bottom: 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.agent-msg.user {
  align-items: flex-end;
}

.agent-msg-role {
  font-size: 12px;
  color: #6b7280;
}

.agent-msg-content {
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 13px;
  line-height: 20px;
  padding: 10px 10px;
  border-radius: 10px;
  border: 1px solid var(--el-border-color-lighter);
  background: white;
  max-width: 90%;
}

.agent-msg.user .agent-msg-content {
  border-color: rgba(64, 158, 255, 0.25);
  background: rgba(64, 158, 255, 0.08);
}

.agent-msg.system .agent-msg-content {
  border-color: rgba(245, 108, 108, 0.25);
  background: rgba(245, 108, 108, 0.06);
}

/* ── 发送等待动画（跳动圆点） ─────────────────────────── */
.sending-bubble {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 12px 16px !important;
  min-width: 60px;
}

.dot-typing {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--el-color-primary, #409eff);
  animation: dot-bounce 1.2s ease-in-out infinite;
}

.dot-typing-2 {
  animation-delay: 0.15s;
}

.dot-typing-3 {
  animation-delay: 0.3s;
}

@keyframes dot-bounce {
  0%, 60%, 100% {
    transform: translateY(0);
    opacity: 0.4;
  }
  30% {
    transform: translateY(-6px);
    opacity: 1;
  }
}

/* ── 流式打字机光标 ──────────────────────────────────── */
.streaming-cursor {
  display: inline-block;
  width: 6px;
  height: 15px;
  background: var(--el-color-primary, #409eff);
  margin-left: 2px;
  vertical-align: text-bottom;
  border-radius: 1px;
  animation: blink-streaming-cursor 0.6s step-end infinite;
}

@keyframes blink-streaming-cursor {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}

.is-streaming {
  border-color: var(--el-color-primary-light-5, rgba(64, 158, 255, 0.4)) !important;
}

/* ── 消息 TTS 播放按钮 ──────────────────────────────── */
.msg-tts-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: #a0aec0;
  cursor: pointer;
  padding: 0;
  margin-top: 2px;
  transition: all 0.15s ease;
  font-family: inherit;
}

.msg-tts-btn:hover {
  background: rgba(64, 158, 255, 0.1);
  color: var(--el-color-primary, #409eff);
}

.msg-tts-btn.active {
  color: var(--el-color-primary, #409eff);
  background: rgba(64, 158, 255, 0.12);
  animation: pulse-ring 1.2s ease-in-out infinite;
}

@keyframes pulse-ring {
  0%, 100% { box-shadow: 0 0 0 0 rgba(64, 158, 255, 0.3); }
  50% { box-shadow: 0 0 0 4px rgba(64, 158, 255, 0); }
}

/* ── 中间结果气泡样式 ──────────────────────────────── */
.interim-text {
  color: #a0aec0;
  font-style: italic;
}

.final-text {
  color: #2d3748;
  font-weight: 500;
}

.interim-cursor {
  display: inline-block;
  width: 2px;
  height: 16px;
  background: var(--el-color-primary, #409eff);
  margin-left: 2px;
  vertical-align: middle;
  animation: blink-cursor 0.8s step-end infinite;
}

@keyframes blink-cursor {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}

/* ── 语音状态栏 ───────────────────────────────────── */
.voice-status-bar {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 6px 12px;
  background: #f9fafb;
  border-top: 1px solid var(--el-border-color-lighter);
}

.voice-status-label {
  font-size: 12px;
  color: #6b7280;
}

.voice-status-btn {
  font-size: 11px;
  border: none;
  background: white;
  color: var(--el-color-primary, #409eff);
  padding: 2px 10px;
  border-radius: 12px;
  cursor: pointer;
  border: 1px solid var(--el-border-color-lighter);
  transition: all 0.15s ease;
  font-family: inherit;
}

.voice-status-btn:hover {
  background: var(--el-color-primary-light-9);
  border-color: var(--el-color-primary);
}

.cancel-btn {
  color: #f56c6c;
}

.cancel-btn:hover {
  background: rgba(245, 108, 108, 0.06);
  border-color: #f56c6c;
}

/* ── 波形动画容器 ─────────────────────────────────── */
.waveform-container {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 4px 0 8px;
  gap: 24px;
}

/* ── 底部 ──────────────────────────────────────────── */
.agent-float-footer {
  padding: 10px 12px;
  border-top: 1px solid var(--el-border-color-light);
  background: white;
}

.agent-float-footer-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 16px;
  margin-top: 8px;
}

@media (max-width: 768px) {
  .agent-float-root {
    right: 10px;
    bottom: 10px;
  }

  .agent-float-panel {
    width: calc(100vw - 20px);
    height: calc(100vh - 70px);
    max-height: calc(100vh - 20px);
    border-radius: 14px;
  }

  .agent-float-model {
    width: 120px;
  }

  .agent-float-voice-btn {
    width: 100%;
    justify-content: center;
  }
}
</style>
