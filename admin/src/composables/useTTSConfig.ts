/**
 * useTTSConfig — TTS 配置管理 Composable
 *
 * 职责：
 *   - 管理 TTS 配置（provider/voice/rate/lang）
 *   - localStorage 持久化
 *   - 按语言提供可用音色列表
 *   - 与 useTTS 解耦，配置层单独管理
 */

import { ref, watch } from 'vue';

export type TTSProvider = 'browser' | 'edge';
export type TTSLang = 'zh-CN' | 'en-US';

export interface TTSConfig {
  provider: TTSProvider;   // TTS 供应商
  voice: string;           // 音色名称
  rate: string;            // 语速 e.g. '+0%'
  lang: TTSLang;           // 合成语言
}

/** 按语言分类的 Edge-TTS 音色列表 */
export const EDGE_TTS_VOICES: Record<TTSLang, Array<{ value: string; label: string }>> = {
  'zh-CN': [
    { value: 'zh-CN-XiaoxiaoNeural', label: '晓晓（温柔女声）' },
    { value: 'zh-CN-YunxiNeural', label: '云希（活力男声）' },
    { value: 'zh-CN-YunyangNeural', label: '云扬（新闻男声）' },
    { value: 'zh-CN-XiaohanNeural', label: '晓涵（活力女声）' },
    { value: 'zh-CN-YunjianNeural', label: '云健（沉稳男声）' },
    { value: 'zh-CN-XiaomoNeural', label: '晓墨（温柔女声2）' },
  ],
  'en-US': [
    { value: 'en-US-JennyNeural', label: 'Jenny（Female）' },
    { value: 'en-US-GuyNeural', label: 'Guy（Male）' },
    { value: 'en-US-AriaNeural', label: 'Aria（Female 2）' },
    { value: 'en-US-DavisNeural', label: 'Davis（Male 2）' },
  ],
};

/** 浏览器内置 TTS 音色（按语言过滤） */
export const BROWSER_TTS_VOICES: Record<TTSLang, Array<{ value: string; label: string }>> = {
  'zh-CN': [
    { value: 'system', label: '系统默认' },
  ],
  'en-US': [
    { value: 'system', label: 'System Default' },
  ],
};

const STORAGE_KEY = 'agent_tts_config';

const DEFAULT_CONFIG: TTSConfig = {
  provider: 'browser',
  voice: 'system',
  rate: '+0%',
  lang: 'zh-CN',
};

export function useTTSConfig() {
  const config = ref<TTSConfig>({ ...DEFAULT_CONFIG });

  /** 从 localStorage 加载配置 */
  function load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          config.value = { ...DEFAULT_CONFIG, ...parsed };
        }
      }
    } catch { /* ignore */ }
  }

  /** 保存配置到 localStorage */
  function save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config.value));
    } catch { /* ignore */ }
  }

  /** 更新单个字段并自动保存 */
  function update<K extends keyof TTSConfig>(key: K, value: TTSConfig[K]): void {
    config.value[key] = value;

    // 切换语言时，重置音色为该语言的第一个可用音色
    if (key === 'lang') {
      const voices = getVoicesForProvider(config.value.provider, value as TTSLang);
      config.value.voice = voices[0]?.value || 'system';
    }

    // 切换供应商时，重置音色为该供应商当前语言的第一个可用音色
    if (key === 'provider') {
      const voices = getVoicesForProvider(value as TTSProvider, config.value.lang);
      config.value.voice = voices[0]?.value || 'system';
    }

    save();
  }

  /** 获取当前供应商+语言对应的音色列表 */
  function getVoicesForProvider(provider: TTSProvider, lang: TTSLang) {
    if (provider === 'edge') return EDGE_TTS_VOICES[lang] || [];
    return BROWSER_TTS_VOICES[lang] || [];
  }

  /** 当前可用音色列表 */
  function currentVoices() {
    return getVoicesForProvider(config.value.provider, config.value.lang);
  }

  /** 语速数值（用于 slider） */
  function rateValue(): number {
    return parseInt(config.value.rate.replace(/[+%]/g, '')) || 0;
  }

  /** 设置语速 */
  function setRate(v: number): void {
    config.value.rate = `${v >= 0 ? '+' : ''}${v}%`;
    save();
  }

  // 初始化时加载
  load();

  return {
    config,
    load,
    save,
    update,
    currentVoices,
    rateValue,
    setRate,
    EDGE_TTS_VOICES,
    BROWSER_TTS_VOICES,
  };
}
