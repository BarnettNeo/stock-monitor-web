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
          <div v-if="messages.length === 0" class="agent-float-empty">
            你可以试试：<span class="agent-float-hint">“列出策略”</span> 或 <span class="agent-float-hint">“新增策略，监控 sh600519，阈值 2%”</span>
          </div>

          <div v-for="(m, idx) in viewMessages" :key="idx" class="agent-msg" :class="m.role">
            <div class="agent-msg-role">{{ m.roleLabel }}</div>
            <div class="agent-msg-content">{{ m.content }}</div>
          </div>
          <div v-if="sending" class="agent-float-sending flex align-center justify-center"><el-icon size="20"><Loading /></el-icon></div>
        </div>

        <div class="agent-float-footer">
          <el-input
            v-model="draft"
            type="textarea"
            :autosize="{ minRows: 2, maxRows: 4 }"
            placeholder="输入内容，回车发送（Shift+Enter 换行）"
            @keydown.enter.exact.prevent="send"
          />
          <div class="agent-float-footer-actions">
            <el-button :disabled="sending || !draft.trim()" type="primary" @click="send">发送</el-button>
            <el-button link @click="open = false">隐藏</el-button>
          </div>
        </div>
      </div>
    </div>
  </teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { ChatDotRound, ChatLineRound } from '@element-plus/icons-vue';
import { Loading } from '@element-plus/icons-vue';
import { api } from '../api';

type MsgRole = 'user' | 'assistant' | 'system';
type Msg = { role: MsgRole; content: string; ts: number };

const STORAGE_MODEL_KEY = 'agent_llm_model';

const open = ref(false);

const draft = ref('');
const sending = ref(false);
const messages = ref<Msg[]>([]);

const modelOptions = ref<string[]>(['qwen3-max', 'qwen-turbo', 'qwen-max']);
const model = ref<string>('qwen3-max');

const listEl = ref<HTMLElement | null>(null);

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
:global(.agent-float-model-popper) {
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
  width: 420px;
  max-width: calc(100vw - 32px);
  height: 560px;
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
}

.agent-msg.user .agent-msg-content {
  border-color: rgba(64, 158, 255, 0.25);
  background: rgba(64, 158, 255, 0.08);
}

.agent-msg.system .agent-msg-content {
  border-color: rgba(245, 108, 108, 0.25);
  background: rgba(245, 108, 108, 0.06);
}

.agent-float-footer {
  padding: 10px 12px;
  border-top: 1px solid var(--el-border-color-light);
  background: white;
}

.agent-float-footer-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 8px;
}
</style>
