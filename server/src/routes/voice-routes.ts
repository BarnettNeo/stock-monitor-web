import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WebSocket } from 'ws';

import type { Express, Request, Response } from 'express';
import express from 'express';
import axios from 'axios';
import { z } from 'zod';

import { requireAuth } from '../auth';
import { execute, query, queryOne } from '../db';
import { nowIso } from '../utils';

const UploadHeadersSchema = z.object({
  durationMs: z.number().int().nonnegative().optional(),
  source: z.string().max(64).optional(),
  fileName: z.string().max(255).optional(),
  transcript: z.string().optional(),
  llmReply: z.string().optional(),
});

const ListRecordingsQuerySchema = z.object({
  limit: z
    .string()
    .optional()
    .transform((value) => (value ? Number.parseInt(value, 10) : 20))
    .pipe(z.number().int().min(1).max(100)),
  page: z
    .string()
    .optional()
    .transform((value) => (value ? Number.parseInt(value, 10) : 1))
    .pipe(z.number().int().min(1)),
  q: z.string().trim().max(200).optional().transform((value) => value || ''),
});

const AsrProviderIdSchema = z.enum(['browser', 'aliyun']);

type AliyunAsrConfig = {
  region: string;
  appkey: string;
  accessKeyId: string;
  accessKeySecret: string;
  gatewayUrl: string;
  metaUrl: string;
  sampleRate: number;
  maxSentenceSilence: number;
  enableIntermediateResult: boolean;
  enablePunctuationPrediction: boolean;
  enableInverseTextNormalization: boolean;
};

type TokenCache = {
  token: string;
  expireTime: number;
  cachedAt: number;
};

const DATA_ROOT = path.resolve(__dirname, '../../data');
const VOICE_ROOT = path.join(DATA_ROOT, 'voice-recordings');
const TOKEN_REFRESH_SKEW_SECONDS = 300;
let aliyunTokenCache: TokenCache | null = null;

function decodeHeaderValue(value: string): string {
  if (!value) return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function getFileExtFromMimeType(mimeType: string): string {
  const type = String(mimeType || '').toLowerCase();
  if (type.includes('webm')) return 'webm';
  if (type.includes('ogg')) return 'ogg';
  if (type.includes('wav')) return 'wav';
  if (type.includes('mp4') || type.includes('m4a')) return 'm4a';
  return 'bin';
}

function sanitizeFileName(name: string): string {
  const cleaned = String(name || '')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 120);
  return cleaned || 'voice-recording';
}

function parseDurationMs(raw: unknown): number | undefined {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.floor(n);
}

function percentEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/\!/g, '%21')
    .replace(/\*/g, '%2A')
    .replace(/\'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');
}

function buildAliyunAsrConfig(): AliyunAsrConfig | null {
  const accessKeyId = String(process.env.ALIYUN_NLS_ACCESS_KEY_ID || '').trim();
  const accessKeySecret = String(process.env.ALIYUN_NLS_ACCESS_KEY_SECRET || '').trim();
  const appkey = String(process.env.ALIYUN_NLS_APPKEY || '').trim();
  if (!accessKeyId || !accessKeySecret || !appkey) return null;

  const region = String(process.env.ALIYUN_NLS_REGION || 'cn-shanghai').trim() || 'cn-shanghai';
  const gatewayUrl =
    String(process.env.ALIYUN_NLS_WS_URL || '').trim() ||
    `wss://nls-gateway.${region}.aliyuncs.com/ws/v1`;
  const metaUrl =
    String(process.env.ALIYUN_NLS_META_URL || '').trim() ||
    `https://nls-meta.${region}.aliyuncs.com/`;

  return {
    region,
    appkey,
    accessKeyId,
    accessKeySecret,
    gatewayUrl,
    metaUrl,
    sampleRate: Number(process.env.ALIYUN_NLS_SAMPLE_RATE || 16000),
    maxSentenceSilence: Number(process.env.ALIYUN_NLS_MAX_SENTENCE_SILENCE || 800),
    enableIntermediateResult: String(process.env.ALIYUN_NLS_ENABLE_INTERMEDIATE_RESULT || 'true').trim() !== 'false',
    enablePunctuationPrediction: String(process.env.ALIYUN_NLS_ENABLE_PUNCTUATION_PREDICTION || 'true').trim() !== 'false',
    enableInverseTextNormalization: String(process.env.ALIYUN_NLS_ENABLE_ITN || 'true').trim() !== 'false',
  };
}

