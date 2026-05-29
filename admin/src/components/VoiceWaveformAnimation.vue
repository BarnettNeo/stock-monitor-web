<template>
  <!-- 波形条动画 -->
  <div
    class="flex items-center justify-center gap-[3px] h-14"
    :class="className"
    aria-hidden="true"
  >
    <div
      v-for="i in barCount"
      :key="i"
      :ref="(el: any) => { if (el) setBarRef(el) }" 
      class="rounded-full"
      :style="{
        width: '3px',
        height: '8px',
        backgroundColor: color,
        opacity: 0.3,
        transition: 'height 0.05s ease-out, opacity 0.1s ease',
      }"
    ></div>
  </div>

  <!-- 呼吸光圈 PulseRing -->
  <div
    v-if="showPulseRing && active"
    class="relative flex items-center justify-center"
    :style="{ width: pulseSize + 'px', height: pulseSize + 'px' }"
  >
    <div
      class="absolute rounded-full animate-ping"
      :style="{
        width: pulseSize + 'px',
        height: pulseSize + 'px',
        backgroundColor: color,
        opacity: 0.2,
        animationDuration: '1.5s',
      }"
    />
    <div
      class="absolute rounded-full animate-ping"
      :style="{
        width: pulseSize * 0.7 + 'px',
        height: pulseSize * 0.7 + 'px',
        backgroundColor: color,
        opacity: 0.3,
        animationDuration: '1.5s',
        animationDelay: '0.3s',
      }"
    />
    <div
      class="relative rounded-full"
      :style="{
        width: pulseSize * 0.45 + 'px',
        height: pulseSize * 0.45 + 'px',
        backgroundColor: color,
        opacity: 0.9,
      }"
    />
  </div>

  <!-- 音量能量条 VolumeBar -->
  <div v-if="showVolumeBar" class="flex items-center gap-1" :class="className">
    <div
      v-for="i in 10"
      :key="'v' + i"
      class="rounded-sm transition-all duration-75"
      :class="getVolumeCellClass(i)"
      :style="{ width: '6px', height: 12 + i * 2 + 'px' }"
    ></div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';

const props = withDefaults(
  defineProps<{
    active?: boolean;
    volume?: number;
    barCount?: number;
    color?: string;
    className?: string;
    showPulseRing?: boolean;
    pulseSize?: number;
    showVolumeBar?: boolean;
  }>(),
  {
    active: false,
    volume: 0,
    barCount: 20,
    color: '#6366f1',
    className: '',
    showPulseRing: false,
    pulseSize: 80,
    showVolumeBar: true,
  },
);

// ── 波形条动画 (requestAnimationFrame 驱动，完全复刻 React 版) ──
const barElements: HTMLElement[] = [];
let animFrameId = 0;

function setBarRef(el: Element | null) {
  if (el) {
    const idx = barElements.length;
    barElements[idx] = el as HTMLElement;
  }
}

onMounted(() => {
  const animate = () => {
    barElements.forEach((bar, i) => {
      if (!bar) return;
      if (!props.active) {
        bar.style.height = '4px';
        bar.style.opacity = '0.3';
        return;
      }
      // 根据音量和位置计算高度，加入随机扰动使波形更自然
      const baseHeight = Math.max(4, props.volume * 80);
      const wave = Math.sin(Date.now() / 200 + i * 0.8) * 0.4 + 0.6;
      const noise = Math.random() * 0.2 + 0.9;
      const heightPx = Math.min(64, baseHeight * wave * noise);
      bar.style.height = `${heightPx}px`;
      bar.style.opacity = `${Math.min(1, 0.4 + props.volume * 1.5)}`;
    });
    animFrameId = requestAnimationFrame(animate);
  };
  animate();
});

onUnmounted(() => {
  if (animFrameId) cancelAnimationFrame(animFrameId);
});

// ── 音量能量条颜色 ──
function getVolumeCellClass(index: number): Record<string, boolean> {
  const threshold = index / 10;
  const isLit = props.volume > threshold;
  const colorClass = index < 7 ? 'bg-emerald-400' : index < 9 ? 'bg-yellow-400' : 'bg-red-400';
  return {
    [colorClass]: isLit,
    'bg-gray-200': !isLit,
  };
}
</script>
