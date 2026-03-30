<template>
  <div
    class="page-container"
    style="width: 100%; height: 100%; display:flex; align-items:center; justify-content:center; padding: 1.5rem"
  >
    <el-card style="width: 26.25rem">
      <template #header>
        <div style="font-weight: 700">登录</div>
      </template>

      <el-form ref="formRef" :model="form" :rules="rules" label-width="90px">
        <el-form-item label="用户名" prop="username">
          <el-input v-model="form.username" autocomplete="username" />
        </el-form-item>
        <el-form-item label="密码" prop="password">
          <el-input v-model="form.password" type="password" show-password autocomplete="current-password" />
        </el-form-item>
        <el-form-item label="验证码" prop="captchaCode">
          <div style="display:flex; gap: 0.625rem; align-items:center; width: 100%">
            <el-input v-model="form.captchaCode" autocomplete="off" placeholder="请输入验证码" />
            <el-image
              v-if="captchaImage"
              :src="captchaImage"
              style="width: 7.5rem; height: 2.5rem; border-radius: 0.375rem; cursor: pointer; user-select:none"
              fit="contain"
              @click="refreshCaptcha"
            />
            <el-button v-else @click="refreshCaptcha">获取验证码</el-button>
          </div>
        </el-form-item>
      </el-form>

      <div style="display:flex; justify-content: space-between; align-items:center">
        <el-button link type="primary" @click="toRegister">没有账号，去注册</el-button>
        <div>
          <el-button @click="reset">重置</el-button>
          <el-button type="primary" :loading="loading" @click="submit">登录</el-button>
        </div>
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api, setAuthToken } from '../api';
import { useIsMobile } from '../composables/useIsMobile';

const router = useRouter();
const { isMobile } = useIsMobile();

const formRef = ref<any>(null);
const loading = ref(false);

const form = reactive({
  username: '',
  password: '',
  captchaId: '',
  captchaCode: '',
});

const rules = {
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }],
  captchaCode: [{ required: true, message: '请输入验证码', trigger: 'blur' }],
};

const captchaCache = ref<Record<string, string>>({});
const captchaImage = computed(() => (form.captchaId ? captchaCache.value[form.captchaId] || '' : ''));

async function refreshCaptcha(): Promise<void> {
  try {
    const res = await api.get('/auth/captcha');
    const captchaId = res.data?.captchaId || '';
    const image = res.data?.image || '';
    form.captchaId = captchaId;
    form.captchaCode = '';
    if (captchaId && image) captchaCache.value = { [captchaId]: image };
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || e?.message || '获取验证码失败');
  }
}

function reset() {
  form.username = '';
  form.password = '';
  form.captchaCode = '';
  refreshCaptcha();
}

function toRegister() {
  router.push('/register');
}

async function submit() {
  try {
    await formRef.value?.validate();
    loading.value = true;
    const res = await api.post('/auth/login', {
      username: form.username,
      password: form.password,
      captchaId: form.captchaId,
      captchaCode: form.captchaCode,
    });
    setAuthToken(res.data.token);
    ElMessage.success('登录成功');
    router.replace('/screen');
  } catch (error: any) {
    const msg = error?.response?.data?.message || error?.message || '登录失败';
    ElMessage.error(msg);
    refreshCaptcha();
  } finally {
    loading.value = false;
  }
}

onMounted(refreshCaptcha);
</script>

<style scoped>
.page-container {
  background: url('@asstes/images/bg.png') no-repeat center center;
  background-size: cover;
  box-sizing: border-box;
}
</style>