function getConfiguredVoiceAsrProvider(): 'browser' | 'aliyun' {
  const provider = String(process.env.VOICE_ASR_PROVIDER || '').trim().toLowerCase();
  if (provider === 'aliyun' && buildAliyunAsrConfig()) return 'aliyun';
  return 'browser';
}

function createAliyunTokenRequestUrl(config: AliyunAsrConfig): string {
  const params: Record<string, string> = {
    AccessKeyId: config.accessKeyId,
    Action: 'CreateToken',
    Format: 'JSON',
    RegionId: config.region,
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: crypto.randomUUID(),
    SignatureVersion: '1.0',
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    Version: '2019-02-28',
  };

  const canonicalizedQueryString = Object.keys(params)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(params[key])}`)
    .join('&');
  const stringToSign = `GET&${percentEncode('/')}&${percentEncode(canonicalizedQueryString)}`;
  const secret = `${config.accessKeySecret}&`;
  const signature = crypto.createHmac('sha1', secret).update(stringToSign).digest('base64');

  return `${config.metaUrl}?${canonicalizedQueryString}&Signature=${percentEncode(signature)}`;
}

async function fetchAliyunNlsToken(forceRefresh = false): Promise<TokenCache> {
  const config = buildAliyunAsrConfig();
  if (!config) {
    throw new Error('阿里云 ASR 未配置，请填写 ALIYUN_NLS_ACCESS_KEY_ID / ALIYUN_NLS_ACCESS_KEY_SECRET / ALIYUN_NLS_APPKEY');
  }

  const now = Math.floor(Date.now() / 1000);
  if (!forceRefresh && aliyunTokenCache && aliyunTokenCache.expireTime - TOKEN_REFRESH_SKEW_SECONDS > now) {
    return aliyunTokenCache;
  }

  const url = createAliyunTokenRequestUrl(config);
  const response = await axios.get(url, { timeout: 15000 });
  const tokenId = String(response.data?.Token?.Id || '').trim();
  const expireTime = Number(response.data?.Token?.ExpireTime || 0);

  if (!tokenId || !Number.isFinite(expireTime)) {
    throw new Error('阿里云 ASR Token 响应无效');
  }

  aliyunTokenCache = {
    token: tokenId,
    expireTime: Math.floor(expireTime),
    cachedAt: Date.now(),
  };
  return aliyunTokenCache;
}

async function ensureVoiceRoot(): Promise<void> {
  await fs.mkdir(VOICE_ROOT, { recursive: true });
}

function buildStoragePath(id: string, mimeType: string, createdAt: string): { absolutePath: string; relativePath: string } {
  const date = new Date(createdAt);
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const ext = getFileExtFromMimeType(mimeType);
  const relativePath = path.join('voice-recordings', year, month, day, `${id}.${ext}`);
  return {
    absolutePath: path.join(DATA_ROOT, relativePath),
    relativePath,
  };
}

function toPublicVoiceRecording(row: any): any {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    originalName: row.original_name || null,
    mimeType: String(row.mime_type),
    fileExt: String(row.file_ext),
    sizeBytes: Number(row.size_bytes || 0),
    durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
    sha256: String(row.sha256),
    status: String(row.status || 'stored'),
    source: row.source || null,
    transcript: row.transcript || null,
    llmReply: row.llm_reply || null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    downloadUrl: `/api/voice/recordings/${encodeURIComponent(String(row.id))}/file`,
  };
}

async function saveVoiceRecording(req: Request, res: Response): Promise<void> {
  const user = await requireAuth(req, res);
  if (!user) return;

  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);
  if (!body.length) {
    res.status(400).json({ message: '录音内容不能为空' });
    return;
  }

  const mimeType = String(req.headers['content-type'] || 'application/octet-stream').trim() || 'application/octet-stream';
  const headers = UploadHeadersSchema.parse({
    durationMs: parseDurationMs(req.headers['x-voice-duration-ms']),
    source: String(req.headers['x-voice-source'] || '').trim() || undefined,
    fileName: decodeHeaderValue(String(req.headers['x-voice-file-name'] || '')),
    transcript: decodeHeaderValue(String(req.headers['x-voice-transcript'] || '')),
    llmReply: decodeHeaderValue(String(req.headers['x-voice-llm-reply'] || '')),
  });
  const createdAt = nowIso();
  const id = crypto.randomUUID();
  const { absolutePath, relativePath } = buildStoragePath(id, mimeType, createdAt);
  const originalName = headers.fileName ? sanitizeFileName(headers.fileName) : null;
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  const ext = path.extname(absolutePath).replace(/^\./, '') || getFileExtFromMimeType(mimeType);

  await ensureVoiceRoot();
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, body);

  await execute(
    `INSERT INTO voice_recordings (
      id,user_id,original_name,mime_type,file_ext,size_bytes,duration_ms,sha256,storage_path,status,source,transcript,llm_reply,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      user.userId,
      originalName,
      mimeType,
      ext,
      body.length,
      headers.durationMs ?? null,
      sha256,
      relativePath,
      'stored',
      headers.source || 'agent-chat',
      headers.transcript || null,
      headers.llmReply || null,
      createdAt,
      createdAt,
    ],
  );

  res.json({
    ok: true,
    recording: {
      id,
      originalName,
      mimeType,
      fileExt: ext,
      sizeBytes: body.length,
      durationMs: headers.durationMs ?? null,
      sha256,
      status: 'stored',
      source: headers.source || 'agent-chat',
      transcript: headers.transcript || null,
      llmReply: headers.llmReply || null,
      storagePath: relativePath,
      downloadUrl: `/api/voice/recordings/${encodeURIComponent(id)}/file`,
      createdAt,
      updatedAt: createdAt,
    },
  });
}

