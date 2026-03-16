import { z } from 'zod';

export function nowIso(): string {
  return new Date().toISOString();
}

export function intToBool(v: any): boolean {
  return Number(v) === 1;
}

export function boolToInt(v: boolean): number {
  return v ? 1 : 0;
}

export function formatZodError(error: any): string {
  if (!error?.issues) return error?.message || 'Invalid input';

  const messages = error.issues.map((issue: any) => {
    const path = issue.path.join('.');
    const validation = issue.validation || issue.code;

    switch (validation) {
      case 'url':
        return `${path === 'webhookUrl' ? 'Webhook URL' : 'URL'} 格式不正确`;
      case 'min':
        if (path === 'name') return '名称不能为空';
        if (path === 'symbols') return '股票列表不能为空';
        if (path === 'intervalMs') return '扫描间隔必须 >= 1000ms';
        if (path === 'cooldownMinutes') return '冷却时间必须 >= 1 分钟';
        if (path === 'priceAlertPercent') return '涨跌幅阈值必须 >= 0.1%';
        return `${path} 太小`;
      case 'invalid_type':
        return `${path} 类型错误`;
      case 'invalid_string':
        if (issue.validation === 'url') return `${path === 'webhookUrl' ? 'Webhook URL' : 'URL'} 格式不正确`;
        return `${path} 字符串格式错误`;
      default:
        return `${path}: ${issue.message}`;
    }
  });

  return messages.join('; ');
}

export function handleApiError(error: any): { status: number; message: string } {
  if (error instanceof z.ZodError) {
    console.error('Validation error:', error);
    return { status: 400, message: formatZodError(error) };
  } else {
    console.error('API error:', error);
    return { status: 500, message: 'Internal Server Error' };
  }
}
