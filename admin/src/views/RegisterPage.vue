<template>
  <div class="container" style="height: 100%; display:flex; align-items:center; justify-content:center; padding: 24px">
    <el-card style="width: 420px">
      <template #header>
        <div style="font-weight: 700">注册</div>
      </template>

      <el-form ref="formRef" :model="form" :rules="rules" label-width="90px">
        <el-form-item label="用户名" prop="username">
          <el-input v-model="form.username" autocomplete="username" />
        </el-form-item>
        <el-form-item label="密码" prop="password">
          <el-input v-model="form.password" type="password" show-password autocomplete="new-password" />
        </el-form-item>
      </el-form>

      <div style="display:flex; justify-content: space-between; align-items:center">
        <el-button link type="primary" @click="toLogin">去登录</el-button>
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
});

const rules = {
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码（至少6位）', trigger: 'blur' }],
};

function reset() {
  form.username = '';
  form.password = '';
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
    ElMessage.success('注册成功，请登录');
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
.container {
  background: url('@asstes/images/bg.png') no-repeat center center;
  background-size: cover;
  box-sizing: border-box;
}
</style>