async function listVoiceRecordings(req: Request, res: Response): Promise<void> {
  const user = await requireAuth(req, res);
  if (!user) return;

  const parsed = ListRecordingsQuerySchema.parse({
    limit: Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit,
    page: Array.isArray(req.query.page) ? req.query.page[0] : req.query.page,
    q: Array.isArray(req.query.q) ? req.query.q[0] : req.query.q,
  });

  const searchTerm = parsed.q.trim();
  const whereClauses = ['user_id = ?'];
  const params: any[] = [user.userId];

  if (searchTerm) {
    const like = `%${searchTerm.replace(/[\\%_]/g, '\\$&')}%`;
    whereClauses.push('(original_name LIKE ? ESCAPE \'\\\' OR source LIKE ? ESCAPE \'\\\' OR mime_type LIKE ? ESCAPE \'\\\' OR id LIKE ? OR transcript LIKE ? ESCAPE \'\\\' OR llm_reply LIKE ? ESCAPE \'\\\')');
    params.push(like, like, like, like, like, like);
  }

  const totalRows = await queryOne<{ total: number }>(
    `SELECT COUNT(1) AS total FROM voice_recordings WHERE ${whereClauses.join(' AND ')}`,
    params,
  );
  const total = Number(totalRows?.total || 0);
  const offset = (parsed.page - 1) * parsed.limit;
  const rows = await query<any>(
    `SELECT * FROM voice_recordings WHERE ${whereClauses.join(' AND ')} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, parsed.limit, offset],
  );

  res.json({
    ok: true,
    items: rows.map(toPublicVoiceRecording),
    pagination: {
      page: parsed.page,
      pageSize: parsed.limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / parsed.limit),
      query: searchTerm,
    },
  });
}

async function deleteVoiceRecording(req: Request, res: Response): Promise<void> {
  const user = await requireAuth(req, res);
  if (!user) return;

  const id = String(req.params.id || '').trim();
  if (!id) {
    res.status(400).json({ message: 'recording id 不能为空' });
    return;
  }

  const row = await queryOne<any>(
    `SELECT * FROM voice_recordings WHERE id = ? AND user_id = ? LIMIT 1`,
    [id, user.userId],
  );
  if (!row) {
    res.status(404).json({ message: '录音不存在' });
    return;
  }

  const relativePath = String(row.storage_path || '').trim();
  const absolutePath = path.join(DATA_ROOT, relativePath);

  try {
    await fs.unlink(absolutePath);
  } catch {
    // ignore: metadata deletion should still succeed when file is gone
  }

  await execute(`DELETE FROM voice_recordings WHERE id = ? AND user_id = ?`, [id, user.userId]);
  res.json({ ok: true });
}

async function getVoiceRecording(req: Request, res: Response): Promise<void> {
  const user = await requireAuth(req, res);
  if (!user) return;

  const id = String(req.params.id || '').trim();
  if (!id) {
    res.status(400).json({ message: 'recording id 不能为空' });
    return;
  }

  const row = await queryOne<any>(
    `SELECT * FROM voice_recordings WHERE id = ? AND user_id = ? LIMIT 1`,
    [id, user.userId],
  );
  if (!row) {
    res.status(404).json({ message: '录音不存在' });
    return;
  }

  res.json({ ok: true, recording: toPublicVoiceRecording(row) });
}

async function streamVoiceRecordingFile(req: Request, res: Response): Promise<void> {
  const user = await requireAuth(req, res);
  if (!user) return;

  const id = String(req.params.id || '').trim();
  if (!id) {
    res.status(400).json({ message: 'recording id 不能为空' });
    return;
  }

  const row = await queryOne<any>(
    `SELECT * FROM voice_recordings WHERE id = ? AND user_id = ? LIMIT 1`,
    [id, user.userId],
  );
  if (!row) {
    res.status(404).json({ message: '录音不存在' });
    return;
  }

  const relativePath = String(row.storage_path || '').trim();
  const absolutePath = path.join(DATA_ROOT, relativePath);

  try {
    await fs.access(absolutePath);
  } catch {
    res.status(404).json({ message: '录音文件已丢失' });
    return;
  }

  res.setHeader('Content-Type', String(row.mime_type || 'application/octet-stream'));
  res.sendFile(absolutePath);
}

async function getVoiceAsrProviders(req: Request, res: Response): Promise<void> {
  const user = await requireAuth(req, res);
  if (!user) return;

  const aliConfig = buildAliyunAsrConfig();
  res.json({
    ok: true,
    defaultProvider: getConfiguredVoiceAsrProvider(),
    providers: [
      {
        id: 'browser',
        name: '浏览器内置',
        enabled: true,
        realtime: true,
        description: '基于 Web Speech API 的本地实时识别，适合作为无配置兜底方案。',
      },
      {
        id: 'aliyun',
        name: '阿里云 NLS',
        enabled: Boolean(aliConfig),
        realtime: true,
        description: '通过 NLS WebSocket 实时流式 ASR，支持中间结果与断句。',
        configRequired: [
          'ALIYUN_NLS_ACCESS_KEY_ID',
          'ALIYUN_NLS_ACCESS_KEY_SECRET',
          'ALIYUN_NLS_APPKEY',
        ],
      },
    ],
  });
}

async function getAliyunAsrConfig(req: Request, res: Response): Promise<void> {
  const user = await requireAuth(req, res);
  if (!user) return;

  const config = buildAliyunAsrConfig();
  if (!config) {
    res.status(400).json({
      ok: false,
      message: '阿里云 ASR 未配置，请在环境变量中填写 ALIYUN_NLS_ACCESS_KEY_ID / ALIYUN_NLS_ACCESS_KEY_SECRET / ALIYUN_NLS_APPKEY',
    });
    return;
  }

  res.json({
    ok: true,
    provider: 'aliyun',
    config: {
      region: config.region,
      appkey: config.appkey,
      gatewayUrl: config.gatewayUrl,
      sampleRate: config.sampleRate,
      maxSentenceSilence: config.maxSentenceSilence,
      enableIntermediateResult: config.enableIntermediateResult,
      enablePunctuationPrediction: config.enablePunctuationPrediction,
      enableInverseTextNormalization: config.enableInverseTextNormalization,
    },
  });
}

async function getAliyunAsrToken(req: Request, res: Response): Promise<void> {
  const user = await requireAuth(req, res);
  if (!user) return;

  try {
    const token = await fetchAliyunNlsToken();
    res.json({
      ok: true,
      token: token.token,
      expireTime: token.expireTime,
      cachedAt: token.cachedAt,
    });
  } catch (error: any) {
    res.status(400).json({ ok: false, message: error?.message || '获取阿里云 ASR Token 失败' });
  }
}

// ── Edge-TTS 语音合成（WebSocket 直推，无文件中转）──────────────

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const WINDOWS_FILE_TIME_EPOCH = 11644473600n;

function generateSecMsGecToken(): string {
  const ticks = BigInt(Math.floor(Date.now() / 1000) + Number(WINDOWS_FILE_TIME_EPOCH)) * 10000000n;
  const rounded = ticks - (ticks % 3000000000n);
  return crypto.createHash('sha256').update(`${rounded}${TRUSTED_CLIENT_TOKEN}`, 'ascii').digest('hex').toUpperCase();
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]!));
}

const TTSRequestBodySchema = z.object({
  text: z.string().min(1).max(5000),
  voice: z.string().optional().default('zh-CN-XiaoxiaoNeural'),
  lang: z.enum(['zh-CN', 'en-US']).optional().default('zh-CN'),
  rate: z.string().optional().default('+0%'),
});

async function synthesizeWithEdgeTTS(req: Request, res: Response): Promise<void> {
  const user = await requireAuth(req, res);
  if (!user) return;

  const parsed = TTSRequestBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, message: '参数错误：text 为必填（1-5000 字符）' });
    return;
  }

  const { text, voice, lang, rate } = parsed.data;

  const rateNum = parseInt(rate.replace(/[+%]/g, '')) || 0;
  const rateStr = rateNum === 0 ? 'default' : (rateNum > 0 ? `+${rateNum}%` : `${rateNum}%`);
  const outputFormat = 'audio-24khz-48kbitrate-mono-mp3';
  const wsUrl = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${generateSecMsGecToken()}&Sec-MS-GEC-Version=1-${CHROMIUM_FULL_VERSION}`;

  const muid = crypto.randomBytes(16).toString('hex').toUpperCase();

  const ws = new WebSocket(wsUrl, {
    host: 'speech.platform.bing.com',
    origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
    headers: {
      'Pragma': 'no-cache',
      'Cache-Control': 'no-cache',
      'Cookie': `muid=${muid};`,
      'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_FULL_VERSION.split('.')[0]}.0.0.0 Safari/537.36 Edg/${CHROMIUM_FULL_VERSION.split('.')[0]}.0.0.0`,
      'Accept-Encoding': 'gzip, deflate, br, zstd',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Transfer-Encoding', 'chunked');

  const timeout = setTimeout(() => {
    ws.close();
    if (!res.headersSent) {
      res.status(500).json({ ok: false, message: 'Edge-TTS 合成超时' });
    } else {
      res.end();
    }
  }, 30000);

  ws.on('open', () => {
    ws.send(`Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n
      {"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"${outputFormat}"}}}}`);

    const requestId = crypto.randomBytes(16).toString('hex');
    ws.send(`X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n
      <speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${lang}">
        <voice name="${voice}">
          <prosody rate="${rateStr}">
            ${escapeXml(text)}
          </prosody>
        </voice>
      </speak>`);
  });

  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      const sep = 'Path:audio\r\n';
      const idx = data.indexOf(sep);
      if (idx >= 0) {
        const audioChunk = data.subarray(idx + sep.length);
        res.write(audioChunk);
      }
    } else {
      const msg = data.toString();
      if (msg.includes('Path:turn.end')) {
        clearTimeout(timeout);
        ws.close();
        res.end();
      }
    }
  });

  ws.on('error', (err) => {
    clearTimeout(timeout);
    console.error('[EdgeTTS] WebSocket error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ ok: false, message: `Edge-TTS 合成失败: ${err.message}` });
    } else {
      res.end();
    }
  });
}

export function registerVoiceRoutes(app: Express): void {
  app.post(
    '/api/voice/recordings',
    express.raw({ type: '*/*', limit: '20mb' }),
    saveVoiceRecording,
  );
  app.get('/api/voice/recordings', listVoiceRecordings);
  app.get('/api/voice/recordings/:id', getVoiceRecording);
  app.get('/api/voice/recordings/:id/file', streamVoiceRecordingFile);
  app.delete('/api/voice/recordings/:id', deleteVoiceRecording);
  app.get('/api/voice/asr/providers', getVoiceAsrProviders);
  app.get('/api/voice/asr/aliyun/config', getAliyunAsrConfig);
  app.get('/api/voice/asr/aliyun/token', getAliyunAsrToken);
  app.post('/api/voice/tts', express.json(), synthesizeWithEdgeTTS);
}
