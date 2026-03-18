import * as echarts from 'echarts';

export function ensureChart(el: HTMLElement | null, chart: echarts.ECharts | null): echarts.ECharts | null {
  if (!el) return null;
  return chart || echarts.init(el);
}

export function setLineChart(
  chart: echarts.ECharts,
  opts: {
    x: string[];
    y: Array<number | null | undefined>;
    color?: string;
    areaOpacity?: number;
    grid?: { left: number; right: number; top: number; bottom: number };
    yAxisScale?: boolean;
    axisLabelColor?: string;
  },
): void {
  chart.clear();
  chart.setOption(
    {
      backgroundColor: 'transparent',
      grid: opts.grid || { left: 40, right: 20, top: 20, bottom: 20 },
      xAxis: {
        type: 'category',
        data: opts.x,
        axisLabel: { color: opts.axisLabelColor || '#cbd5e1' },
        axisLine: { lineStyle: { color: '#334155' } },
      },
      yAxis: {
        type: 'value',
        scale: Boolean(opts.yAxisScale),
        axisLabel: { color: opts.axisLabelColor || '#cbd5e1' },
        splitLine: { lineStyle: { color: '#1f2937' } },
        axisLine: { lineStyle: { color: '#334155' } },
      },
      tooltip: { trigger: 'axis' },
      dataZoom: [{ type: 'inside', start: 0, end: 100 }],
      series: [
        {
          type: 'line',
          data: opts.y,
          smooth: true,
          areaStyle: opts.areaOpacity ? { opacity: opts.areaOpacity } : undefined,
          lineStyle: { width: 2, color: opts.color || '#60a5fa' },
          itemStyle: { color: opts.color || '#60a5fa' },
          symbol: 'circle',
          symbolSize: 6,
        },
      ],
    },
    { notMerge: true },
  );
}

