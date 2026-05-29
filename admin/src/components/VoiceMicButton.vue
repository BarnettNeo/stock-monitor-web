<template>
  <button
    ref="btnRef"
    class="voice-mic-btn"
    :class="{
      active: voiceState === 'listening' || voiceState === 'recording',
      idle: voiceState === 'idle',
      processing: voiceState === 'processing',
      responding: voiceState === 'responding' || voiceState === 'speaking',
      requesting: voiceState === 'requesting',
      error: voiceState === 'error',
      disabled: disabled,
    }"
    :disabled="disabled"
    :title="tooltipLabel"
    @mousedown.prevent="handleMouseDown"
    @mouseup.prevent="handleMouseUp"
    @mouseleave.prevent="handleMouseLeave"
    @touchstart.prevent="handleTouchStart"
    @touchend.prevent="handleMouseUp"
    @click.prevent="handleClick"
  >
    <!-- 呼吸光圈背景 -->
    <span v-if="showPulse" class="mic-pulse-ring">
      <span class="mic-pulse-ring-inner"></span>
    </span>

    <!-- 麦克风图标 -->
    <svg class="mic-icon" :class="{ active: showPulse }" width="22" height="22" viewBox="0 0 24 24" fill="none">
      <rect
        x="9"
        y="2"
        width="6"
        height="11"
        rx="3"
        :stroke="iconColor"
        stroke-width="2"
        fill="none"
      />
      <path
        d="M5 11a7 7 0 0 0 14 0"
        :stroke="iconColor"
        stroke-width="2"
        stroke-linecap="round"
        fill="none"
      />
      <line
        x1="12"
        y1="19"
        x2="12"
        y2="22"
        :stroke="iconColor"
        stroke-width="2"
        stroke-linecap="round"
      />
    </svg>

    <!-- 加载旋转器 -->
    <span v-if="showSpinner" class="mic-spinner"></span>
  </button>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

const props = withDefaults(
  defineProps<{
    voiceState?: 'idle' | 'requesting' | 'listening' | 'recording' | 'processing' | 'responding' | 'speaking' | 'error';
    triggerMode?: 'click' | 'hold';
    disabled?: boolean;
  }>(),
  {
    voiceState: 'idle',
    triggerMode: 'click',
    disabled: false,
  },
);

const emit = defineEmits<{
  activate: [];
  deactivate: [];
}>();

const btnRef = ref<HTMLElement | null>(null);
const holding = ref(false);
let holdTimer: ReturnType<typeof setTimeout> | null = null;
let isPointerDown = false;

const isActive = computed(
  () => props.voiceState === 'listening' || props.voiceState === 'recording' || props.voiceState === 'requesting',
);

const showPulse = computed(
  () => props.voiceState === 'listening' || props.voiceState === 'recording' || props.voiceState === 'processing',
);

const showSpinner = computed(() => props.voiceState === 'requesting' || props.voiceState === 'processing');

const iconColor = computed(() => {
  if (props.voiceState === 'listening' || props.voiceState === 'recording') return '#fff';
  if (props.voiceState === 'responding' || props.voiceState === 'speaking') return '#67c23a';
  if (props.voiceState === 'processing') return '#e6a23c';
  if (props.voiceState === 'error') return '#fff';
  return '#fff';
});

const tooltipLabel = computed(() => {
  if (props.disabled) return '当前不可用';
  if (isActive.value) return '点击停止录音';
  if (props.triggerMode === 'hold') return '按住空格键或长按按钮开始录音';
  return '点击开始录音（也可按住空格键）';
});

function handleClick(): void {
  if (props.disabled) return;
  if (props.triggerMode === 'click' || !isPointerDown) {
    if (isActive.value) {
      emit('deactivate');
    } else {
      emit('activate');
    }
  }
}

function handleMouseDown(): void {
  isPointerDown = true;
  if (props.triggerMode === 'hold' && !isActive.value && !props.disabled) {
    holdTimer = setTimeout(() => {
      holding.value = true;
      emit('activate');
    }, 100);
  }
}

