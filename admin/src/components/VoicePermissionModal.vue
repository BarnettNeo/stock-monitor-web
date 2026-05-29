<template>
  <teleport to="body">
    <div class="permission-modal-overlay" @click.self="$emit('close')">
      <div class="permission-modal-card">
        <div class="permission-modal-icon">
          <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
            <circle cx="24" cy="24" r="22" stroke="#f56c6c" stroke-width="2.5" fill="rgba(245,108,108,0.06)" />
            <path
              d="M24 14v10M24 28v2"
              stroke="#f56c6c"
              stroke-width="2.5"
              stroke-linecap="round"
            />
          </svg>
        </div>

        <div class="permission-modal-title">需要麦克风权限</div>

        <div class="permission-modal-desc">
          语音识别功能需要访问您的麦克风。请按照以下步骤开启权限：
        </div>

        <ol class="permission-modal-steps">
          <li>
            <span class="step-num">1</span>
            <span class="step-text">点击浏览器地址栏左侧的 <strong>锁形图标</strong> 或 <strong>信息图标</strong></span>
          </li>
          <li>
            <span class="step-num">2</span>
            <span class="step-text">找到 <strong>「麦克风」</strong> 权限设置项</span>
          </li>
          <li>
            <span class="step-num">3</span>
            <span class="step-text">将权限改为 <strong>「允许」</strong></span>
          </li>
          <li>
            <span class="step-num">4</span>
            <span class="step-text">刷新页面后再次尝试</span>
          </li>
        </ol>

        <div class="permission-modal-actions">
          <button class="perm-btn perm-btn-cancel" @click="$emit('close')">暂不使用</button>
          <button class="perm-btn perm-btn-retry" @click="$emit('retry')">重新授权</button>
        </div>
      </div>
    </div>
  </teleport>
</template>

<script setup lang="ts">
defineEmits<{
  close: [];
  retry: [];
}>();
</script>

<style scoped>
.permission-modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 5000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.35);
  backdrop-filter: blur(2px);
  animation: perm-fade-in 0.2s ease;
}

@keyframes perm-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

.permission-modal-card {
  width: min(380px, calc(100vw - 40px));
  background: #fff;
  border-radius: 16px;
  padding: 28px 24px 20px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.18);
  animation: perm-zoom-in 0.25s ease;
}

@keyframes perm-zoom-in {
  from { transform: scale(0.92); opacity: 0; }
  to { transform: scale(1); opacity: 1; }
}

.permission-modal-icon {
  display: flex;
  justify-content: center;
  margin-bottom: 16px;
}

.permission-modal-title {
  text-align: center;
  font-size: 17px;
  font-weight: 600;
  color: #303133;
  margin-bottom: 10px;
}

.permission-modal-desc {
  text-align: center;
  font-size: 13px;
  color: #909399;
  line-height: 1.6;
  margin-bottom: 18px;
}

.permission-modal-steps {
  list-style: none;
  padding: 0;
  margin: 0 0 22px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.permission-modal-steps li {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  font-size: 13px;
  color: #606266;
  line-height: 1.5;
}

.step-num {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--el-color-primary-light-8, #ecf5ff);
  color: var(--el-color-primary, #409eff);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
}

.step-text {
  padding-top: 2px;
}

.step-text strong {
  color: #303133;
}

.permission-modal-actions {
  display: flex;
  gap: 10px;
  justify-content: center;
}

.perm-btn {
  flex: 1;
  height: 40px;
  border-radius: 10px;
  border: none;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.15s ease;
  font-family: inherit;
}

.perm-btn-cancel {
  background: #f4f4f5;
  color: #606266;
}

.perm-btn-cancel:hover {
  background: #e9e9eb;
}

.perm-btn-retry {
  background: var(--el-color-primary, #409eff);
  color: #fff;
}

.perm-btn-retry:hover {
  background: var(--el-color-primary-light-3, #79bbff);
}
</style>
