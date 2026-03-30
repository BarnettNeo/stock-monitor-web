<template>
  <div style="display:flex; flex-direction: column; gap: 1rem">
    <el-card v-loading="loadingPkg">
      <template #header>
        <div style="display:flex; justify-content: space-between; align-items:center">
          <div>套餐信息</div>
          <div>
            <el-button @click="fetchPackage">刷新</el-button>
            <el-button type="primary" @click="openPwdDialog">修改密码</el-button>
          </div>
        </div>
      </template>

      <template v-if="pkg">
        <el-descriptions :column="1" border>
          <el-descriptions-item label="套餐类型">
            <el-tag :type="pkg.userPackage === 'vip' ? 'success' : 'info'">
              {{ pkg.userPackage === 'vip' ? '会员版' : '免费版' }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="有效期">
           <span>{{ expireText }}</span>
            <el-tag v-if="!pkg.packageActive" type="danger" size="small" style="margin-left: 0.5rem">已过期</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="最大策略数">
            {{ pkg.maxStrategyCount }}
          </el-descriptions-item>
          <el-descriptions-item label="当前策略数">
            {{ pkg.strategyCount }}
          </el-descriptions-item>
          <el-descriptions-item label="剩余可用策略数">
            <el-tag :type="pkg.remainStrategyCount > 0 ? 'success' : 'warning'">
              {{ pkg.remainStrategyCount }}
            </el-tag>
          </el-descriptions-item>
        </el-descriptions>
      </template>
      <template v-else>
        <el-empty description="暂无数据" />
      </template>
    </el-card>

    <el-dialog
      v-model="pwdDialogVisible"
      title="修改密码"
      width="520px"
      :close-on-click-modal="!savingPwd"
      :close-on-press-escape="!savingPwd"
      :show-close="!savingPwd"
      @closed="onPwdDialogClosed"
    >
      <el-form ref="pwdRef" :model="pwd" :rules="pwdRules" label-width="110px" style="max-width: 520px">
        <el-form-item label="原密码" prop="oldPassword">
          <el-input v-model="pwd.oldPassword" type="password" show-password autocomplete="current-password" />
        </el-form-item>
        <el-form-item label="新密码" prop="newPassword">
          <el-input v-model="pwd.newPassword" type="password" show-password autocomplete="new-password" />
          <div style="font-size: 0.75rem; color: #909399; margin-top: 0.375rem">
            密码长度 6-20 位，不能包含空格
          </div>
        </el-form-item>
        <el-form-item label="确认新密码" prop="confirmPassword">
          <el-input v-model="pwd.confirmPassword" type="password" show-password autocomplete="new-password" />
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button :disabled="savingPwd" @click="pwdDialogVisible = false">取消</el-button>
        <el-button :disabled="savingPwd" @click="resetPwd">重置</el-button>
        <el-button type="primary" :loading="savingPwd" @click="savePwd">保存</el-button>
      </template>
    </el-dialog>
</div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../api';

type PackageDto = {
  userId: string;
  userPackage: 'free' | 'vip';
  packageExpire: string | null;
  packageActive: boolean;
  maxStrategyCount: number;
  strategyCount: number;
  remainStrategyCount: number;
};

const loadingPkg = ref(false);
const pkg = ref<PackageDto | null>(null);

const expireText = computed(() => {
  if (!pkg.value?.packageExpire) return '-';
  const d = new Date(pkg.value.packageExpire);
  if (Number.isNaN(d.getTime())) return pkg.value.packageExpire;
  return d.toLocaleString('zh-CN');
});

async function fetchPackage() {
  loadingPkg.value = true;
  try {
    const res = await api.get('/users/me/package');
    pkg.value = res.data?.item || null;
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || e?.message || '查询套餐信息失败');
  } finally {
    loadingPkg.value = false;
  }
}

const pwdDialogVisible = ref(false);
const pwdRef = ref<any>(null);
const savingPwd = ref(false);
const pwd = reactive({
  oldPassword: '',
  newPassword: '',
  confirmPassword: '',
});

function openPwdDialog() {
  pwdDialogVisible.value = true;
}

function onPwdDialogClosed() {
  resetPwd();
  pwdRef.value?.clearValidate?.();
}

watch(
  () => pwdDialogVisible.value,
  (v) => {
    if (!v) return;
    nextTick().then(() => {
      pwdRef.value?.clearValidate?.();
    });
  },
);

function validatePassword(_rule: any, value: string, callback: any) {
  const v = String(value || '');
  if (v.length < 6 || v.length > 20) return callback(new Error('密码长度需要 6-20 位'));
  if (/\s/.test(v)) return callback(new Error('密码不能包含空格'));
  callback();
}

function validateConfirm(_rule: any, value: string, callback: any) {
  if (String(value || '') !== String(pwd.newPassword || '')) return callback(new Error('两次输入的密码不一致'));
  callback();
}

const pwdRules = {
  oldPassword: [{ required: true, message: '请输入原密码', trigger: 'blur' }],
  newPassword: [
    { required: true, message: '请输入新密码', trigger: 'blur' },
    { validator: validatePassword, trigger: 'blur' },
  ],
  confirmPassword: [
    { required: true, message: '请再次输入新密码', trigger: 'blur' },
    { validator: validateConfirm, trigger: 'blur' },
  ],
};

function resetPwd() {
  pwd.oldPassword = '';
  pwd.newPassword = '';
  pwd.confirmPassword = '';
}

async function savePwd() {
  try {
    await pwdRef.value?.validate();
    savingPwd.value = true;
    await api.put('/users/me/password', {
      oldPassword: pwd.oldPassword,
      newPassword: pwd.newPassword,
    });
    ElMessage.success('密码修改成功');
    pwdDialogVisible.value = false;
    resetPwd();
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || e?.message || '密码修改失败');
  } finally {
    savingPwd.value = false;
  }
}

onMounted(fetchPackage);
</script>
