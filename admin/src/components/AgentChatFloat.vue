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
            <div class="agent-msg-content">{{ m.content }}</div>
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

          <div v-if="sending" class="agent-float-sending flex align-center justify-center">
            <el-icon size="20"><Loading /></el-icon>
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
import { ChatDotRound, ChatLineRound, Loading } from '@element-plus/icons-vue';
import { api } from '../api';
import { useASR } from '../composables/useASR';
import { useVAD } from '../composables/useVAD';
import VoiceMicButton from './VoiceMicButton.vue';
import VoiceWaveformAnimation from './VoiceWaveformAnimation.vue';
import VoicePermissionModal from './VoicePermissionModal.vue';

type MsgRole = 'user' | 'assistant' | 'system';
type Msg = { role: MsgRole; content: string; ts: number };
type VoiceState = 'idle' | 'requesting' | 'listening' | 'recording' | 'processing' | 'responding' | 'speaking' | 'error';

const STORAGE_MODEL_KEY = 'agent_llm_model';

const open = ref(false);

const draft = ref('');
const sending = ref(false);
const messages = ref<Msg[]>([]);

const modelOptions = ref<string[]>(['qwen3.5-plus', 'qwen3.5-35b-a3b', 'qwen3.5-plus-2026-02-15']);
const model = ref<string>('qwen3.5-plus');

const listEl = ref<HTMLElement | null>(null);

// ── 语音状态 ──────────────────────────────────────────────
const voiceState = ref<VoiceState>('idle');
const volume = ref(0);
const interimText = ref('');
const recognizedText = ref('');
const showPermissionModal = ref(false);
// 保存最终识别的文本，用于取消/重录
const transcriptBuffer = ref('');

const isListening = computed(() => voiceState.value === 'listening' || voiceState.value === 'recording');
const inputPlaceholder = computed(() => {
  if (isListening.value) return '正在聆听... 或直接在此输入文字';
  return '输入内容，回车发送（Shift+Enter 换行）';
});

// ── ASR 语音识别 ──────────────────────────────────────────
const asr = useASR({
  language: 'zh-CN',
  onResult: (result) => {
    if (result.isFinal) {
      transcriptBuffer.value += result.transcript;
      recognizedText.value = transcriptBuffer.value;
      interimText.value = '';
      // 同时填入输入框方便编辑
      draft.value = transcriptBuffer.value;
    } else {
      interimText.value = result.transcript;
    }
  },
  onError: (err) => {
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
});

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

// 发送消息
async function send(): Promise<void> {
  const text = draft.value.trim();
  if (!text || sending.value) return;

  draft.value = '';
  messages.value.push({ role: 'user', content: text, ts: Date.now() });
  scrollToBottom();
  sending.value = true;
  try {
    const res = await api.post('/agent/chat', {
      message: text,
      context: {
        model: model.value,
      },
    });

    const reply = String(res.data?.reply || '').trim();
    messages.value.push({ role: 'assistant', content: reply || '(empty reply)', ts: Date.now() });
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
    scrollToBottom();
  }
}

onMounted(() => {
  loadModelFromStorage();
  document.addEventListener('keydown', globalKeyDown);
  document.addEventListener('keyup', globalKeyUp);
});

onBeforeUnmount(() => {
  document.removeEventListener('keydown', globalKeyDown);
  document.removeEventListener('keyup', globalKeyUp);
  asr.abort();
  vad.stop();
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
}
</style>
