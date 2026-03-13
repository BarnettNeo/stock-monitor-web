import { ref } from 'vue';

export function useListFetcher<T>(fetcher: () => Promise<T[]>) {
  const loading = ref(false);
  const items = ref<T[]>([]);

  async function fetchList() {
    loading.value = true;
    try {
      items.value = await fetcher();
    } finally {
      loading.value = false;
    }
  }

  return {
    loading,
    items,
    fetchList,
  };
}
