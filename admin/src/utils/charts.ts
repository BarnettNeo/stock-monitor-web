import * as echarts from 'echarts';

export function ensureChart(el: HTMLElement | null, chart: echarts.ECharts | null): echarts.ECharts | null {
  if (!el) return null;
  return chart || echarts.init(el);
}

export function setLineChart(chart: echarts.ECharts, opts: {
  x: any[];
  series: {
    name: string;
    y: any[];
    color: string;
  }[];
  grid?: any;
  tooltip?: any;
  legend?: any;
}) {
  const series = opts.series.map((s) => ({
    name: s.name,
    type: 'line',
    symbol: 'none',
    smooth: true,
    data: s.y,
    itemStyle: {
      color: s.color,
    },
  }));

  chart.setOption({
    grid: opts.grid || { left: 40, right: 10, top: 0, bottom: 0 },
    legend: opts.legend,
    xAxis: {
      type: 'category',
      data: opts.x,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: '#9ca3af',
      },
    },
    yAxis: {
      type: 'value',
      scale: true,
      splitLine: {
        lineStyle: {
          color: '#374151',
        },
      },
      axisLabel: {
        color: '#9ca3af',
      },
    },
    tooltip: opts.tooltip || { trigger: 'axis' },
    series,
    dataZoom: [{ type: 'inside', start: 0, end: 100 }]
  });
}

