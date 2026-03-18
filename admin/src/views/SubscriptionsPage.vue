<template>
  <div>
    <el-card>
      <template #header>
        <div style="display:flex; justify-content: space-between; align-items:center">
          <div>订阅列表</div>
          <div style="display:flex; gap: 8px; align-items:center">
            <el-input v-model="qName" placeholder="名称" style="width: 180px" clearable />
            <el-input v-model="qUsername" placeholder="用户名" style="width: 180px" clearable />
            <el-button @click="fetchList">查询</el-button>
            <el-button type="primary" @click="openCreate">新增订阅</el-button>
          </div>
        </div>
      </template>

      <el-table :data="items" style="width: 100%" v-loading="loading">
        <el-table-column prop="name" label="名称" />
        <el-table-column prop="webhookUrl" label="Webhook" />
        <el-table-column prop="createdByUsername" label="创建人" width="120" />
        <el-table-column prop="type" label="类型" width="120" />
        <el-table-column prop="enabled" label="启用" width="80">
          <template #default="scope">
            <el-tag :type="scope.row.enabled ? 'success' : 'info'">
              {{ scope.row.enabled ? '是' : '否' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="120">
          <template #default="scope">
            <el-button link type="primary" @click="openEdit(scope.row)">编辑</el-button>
            <el-button link type="danger" @click="remove(scope.row.id)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
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
          <div style="display:flex; gap: 8px; flex-wrap: wrap; align-items: center;">
            <el-popover placement="top-start" :width="560" trigger="click">
              <template #reference>
                <el-button size="small">钉钉 Webhook 获取</el-button>
              </template>
              <div style="font-size: 13px; line-height: 1.6;">
                <div style="font-weight: 700; margin-bottom: 6px;">钉钉自定义机器人 Webhook URL 获取（钉钉开放平台）</div>
                <ol style="padding-left: 18px; margin: 0;">
                  <li>打开钉钉，进入目标群聊（仅支持群聊）。</li>
                  <li>点击群聊右上角 → 设置图标 → 选择 群管理 → 机器人。</li>
                  <li>点击 添加机器人 → 选择 自定义。</li>
                  <li>填写机器人名称、上传头像，按需配置 安全设置（关键词/加签/IP 白名单）。</li>
                  <li>勾选协议，点击 完成。</li>
                  <li>生成后直接复制 Webhook 地址（格式：https://oapi.dingtalk.com/robot/send?access_token=xxx）</li>
                </ol>
                <div style="margin-top: 8px;">
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

            <el-popover placement="top-start" :width="560" trigger="click">
              <template #reference>
                <el-button size="small">企业微信 Webhook 获取</el-button>
              </template>
              <div style="font-size: 13px; line-height: 1.6;">
                <div style="font-weight: 700; margin-bottom: 6px;">企业微信自定义机器人 Webhook URL 获取</div>
                <ol style="padding-left: 18px; margin: 0;">
                  <li>打开企业微信，进入目标群聊。</li>
                  <li>点击群聊右上角 → 更多 → 选择 添加群机器人。</li>
                  <li>选择 新创建一个机器人。</li>
                  <li>填写机器人名称，点击 添加机器人。</li>
                  <li>生成后直接复制地址（格式：https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx）</li>
                </ol>
                <div style="margin-top: 8px;">
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
import { onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../api';
import { useListFetcher } from '../composables/useListFetcher';

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

const { loading, items, fetchList } = useListFetcher<SubscriptionDto>(async () => {
  const res = await api.get('/subscriptions', {
    params: {
      name: qName.value || undefined,
      username: qUsername.value || undefined,
    },
  });
  return res.data.items;
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
  name: '默认订阅',
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
    name: '默认订阅',
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
