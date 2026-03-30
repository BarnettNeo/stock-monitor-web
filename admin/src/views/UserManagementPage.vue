<template>
  <div>
    <el-card>
      <template #header>
        <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div class="font-bold">用户管理</div>
          <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:flex-wrap sm:justify-end">
            <el-input v-model="q.username" placeholder="用户名" class="w-full sm:w-40" clearable />
            <el-select v-model="q.packageType" placeholder="套餐类型" class="w-full sm:w-36" clearable>
              <el-option label="免费版" value="free" />
              <el-option label="会员版" value="vip" />
            </el-select>
            <el-date-picker
              v-model="q.expireFrom"
              type="datetime"
              placeholder="有效期开始"
              value-format="YYYY-MM-DDTHH:mm:ss.SSS[Z]"
              class="w-full sm:w-48"
              clearable
            />
            <el-date-picker
              v-model="q.expireTo"
              type="datetime"
              placeholder="有效期结束"
              value-format="YYYY-MM-DDTHH:mm:ss.SSS[Z]"
              class="w-full sm:w-48"
              clearable
            />
            <el-select v-model="q.status" placeholder="状态" class="w-full sm:w-36" clearable>
              <el-option label="待审核" value="pending" />
              <el-option label="正常" value="active" />
              <el-option label="禁用" value="disabled" />
            </el-select>
            <el-button class="w-full sm:w-auto" @click="fetchList">搜索</el-button>
            <el-button class="w-full sm:w-auto" type="primary" @click="openCreate">新增用户</el-button>
          </div>
        </div>
      </template>

      <div class="table-scroll">
        <el-table :data="items" style="width: 100%" v-loading="loading">
        <el-table-column prop="username" label="用户名" />
        <el-table-column prop="userPackage" label="套餐类型" width="120">
          <template #default="scope">
            <el-tag :type="scope.row.userPackage === 'vip' ? 'success' : 'info'">
              {{ scope.row.userPackage === 'vip' ? '会员版' : '免费版' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column v-if="!isMobile" prop="packageExpire" label="套餐有效期" width="200">
          <template #default="scope">
            {{ formatDate(scope.row.packageExpire) }}
          </template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="120">
          <template #default="scope">
            <el-tag :type="scope.row.status === 'active' ? 'success' : scope.row.status === 'disabled' ? 'danger' : 'warning'">
              {{ scope.row.status === 'active' ? '正常' : scope.row.status === 'disabled' ? '禁用' : '待审核' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="200" fixed="right">
          <template #default="scope">
            <el-button link type="primary" @click="openEdit(scope.row)">编辑</el-button>
            <el-button
              v-if="scope.row.status === 'pending'"
              link
              type="success"
              @click="quickApprove(scope.row)"
            >
              审核通过
            </el-button>
            <el-button link type="danger" @click="remove(scope.row.userId)">删除</el-button>
          </template>
        </el-table-column>
        </el-table>
      </div>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="editing ? '编辑用户' : '新增用户'" width="720px" align-center>
      <el-form ref="formRef" :model="form" :rules="rules" label-width="120px">
        <el-form-item label="用户名" prop="username">
          <el-input v-model="form.username" :disabled="editing" />
        </el-form-item>
        <el-form-item :label="editing ? '重置密码(可选)' : '密码'" prop="password">
          <el-input v-model="form.password" type="password" show-password autocomplete="new-password" />
          <div style="font-size: 0.75rem; color: #909399; margin-top: 0.375rem">
            密码长度 6-20 位，不能包含空格
          </div>
        </el-form-item>
        <el-form-item label="套餐类型" prop="userPackage">
          <el-select v-model="form.userPackage" style="width: 100%">
            <el-option label="免费版" value="free" />
            <el-option label="会员版" value="vip" />
          </el-select>
        </el-form-item>
        <el-form-item label="套餐有效期" prop="packageExpire">
          <el-date-picker
            v-model="form.packageExpire"
            type="datetime"
            placeholder="不填表示长期有效"
            value-format="YYYY-MM-DDTHH:mm:ss.SSS[Z]"
            style="width: 100%"
            clearable
          />
        </el-form-item>
        <el-form-item label="最大策略数" prop="maxStrategyCount">
          <el-input-number v-model="form.maxStrategyCount" :min="1" :max="9999" style="width: 100%" />
        </el-form-item>
        <el-form-item label="状态" prop="status">
          <el-select v-model="form.status" style="width: 100%">
            <el-option label="待审核" value="pending" />
            <el-option label="正常" value="active" />
            <el-option label="禁用" value="disabled" />
          </el-select>
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../api';
import { useIsMobile } from '../composables/useIsMobile';

const { isMobile } = useIsMobile();

type UserItem = {
  userId: string;
  username: string;
  passwordHash: string;
  role: string;
  status: 'pending' | 'active' | 'disabled' | string;
  userPackage: 'free' | 'vip' | string;
  packageExpire: string | null;
  maxStrategyCount: number;
};

const q = reactive({
  username: '',
  password: '',
  packageType: '',
  expireFrom: '',
  expireTo: '',
  status: '',
});

const loading = ref(false);
const items = ref<UserItem[]>([]);

function formatDate(v: string | null) {
  if (!v) return '-';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleString('zh-CN');
}

async function fetchList() {
  loading.value = true;
  try {
    const res = await api.get('/users', {
      params: {
        username: q.username || undefined,
        password: q.password || undefined,
        packageType: q.packageType || undefined,
        expireFrom: q.expireFrom || undefined,
        expireTo: q.expireTo || undefined,
        status: q.status || undefined,
      },
    });
    items.value = res.data?.items || [];
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || e?.message || '查询用户列表失败');
  } finally {
    loading.value = false;
  }
}

const dialogVisible = ref(false);
const editing = ref(false);
const editingId = ref<string | null>(null);
const saving = ref(false);
const formRef = ref<any>(null);

const form = reactive<any>({
  username: '',
  password: '',
  userPackage: 'free',
  packageExpire: '',
  maxStrategyCount: 3,
  status: 'active',
});

function validatePassword(_rule: any, value: string, callback: any) {
  const v = String(value || '');
  if (editing.value && !v) return callback();
  if (v.length < 6 || v.length > 20) return callback(new Error('密码长度需要 6-20 位'));
  if (/\s/.test(v)) return callback(new Error('密码不能包含空格'));
  callback();
}

const rules = {
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  password: [{ validator: validatePassword, trigger: 'blur' }],
  userPackage: [{ required: true, message: '请选择套餐类型', trigger: 'change' }],
  status: [{ required: true, message: '请选择状态', trigger: 'change' }],
};

function openCreate() {
  editing.value = false;
  editingId.value = null;
  form.username = '';
  form.password = '';
  form.userPackage = 'free';
  form.packageExpire = '';
  form.maxStrategyCount = 3;
  form.status = 'active';
  dialogVisible.value = true;
}

function openEdit(row: UserItem) {
  editing.value = true;
  editingId.value = row.userId;
  form.username = row.username;
  form.password = '';
  form.userPackage = row.userPackage;
  form.packageExpire = row.packageExpire || '';
  form.maxStrategyCount = row.maxStrategyCount || 3;
  form.status = (row.status as any) || 'active';
  dialogVisible.value = true;
}

async function quickApprove(row: UserItem) {
  try {
    await api.put(`/users/${row.userId}`, { status: 'active' });
    ElMessage.success('已审核通过');
    fetchList();
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || e?.message || '操作失败');
  }
}

async function save() {
  try {
    await formRef.value?.validate();
    saving.value = true;
    if (editing.value && editingId.value) {
      const body: any = {
        status: form.status,
        userPackage: form.userPackage,
        packageExpire: form.packageExpire || null,
        maxStrategyCount: form.maxStrategyCount,
      };
      if (form.password) body.password = form.password;
      await api.put(`/users/${editingId.value}`, body);
    } else {
      await api.post('/users', {
        username: form.username,
        password: form.password,
        status: form.status,
        userPackage: form.userPackage,
        packageExpire: form.packageExpire || null,
        maxStrategyCount: form.maxStrategyCount,
      });
    }
    ElMessage.success('保存成功');
    dialogVisible.value = false;
    fetchList();
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || e?.message || '保存失败');
  } finally {
    saving.value = false;
  }
}

async function remove(id: string) {
  try {
    await ElMessageBox.confirm('确认要删除该用户吗？删除后不可恢复。', '提示', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
    });
  } catch {
    return;
  }

  try {
    await api.delete(`/users/${id}`);
    ElMessage.success('删除成功');
    fetchList();
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || e?.message || '删除失败');
  }
}

onMounted(fetchList);
</script>
