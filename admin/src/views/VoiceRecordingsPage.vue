<template>
  <div class="voice-recordings-page">
    <el-card>
      <template #header>
        <div class="voice-recordings-header">
          <div>
            <div class="page-title">录音历史</div>
            <div class="page-subtitle">支持分页、搜索、回放、下载与删除，播放通过后端鉴权接口获取。</div>
          </div>

          <div class="voice-recordings-toolbar">
            <el-input
              v-model="query"
              clearable
              placeholder="按名称 / 来源 / ID 搜索"
              class="voice-recordings-search"
              @keyup.enter="search"
              @clear="resetSearch"
            />
            <el-select v-model="pageSize" class="voice-recordings-page-size" @change="handlePageSizeChange">
              <el-option label="10 / 页" :value="10" />
              <el-option label="20 / 页" :value="20" />
              <el-option label="50 / 页" :value="50" />
            </el-select>
            <el-button @click="search">搜索</el-button>
            <el-button :loading="loading" @click="reload">刷新</el-button>
            <el-button type="primary" plain @click="goBack">返回助手</el-button>
          </div>
        </div>
      </template>

      <div v-if="error" class="voice-recordings-error">{{ error }}</div>
      <div v-else-if="items.length === 0" class="voice-recordings-empty">暂无录音记录</div>

      <div v-else class="voice-recordings-list">
        <div v-for="item in items" :key="item.id" class="voice-recordings-item">
          <div class="voice-recordings-main">
            <div class="voice-recordings-name">{{ item.originalName || '未命名录音' }}</div>
            <div class="voice-recordings-meta">
              {{ formatDuration(item.durationMs) }} · {{ formatBytes(item.sizeBytes) }} · {{ formatDateTime(item.createdAt) }}
            </div>
            <div class="voice-recordings-meta">来源：{{ item.source || 'agent-chat' }} · 状态：{{ item.status }}</div>

            <div v-if="item.transcript || item.llmReply" class="voice-recordings-detail">
              <div class="voice-recordings-detail-toggle" @click="toggleDetail(item.id)">
                <el-icon :size="14"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline :points="expandedIds.has(item.id) ? '18 15 12 9 6 15' : '6 9 12 15 18 9'"/></svg></el-icon>
                {{ expandedIds.has(item.id) ? '收起详情' : '查看详情' }}
              </div>
              <div v-if="expandedIds.has(item.id)" class="voice-recordings-detail-content">
                <div v-if="item.transcript" class="voice-recordings-detail-row">
                  <span class="voice-recordings-detail-label">识别文本：</span>
                  <span class="voice-recordings-detail-value">{{ item.transcript }}</span>
                </div>
                <div v-if="item.llmReply" class="voice-recordings-detail-row">
                  <span class="voice-recordings-detail-label">LLM 回复：</span>
                  <span class="voice-recordings-detail-value">{{ item.llmReply }}</span>
                </div>
              </div>
            </div>
          </div>

          <div class="voice-recordings-actions">
            <el-button size="small" @click="playRecording(item)">播放</el-button>
            <el-button size="small" @click="downloadRecording(item)">下载</el-button>
            <el-button size="small" type="danger" plain @click="removeRecording(item)">删除</el-button>
          </div>
        </div>
      </div>

      <div v-if="previewUrl" class="voice-recordings-player">
        <div class="voice-recordings-player-title">{{ previewName }}</div>
        <audio :src="previewUrl" controls class="voice-recordings-audio"></audio>
      </div>

      <div class="voice-recordings-footer">
        <div class="voice-recordings-summary">
          共 {{ total }} 条记录，第 {{ currentPage }} / {{ totalPages }} 页
        </div>
        <el-pagination
          background
          layout="prev, pager, next, total"
          :total="total"
          :current-page="currentPage"
          :page-size="pageSize"
          :hide-on-single-page="true"
          @current-change="handlePageChange"
        />
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';

import { api } from '../api';

type VoiceRecording = {
  id: string;
  originalName: string | null;
  mimeType: string;
  fileExt: string;
  sizeBytes: number;
  durationMs: number | null;
  sha256: string;
  status: string;
  source: string | null;
  transcript: string | null;
  llmReply: string | null;
  createdAt: string;
  updatedAt: string;
  downloadUrl: string;
};

const router = useRouter();

const query = ref('');
const pageSize = ref(10);
const currentPage = ref(1);
const total = ref(0);
const loading = ref(false);
const error = ref('');
const items = ref<VoiceRecording[]>([]);
const previewUrl = ref('');
const previewName = ref('');
const expandedIds = ref(new Set<string>());

function toggleDetail(id: string): void {
  const s = expandedIds.value;
  if (s.has(id)) {
    s.delete(id);
  } else {
    s.add(id);
  }
  // trigger reactivity by replacing the Set
  expandedIds.value = new Set(s);
}

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)));