function handleMouseUp(): void {
  isPointerDown = false;
  if (holdTimer !== null) {
    clearTimeout(holdTimer);
    holdTimer = null;
  }
  if (props.triggerMode === 'hold' && holding.value) {
    holding.value = false;
    if (isActive.value) {
      emit('deactivate');
    }
  }
}

function handleMouseLeave(): void {
  if (holdTimer !== null) {
    clearTimeout(holdTimer);
    holdTimer = null;
  }
  holding.value = false;
  isPointerDown = false;
}

function handleTouchStart(): void {
  handleMouseDown();
}

/** 空格键处理 */
function handleKeyDown(e: KeyboardEvent): void {
  if (e.code === 'Space' && !props.disabled && !e.repeat) {
    // 如果焦点在输入框内，不要抢占
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    e.preventDefault();
    if (!isActive.value) {
      emit('activate');
    }
  }
}

function handleKeyUp(e: KeyboardEvent): void {
  if (e.code === 'Space' && !props.disabled) {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    e.preventDefault();
    if (isActive.value) {
      emit('deactivate');
    }
  }
}

onMounted(() => {
  document.addEventListener('keydown', handleKeyDown);
  document.addEventListener('keyup', handleKeyUp);
});

onBeforeUnmount(() => {
  document.removeEventListener('keydown', handleKeyDown);
  document.removeEventListener('keyup', handleKeyUp);
  if (holdTimer !== null) {
    clearTimeout(holdTimer);
  }
});
</script>

<style scoped>
.voice-mic-btn {
  position: relative;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  border: 1.5px solid var(--el-border-color-light, #dcdfe6);
  background: #fff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
  outline: none;
  flex-shrink: 0;
}

.voice-mic-btn:hover:not(.disabled) {
  box-shadow: 0 2px 12px rgba(64, 158, 255, 0.3);
}

.voice-mic-btn.disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.voice-mic-btn.idle {
  border-color: var(--el-color-primary, #409eff);
  background: var(--el-color-primary, #409eff);
  box-shadow: 0 2px 8px rgba(64, 158, 255, 0.2);
}

.voice-mic-btn.active {
  border-color: #f56c6c;
  background: #f56c6c;
  box-shadow: 0 0 0 4px rgba(245, 108, 108, 0.2);
}

.voice-mic-btn.processing {
  border-color: #e6a23c;
  background: rgba(230, 162, 60, 0.06);
}

.voice-mic-btn.responding {
  border-color: #67c23a;
  background: rgba(103, 194, 58, 0.06);
  box-shadow: 0 0 0 4px rgba(103, 194, 58, 0.12);
}

.voice-mic-btn.error {
  border-color: #f56c6c;
  background: rgba(245, 108, 108, 0.06);
}

.voice-mic-btn:active:not(.disabled) {
  transform: scale(0.9);
}

.mic-icon {
  position: relative;
  z-index: 1;
  transition: stroke 0.2s ease;
}

.mic-icon.active {
  animation: mic-bounce 0.6s ease-in-out infinite alternate;
}

@keyframes mic-bounce {
  from { transform: scale(1); }
  to { transform: scale(1.1); }
}

.mic-pulse-ring {
  position: absolute;
  inset: -6px;
  border-radius: 50%;
  animation: mic-pulse 1.5s ease-in-out infinite;
}

.mic-pulse-ring-inner {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: 50%;
  border: 2px solid #f56c6c;
  opacity: 0.3;
}

@keyframes mic-pulse {
  0% { transform: scale(1); opacity: 0.6; }
  50% { transform: scale(1.12); opacity: 0.15; }
  100% { transform: scale(1); opacity: 0.6; }
}

.mic-spinner {
  position: absolute;
  inset: -3px;
  border-radius: 50%;
  border: 2px solid transparent;
  border-top-color: var(--el-color-primary, #409eff);
  animation: mic-spin 0.7s linear infinite;
}

@keyframes mic-spin {
  to { transform: rotate(360deg); }
}
</style>
