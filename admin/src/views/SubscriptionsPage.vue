<template>
  <div>
    <el-card>
      <template #header>
        <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div class="font-bold">订阅列表</div>
          <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
            <el-input v-model="qName" placeholder="名称" class="w-full sm:w-44" clearable />
            <el-input v-model="qUsername" placeholder="用户名" class="w-full sm:w-44" clearable />
            <el-button class="w-full sm:w-auto" @click="search">查询</el-button>

            <el-button class="w-full sm:w-auto !ml-0" type="primary" @click="openCreate">新增订阅</el-button>
          </div>
        </div>
      </template>

      <div class="table-scroll">
        <el-table :data="items" style="width: 100%" v-loading="loading">
          <el-table-column prop="name" label="名称" min-width="140" />
          <el-table-column v-if="!isMobile" prop="webhookUrl" label="Webhook" min-width="240" />
          <el-table-column prop="createdByUsername" label="创建人" width="250" />
          <el-table-column prop="type" label="类型" width="120" />
        <el-table-column prop="enabled" label="启用" width="80">
          <template #default="scope">
            <el-tag :type="scope.row.enabled ? 'success' : 'info'">
              {{ scope.row.enabled ? '是' : '否' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="112" fixed="right">
          <template #default="scope">
            <el-button link type="primary" @click="openEdit(scope.row)">编辑</el-button>
            <el-button link type="danger" @click="remove(scope.row.id)">删除</el-button>
          </template>
        </el-table-column>
        </el-table>
      </div>

      <div style="display:flex; justify-content:flex-end; margin-top: 1rem">
        <el-pagination
          layout="total, sizes, prev, pager, next"
          :total="total"
          :page-size="pageSize"
          :page-sizes="[10, 20, 50, 100]"
          :current-page="currentPage"
          @current-change="handlePageChange"
          @size-change="handleSizeChange"
          hide-on-single-page
        />
      </div>
    </el-card>


    <el-dialog v-model="dialogVisible" :title="editing ? '编辑订阅' : '新增订阅'" width="720px" align-center>
      <el-form ref="formRef" :model="form" :rules="rules" label-width="120px">
        <el-form-item label="订阅名称" prop="name">
          <el-input v-model="form.name" />
        </el-form-item>
        <el-form-item label="启用">
          <el-switch v-model="form.enabled" />
        </el-form-item>
        <el-form-item label="类型" prop="type">
          <el-select v-model="form.type" style="width: 100%">
            <el-option label="钉钉机器人" value="dingtalk" />
            <el-option label="企业微信机器人" value="wecom_robot" />
          </el-select>
        </el-form-item>

        <el-form-item label="Webhook URL" prop="webhookUrl">
          <el-input v-model="form.webhookUrl" />
        </el-form-item>

        <el-form-item label="获取说明">
          <div style="display:flex; gap: 0.5rem; flex-wrap: wrap; align-items: center;">
            <el-popover placement="top-start" :width="!isMobile ? 560 : 320" trigger="click">
              <template #reference>
                <el-button size="small">钉钉 Webhook 获取</el-button>
              </template>
              <div style="font-size: 0.8125rem; line-height: 1.6;">
                <div style="font-weight: 700; margin-bottom: 0.375rem;">钉钉自定义机器人 Webhook URL 获取（钉钉开放平台）</div>
                <ol style="padding-left: 1.125rem; margin: 0;">
                  <li>打开钉钉，进入目标群聊（仅支持群聊）。</li>
                  <li>点击群聊右上角 → 设置图标 → 选择 群管理 → 机器人。</li>
                  <li>点击 添加机器人 → 选择 自定义。</li>
                  <li>填写机器人名称、上传头像，按需配置 安全设置（关键词/加签/IP 白名单）。</li>
                  <li>勾选协议，点击 完成。</li>
                  <li>生成后直接复制 Webhook 地址（格式：https://oapi.dingtalk.com/robot/send?access_token=xxx）</li>
                </ol>
                <div style="margin-top: 0.5rem;">
                  <el-alert
                    title="安全提示"
                    type="warning"
                    :closable="false"
                    show-icon
                    description="Webhook 包含 access_token，严禁泄露，否则他人可随意向该群发送消息。"
                  />
                </div>
              </div>
            </el-popover>

            <el-popover placement="top-start" :width="!isMobile ? 560 : 320" trigger="click">
              <template #reference>
                <el-button class="!ml-0" size="small">企业微信 Webhook 获取</el-button>
              </template>
              <div style="font-size: 0.8125rem; line-height: 1.6;">
                <div style="font-weight: 700; margin-bottom: 0.375rem;">企业微信自定义机器人 Webhook URL 获取</div>
                <ol style="padding-left: 1.125rem; margin: 0;">
                  <li>打开企业微信，进入目标群聊。</li>
                  <li>点击群聊右上角 → 更多 → 选择 添加群机器人。</li>
                  <li>选择 新创建一个机器人。</li>
                  <li>填写机器人名称，点击 添加机器人。</li>
                  <li>生成后直接复制地址（格式：https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx）</li>
                </ol>
                <div style="margin-top: 0.5rem;">
                  <el-alert
                    title="安全提示"
                    type="warning"
                    :closable="false"
                    show-icon
                    description="仅机器人创建者可查看 Webhook 地址，key 泄露会导致消息被滥用。"
                  />
                </div>
              </div>
            </el-popover>
          </div>
        </el-form-item>

        <el-form-item label="关键词">
          <el-input v-model="form.keyword" placeholder="可选" />
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="dialogVisible=false">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue';

import { ElMessage } from 'element-plus';
import { api } from '../api';
import { useIsMobile } from '../composables/useIsMobile';

const { isMobile } = useIsMobile();


// 订阅管理页：
// - 维护“推送渠道”配置（钉钉机器人/企业微信群机器人/企业微信自建应用等）
// - 策略通过 subscriptionIds 绑定订阅，触发后由后端按订阅发送并写入触发日志
type SubscriptionDto = {
  id: string;
  name: string;
  createdByUsername?: string | null;
  type: 'dingtalk' | 'wecom_robot';
  enabled: boolean;
  webhookUrl?: string;
  keyword?: string;
};

const qName = ref('');
const qUsername = ref('');

const loading = ref(false);
const items = ref<SubscriptionDto[]>([]);
const total = ref(0);
const pageSize = ref(10);
const currentPage = ref(1);

async function fetchList() {
  loading.value = true;
  try {
    const res = await api.get('/subscriptions', {
      params: {
        page: currentPage.value,
        pageSize: pageSize.value,
        name: qName.value || undefined,
        username: qUsername.value || undefined,
      },
    });
    const list = Array.isArray(res.data?.items) ? res.data.items : [];
    items.value = list;
    total.value = typeof res.data?.total === 'number' ? res.data.total : list.length;
  } finally {
    loading.value = false;
  }
}

function search() {
  currentPage.value = 1;
  fetchList();
}

function handlePageChange(page: number) {
  currentPage.value = page;
  fetchList();
}

function handleSizeChange(size: number) {
  pageSize.value = size;
  currentPage.value = 1;
  fetchList();
}

watch([qName, qUsername], () => {
  currentPage.value = 1;
});


const dialogVisible = ref(false);
const editing = ref(false);
const editingId = ref<string | null>(null);

const formRef = ref<any>(null);

const rules = reactive({
  name: [{ required: true, message: '请输入订阅名称', trigger: 'blur' }],
  type: [{ required: true, message: '请选择类型', trigger: 'change' }],
  webhookUrl: [{ required: true, message: '请输入Webhook URL', trigger: 'change' }]
});

const form = ref<any>({
  name: '',
  type: 'dingtalk',
  enabled: true,
  webhookUrl: '',
  keyword: '股票',
});

function openCreate() {
  editing.value = false;
  editingId.value = null;
  // 新增时给一个更易用的默认值
  form.value = {
    name: '',
    type: 'dingtalk',
    enabled: true,
    webhookUrl: '',
    keyword: '股票',
  };
  dialogVisible.value = true;
}

function openEdit(row: any) {
  editing.value = true;
  editingId.value = row.id;
  // 获取详情用于填充编辑表单
  api.get(`/subscriptions/${row.id}`).then(res => {
    form.value = res.data.item;
    dialogVisible.value = true;
  });
}

// 保存订阅：根据 editing 状态选择新增/更新
async function save() {
  try {
    await formRef.value?.validate();

    if (editing.value && editingId.value) {
      await api.put(`/subscriptions/${editingId.value}`, form.value);
    } else {
      await api.post('/subscriptions', form.value);
    }
    ElMessage.success('保存成功');
    dialogVisible.value = false;
    await fetchList();
  } catch (error: any) {
    const msg = error?.response?.data?.message || error?.message || '保存失败';
    ElMessage.error(msg);
  }
}

async function remove(id: string) {
  try {
    await api.delete(`/subscriptions/${id}`);
    await fetchList();
    ElMessage.success('删除成功');
  } catch (error: any) {
    ElMessage.error(error?.response?.data?.message || error?.message || '删除失败');
  }
}

onMounted(fetchList);
</script>
