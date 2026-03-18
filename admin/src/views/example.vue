<template>
  <div class="diagnostic-container">
    <!-- 面包屑导航 (符合二级页面定位) -->
    <el-breadcrumb separator="/" class="breadcrumb">
      <el-breadcrumb-item :to="{ path: '/triggers' }">触发日志</el-breadcrumb-item>
      <el-breadcrumb-item>异动诊断详情</el-breadcrumb-item>
    </el-breadcrumb>

    <!-- 顶部操作栏 -->
    <div class="header">
      <h2 class="title">
        <el-tag type="warning" size="large" effect="dark" class="type-tag">
          {{ diagnosticData?.triggerType || 'MACD金叉' }}
        </el-tag>
        {{ diagnosticData?.stockName }} ({{ diagnosticData?.stockCode }})
      </h2>
      <el-button type="primary" @click="goBack">
        <el-icon><ArrowLeft /></el-icon> 返回触发日志
      </el-button>
    </div>

    <!-- 核心诊断区域 -->
    <el-card shadow="never" class="diagnostic-card">
      <!-- 加载状态 -->
      <template v-if="loading">
        <div class="loading">
          <el-skeleton :rows="6" animated />
        </div>
      </template>

      <!-- 错误状态 -->
      <template v-else-if="error">
        <el-alert 
          type="error" 
          :title="`数据加载失败 (ID: ${triggerId})`" 
          :description="error" 
          show-icon 
        />
      </template>

      <!-- 诊断内容 -->
      <template v-else>
        <!-- 时间轴 & 基础指标 -->
        <div class="base-info">
          <div class="time">
            <el-icon><Clock /></el-icon>
            {{ formatTime(diagnosticData.triggerTime) }}
          </div>
          <div class="status">
            <el-tag :type="diagnosticData.pushStatus === 'success' ? 'success' : 'danger'">
              {{ diagnosticData.pushStatus === 'success' ? '推送成功' : '推送失败' }}
            </el-tag>
          </div>
        </div>

        <!-- 双栏布局：图表 + 诊断结论 -->
        <div class="content-grid">
          <!-- ECharts 可视化区域 -->
          <div class="chart-section">
            <h3 class="section-title">价格异动分析</h3>
            <div ref="chartRef" class="chart" />
          </div>

          <!-- 诊断结论卡片 -->
          <div class="conclusion-section">
            <h3 class="section-title">AI 诊断结论</h3>
            <el-card class="conclusion-card" shadow="hover">
              <div class="conclusion-content">
                <p class="conclusion-text">
                  <strong>异动强度：</strong>
                  <el-rate 
                    v-model="diagnosticData.intensity" 
                    disabled 
                    :max="5" 
                    text-color="#f7ba2a"
                  />
                </p>
                <p class="conclusion-text">
                  <strong>可信度：</strong>
                  <el-progress 
                    :percentage="diagnosticData.confidence * 100" 
                    :color="progressColor" 
                    :show-text="false"
                  />
                  <span class="confidence-text">{{ (diagnosticData.confidence * 100).toFixed(0) }}%</span>
                </p>
                <p class="conclusion-text">
                  <strong>触发原因：</strong>
                  {{ diagnosticData.reason || 'MACD双线在0轴上方形成金叉，短期动能增强' }}
                </p>
                <p class="conclusion-text">
                  <strong>操作建议：</strong>
                  <el-tag type="success" effect="light">逢低布局</el-tag>
                  {{ diagnosticData.suggestion || '关注5分钟K线回踩不破支撑位' }}
                </p>
              </div>
            </el-card>
          </div>
        </div>

        <!-- 详细数据表格 -->
        <div class="data-table">
          <h3 class="section-title">异动时刻关键指标</h3>
          <el-table :data="diagnosticData.indicators" border>
            <el-table-column prop="name" label="指标名称" width="180" />
            <el-table-column prop="value" label="当前值" width="120" align="right">
              <template #default="{ row }">
                {{ formatValue(row.value, row.unit) }}
              </template>
            </el-table-column>
            <el-table-column prop="unit" label="单位" width="80" />
            <el-table-column prop="status" label="状态" width="100">
              <template #default="{ row }">
                <el-tag :type="row.status === 'warning' ? 'danger' : 'success'">
                  {{ row.status === 'warning' ? '预警' : '正常' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="comment" label="解读" />
          </el-table>
        </div>
      </template>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, computed, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import * as echarts from 'echarts'
import type { EChartsOption } from 'echarts'
import { ArrowLeft, Clock } from '@element-plus/icons-vue'

// 路由与导航
const route = useRoute()
const router = useRouter()
const triggerId = route.params.triggerId as string

// 数据状态
const loading = ref(true)
const error = ref('')
const chartRef = ref<HTMLElement | null>(null)
const chartInstance = ref<echarts.ECharts | null>(null)

// 诊断数据结构 (根据实际API调整)
interface DiagnosticData {
  stockCode: string
  stockName: string
  triggerType: string
  triggerTime: string
  pushStatus: 'success' | 'failed'
  intensity: number
  confidence: number
  reason: string
  suggestion: string
  indicators: Array<{
    name: string
    value: number
    unit: string
    status: 'warning' | 'normal'
    comment: string
  }>
}

const diagnosticData = ref<DiagnosticData | null>(null)

// 计算进度条颜色
const progressColor = computed(() => {
  const conf = diagnosticData.value?.confidence || 0
  if (conf > 0.7) return '#67C23A' // 绿色
  if (conf > 0.4) return '#E6A23C' // 橙色
  return '#F56C6C' // 红色
})

// 返回触发日志列表
const goBack = () => {
  router.push('/triggers')
}

// 时间格式化
const formatTime = (timestamp: string) => {
  return new Date(timestamp).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).replace(/\//g, '-')
}

// 数值格式化
const formatValue = (value: number, unit: string) => {
  if (unit === '%') return (value * 100).toFixed(2) + '%'
  return value.toFixed(2)
}

// 模拟API请求 (替换为真实API)
const fetchDiagnosticData = async () => {
  try {
    loading.value = true
    // 实际项目替换为：const { data } = await api.getTriggerDetail(triggerId)
    await new Promise(resolve => setTimeout(resolve, 800)) // 模拟延迟
    
    // 模拟数据 (根据实际业务调整)
    diagnosticData.value = {
      stockCode: '600519',
      stockName: '贵州茅台',
      triggerType: 'MACD金叉',
      triggerTime: '2026-03-14T10:30:00',
      pushStatus: 'success',
      intensity: 4,
      confidence: 0.85,
      reason: 'MACD双线在0轴上方形成金叉，短期动能增强',
      suggestion: '关注5分钟K线回踩不破支撑位',
      indicators: [
        { name: 'MACD', value: 0.45, unit: '', status: 'warning', comment: 'DIFF:0.32 > DEA:0.28' },
        { name: '成交量', value: 15.8, unit: '万手', status: 'normal', comment: '较前5日均量放大120%' },
        { name: 'RSI', value: 62, unit: '%', status: 'normal', comment: '处于健康区间(30-70)' },
        { name: '布林带', value: 1845.5, unit: '元', status: 'warning', comment: '价格突破上轨+2.3%' }
      ]
    }
    
    // 初始化图表
    initChart()
  } catch (err) {
    error.value = '诊断数据加载失败，请检查网络或联系管理员'
    console.error('诊断数据获取失败:', err)
  } finally {
    loading.value = false
  }
}

// 初始化ECharts
const initChart = () => {
  if (!chartRef.value || !diagnosticData.value) return
  
  // 销毁已有实例
  if (chartInstance.value) {
    chartInstance.value.dispose()
  }
  
  chartInstance.value = echarts.init(chartRef.value)
  
  // 模拟K线数据 (替换为真实数据)
  const kData = [
    [1820.5, 1835.0, 1815.0, 1840.0],
    [1835.0, 1842.0, 1830.0, 1845.0],
    [1842.0, 1850.0, 1838.0, 1855.0],
    [1850.0, 1848.0, 1842.0, 1852.0],
    [1848.0, 1845.0, 1840.0, 1850.0],
    [1845.0, 1842.0, 1835.0, 1848.0],
    [1842.0, 1838.0, 1830.0, 1845.0],
    [1838.0, 1840.0, 1832.0, 1842.0],
    [1840.0, 1845.0, 1835.0, 1850.0],
    [1845.0, 1852.0, 1840.0, 1855.0] // 触发点
  ]
  
  const option: EChartsOption = {
    tooltip: {
      trigger: 'axis',
      formatter: (params) => {
        const data = params[0].data
        return `价格: ${data[3].toFixed(2)}<br/>开盘: ${data[0]}  高: ${data[2]}<br/>低: ${data[1]}  收: ${data[3]}`
      }
    },
    grid: { top: 20, right: 30, bottom: 30, left: 50 },
    xAxis: {
      type: 'category',
      data: Array.from({ length: 10 }, (_, i) => `10:${20+i}`),
      axisLine: { lineStyle: { color: '#666' } }
    },
    yAxis: { type: 'value', name: '价格(元)', scale: true },
    series: [{
      type: 'candlestick',
      data: kData,
      itemStyle: {
        color: '#ef232a',
        color0: '#14b143',
        borderColor: '#ef232a',
        borderColor0: '#14b143'
      }
    }],
    // 在触发点添加标记
    graphic: [{
      type: 'text',
      right: 30,
      bottom: 20,
      style: {
        text: '异动触发点 →',
        fontSize: 14,
        fontWeight: 'bold',
        fill: '#ff4949'
      }
    }]
  }
  
  chartInstance.value.setOption(option)
}

// 响应式调整
const resizeChart = () => {
  chartInstance.value?.resize()
}

// 生命周期
onMounted(() => {
  if (!triggerId) {
    error.value = '无效的诊断ID，请通过触发日志页面进入'
    loading.value = false
    return
  }
  
  fetchDiagnosticData()
  
  // 监听窗口大小变化
  window.addEventListener('resize', resizeChart)
})

onBeforeUnmount(() => {
  // 清理事件监听
  window.removeEventListener('resize', resizeChart)
  // 销毁图表实例
  chartInstance.value?.dispose()
})
</script>

<style scoped lang="scss">
.diagnostic-container {
  max-width: 1400px;
  margin: 0 auto;
  padding: 20px;
  
  .breadcrumb {
    margin-bottom: 15px;
  }
  
  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 20px;
    
    .title {
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 24px;
      color: #303133;
      
      .type-tag {
        font-size: 18px;
        padding: 5px 10px;
      }
    }
  }
  
  .diagnostic-card {
    border-radius: 8px;
    
    .base-info {
      display: flex;
      gap: 20px;
      color: #606266;
      margin-bottom: 25px;
      padding-bottom: 15px;
      border-bottom: 1px dashed #ebeef5;
      
      .time, .status {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 16px;
      }
    }
    
    .content-grid {
      display: grid;
      grid-template-columns: 1fr 400px;
      gap: 25px;
      margin-bottom: 30px;
      
      .chart-section, .conclusion-section {
        .section-title {
          font-size: 18px;
          margin-bottom: 15px;
          color: #303133;
          position: relative;
          
          &::after {
            content: '';
            position: absolute;
            left: 0;
            bottom: -5px;
            width: 40px;
            height: 3px;
            background: #409eff;
            border-radius: 2px;
          }
        }
      }
      
      .chart {
        width: 100%;
        height: 300px;
        background: #f8f9fa;
        border-radius: 4px;
        border: 1px solid #ebeef5;
      }
      
      .conclusion-card {
        border-left: 4px solid #409eff;
        
        .conclusion-content {
          .conclusion-text {
            line-height: 1.8;
            margin-bottom: 12px;
            padding-left: 10px;
            border-left: 2px solid #ebeef5;
            
            .confidence-text {
              display: inline-block;
              width: 50px;
              text-align: right;
              margin-left: 8px;
              color: #303133;
              font-weight: bold;
            }
          }
        }
      }
    }
    
    .data-table {
      :deep(.el-table) {
        th {
          background-color: #f5f7fa !important;
        }
      }
    }
    
    .loading {
      padding: 40px 0;
    }
  }
}
</style>
