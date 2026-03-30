<template>
  <div
    class="page-container"
    style="height: 100%; display:flex; align-items:center; justify-content:center; padding: 1.5rem"
  >
    <el-card style="width: 28.75rem">
      <template #header>
        <div style="font-weight: 700">注册</div>
      </template>

      <el-form ref="formRef" :model="form" :rules="rules" label-width="110px">
        <el-form-item label="用户名" prop="username">
          <el-input v-model="form.username" autocomplete="username" />
        </el-form-item>
        <el-form-item label="密码" prop="password">
          <el-input v-model="form.password" type="password" show-password autocomplete="new-password" />
          <div style="font-size: 0.75rem; color: #909399; margin-top: 0.375rem">
            密码长度 6-20 位，不能包含空格
          </div>
        </el-form-item>
        <el-form-item label="确认密码" prop="confirmPassword">
          <el-input v-model="form.confirmPassword" type="password" show-password autocomplete="new-password" />
        </el-form-item>
      </el-form>

      <div style="display:flex; justify-content: space-between; align-items:center">
        <el-button link type="primary" @click="toLogin">已有账号，去登录</el-button>
        <div>
          <el-button @click="reset">重置</el-button>
          <el-button type="primary" :loading="loading" @click="submit">注册</el-button>
        </div>
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api } from '../api';

const router = useRouter();

const formRef = ref<any>(null);
const loading = ref(false);

const form = reactive({
  username: '',
  password: '',
  confirmPassword: '',
});

function validatePassword(_rule: any, value: string, callback: any) {
  const v = String(value || '');
  if (v.length < 6 || v.length > 20) return callback(new Error('密码长度需要 6-20 位'));
  if (/\s/.test(v)) return callback(new Error('密码不能包含空格'));
  callback();
}

function validateConfirm(_rule: any, value: string, callback: any) {
  if (String(value || '') !== String(form.password || '')) return callback(new Error('两次输入的密码不一致'));
  callback();
}

const rules = {
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  password: [
    { required: true, message: '请输入密码', trigger: 'blur' },
    { validator: validatePassword, trigger: 'blur' },
  ],
  confirmPassword: [
    { required: true, message: '请再次输入密码', trigger: 'blur' },
    { validator: validateConfirm, trigger: 'blur' },
  ],
};

function reset() {
  form.username = '';
  form.password = '';
  form.confirmPassword = '';
}

function toLogin() {
  router.push('/login');
}

async function submit() {
  try {
    await formRef.value?.validate();
    loading.value = true;
    await api.post('/auth/register', {
      username: form.username,
      password: form.password,
    });
    ElMessage.success('注册成功，账号需要管理员审核通过后才能登录');
    router.replace('/login');
  } catch (error: any) {
    const msg = error?.response?.data?.message || error?.message || '注册失败';
    ElMessage.error(msg);
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.page-container {
  background: url('@asstes/images/bg.png') no-repeat center center;
  background-size: cover;
  box-sizing: border-box;
}
</style>