function formatDuration(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '00:00';
  const totalSeconds = Math.max(0, Math.floor(value / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

function revokePreview(): void {
  if (previewUrl.value) {
    URL.revokeObjectURL(previewUrl.value);
    previewUrl.value = '';
  }
  previewName.value = '';
}

async function fetchList(page = currentPage.value): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    currentPage.value = page;
    const response = await api.get('/voice/recordings', {
      params: {
        page,
        limit: pageSize.value,
        q: query.value.trim() || undefined,
      },
    });
    items.value = Array.isArray(response.data?.items) ? response.data.items : [];
    total.value = Number(response.data?.pagination?.total || 0);
  } catch (err: any) {
    error.value = err?.response?.data?.message || err?.message || '加载录音历史失败';
    ElMessage.error(error.value);
  } finally {
    loading.value = false;
  }
}

function search(): void {
  void fetchList(1);
}

function resetSearch(): void {
  query.value = '';
  void fetchList(1);
}

function handlePageChange(page: number): void {
  void fetchList(page);
}

function handlePageSizeChange(): void {
  void fetchList(1);
}

async function fetchRecordingBlob(recording: VoiceRecording): Promise<Blob> {
  const response = await api.get(`/voice/recordings/${encodeURIComponent(recording.id)}/file`, {
    responseType: 'blob',
  });
  return new Blob([response.data], {
    type: response.headers?.['content-type'] || recording.mimeType || 'application/octet-stream',
  });
}

async function playRecording(recording: VoiceRecording): Promise<void> {
  try {
    revokePreview();
    const blob = await fetchRecordingBlob(recording);
    previewUrl.value = URL.createObjectURL(blob);
    previewName.value = recording.originalName || `录音 ${recording.id}`;
  } catch (err: any) {
    const message = err?.response?.data?.message || err?.message || '播放录音失败';
    ElMessage.error(message);
  }
}

async function downloadRecording(recording: VoiceRecording): Promise<void> {
  try {
    const blob = await fetchRecordingBlob(recording);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = recording.originalName || `voice-recording-${recording.id}.${recording.fileExt || 'bin'}`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err: any) {
    const message = err?.response?.data?.message || err?.message || '下载录音失败';
    ElMessage.error(message);
  }
}

async function removeRecording(recording: VoiceRecording): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认删除录音「${recording.originalName || recording.id}」吗？`, '删除录音', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    });
  } catch {
    return;
  }

  try {
    await api.delete(`/voice/recordings/${encodeURIComponent(recording.id)}`);
    ElMessage.success('录音已删除');
    const nextPage = items.value.length <= 1 && currentPage.value > 1 ? currentPage.value - 1 : currentPage.value;
    await fetchList(nextPage);
  } catch (err: any) {
    const message = err?.response?.data?.message || err?.message || '删除录音失败';
    ElMessage.error(message);
  }
}

function goBack(): void {
  router.push('/screen');
}

const reload = (): void => {
  void fetchList(currentPage.value);
};

onMounted(() => {
  void fetchList();
});
</script>

<style scoped>
.voice-recordings-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.voice-recordings-header {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  align-items: flex-start;
}

.page-title {
  font-size: 18px;
  font-weight: 600;
}

.page-subtitle {
  margin-top: 4px;
  color: var(--el-text-color-secondary);
  font-size: 13px;
  line-height: 1.6;
}

.voice-recordings-toolbar {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}

.voice-recordings-search {
  width: min(320px, 100%);
}

.voice-recordings-page-size {
  width: 110px;
}

.voice-recordings-error,
.voice-recordings-empty {
  padding: 14px;
  border-radius: 10px;
  border: 1px dashed var(--el-border-color-light);
  color: var(--el-text-color-secondary);
  background: rgba(248, 249, 252, 0.8);
}

.voice-recordings-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.voice-recordings-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  padding: 14px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.85);
}

.voice-recordings-main {
  min-width: 0;
  flex: 1;
}

.voice-recordings-name {
  font-size: 14px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.voice-recordings-meta {
  margin-top: 4px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 1.5;
}

.voice-recordings-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.voice-recordings-player {
  margin-top: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.voice-recordings-player-title {
  font-size: 13px;
  font-weight: 600;
}

.voice-recordings-audio {
  width: 100%;
}

.voice-recordings-footer {
  margin-top: 16px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.voice-recordings-summary {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.voice-recordings-detail {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--el-border-color-lighter);
}

.voice-recordings-detail-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--el-color-primary);
  cursor: pointer;
  user-select: none;
}

.voice-recordings-detail-toggle:hover {
  opacity: 0.8;
}

.voice-recordings-detail-content {
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.voice-recordings-detail-row {
  display: flex;
  gap: 4px;
  font-size: 12px;
  line-height: 1.6;
}

.voice-recordings-detail-label {
  flex-shrink: 0;
  color: var(--el-text-color-secondary);
  font-weight: 500;
}

.voice-recordings-detail-value {
  color: var(--el-text-color-regular);
  word-break: break-word;
  white-space: pre-wrap;
}

@media (max-width: 768px) {
  .voice-recordings-item {
    flex-direction: column;
    align-items: flex-start;
  }

  .voice-recordings-actions {
    width: 100%;
  }
}
</style>
