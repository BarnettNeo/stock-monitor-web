export const openapiDoc = {
  openapi: '3.0.3',
  info: {
    title: 'Stock Monitor Server API',
    version: '0.1.0',
  },
  servers: [{ url: 'http://localhost:3001' }],
  paths: {
    '/api/health': {
      get: {
        summary: 'Health check',
        responses: {
          '200': {
            description: 'OK',
          },
        },
      },
    },
    '/api/strategies': {
      get: {
        summary: 'List strategies',
        responses: { '200': { description: 'OK' } },
      },
      post: {
        summary: 'Create strategy',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/strategies/{id}': {
      get: {
        summary: 'Get strategy by id',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'OK' } },
      },
      put: {
        summary: 'Update strategy',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        responses: { '200': { description: 'OK' } },
      },
      delete: {
        summary: 'Delete strategy',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/subscriptions': {
      get: {
        summary: 'List subscriptions',
        responses: { '200': { description: 'OK' } },
      },
      post: {
        summary: 'Create subscription',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/subscriptions/{id}': {
      get: {
        summary: 'Get subscription by id',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'OK' } },
      },
      put: {
        summary: 'Update subscription',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        responses: { '200': { description: 'OK' } },
      },
      delete: {
        summary: 'Delete subscription',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/trigger-logs': {
      get: {
        summary: 'List trigger logs',
        parameters: [
          { name: 'symbol', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'startDate', in: 'query', required: false, schema: { type: 'string', format: 'date' } },
          { name: 'endDate', in: 'query', required: false, schema: { type: 'string', format: 'date' } },
          { name: 'page', in: 'query', required: false, schema: { type: 'integer', minimum: 1 } },
          {
            name: 'pageSize',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 1, maximum: 100 },
          },
          {
            name: 'type',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['price', 'indicator', 'pattern'] },
          },
        ],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/trigger-logs/{id}': {
      get: {
        summary: 'Get trigger log detail',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/attribution-reports': {
      get: {
        summary: 'List attribution reports',
        parameters: [
          { name: 'triggerLogId', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'symbol', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100 } },
        ],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/attribution-reports/{id}': {
      get: {
        summary: 'Get attribution report detail',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/dashboard/screen': {
      get: {
        summary: 'Big screen dashboard overview',
        parameters: [{ name: 'since', in: 'query', required: false, schema: { type: 'string' } }],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/dashboard/hot-movers': {
      get: {
        summary: 'Hot movers (gainers/losers) by N-day return',
        parameters: [
          { name: 'windowDays', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 10 } },
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 50 } },
        ],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/quotes/kline': {
      get: {
        summary: 'Get KLine close series for a symbol',
        parameters: [
          { name: 'symbol', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'scale', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'datalen', in: 'query', required: false, schema: { type: 'integer', minimum: 10, maximum: 500 } },
        ],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/quotes/resolve': {
      get: {
        summary: 'Resolve Sina symbol by name',
        parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/users/me/package': {
      get: {
        summary: 'Get current user package info',
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/users/me/strategy/check': {
      post: {
        summary: 'Check create-strategy permission by package',
        requestBody: {
          required: false,
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        responses: { '200': { description: 'OK' } },
      },
    },
    '/openapi.json': {
      get: {
        summary: 'OpenAPI JSON',
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api-docs': {
      get: {
        summary: 'Swagger UI',
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/agent/chat': {
      // body 传 { "message": "你好" }
      post: {
        summary: 'Send chat message to agent',
        headers: {
          authorization: { schema: { type: 'string' } },
        },
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/voice/recordings': {
      get: {
        summary: 'List current user voice recordings',
        parameters: [
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100 } },
          { name: 'page', in: 'query', required: false, schema: { type: 'integer', minimum: 1 } },
          { name: 'q', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'OK' } },
      },
      post: {
        summary: 'Upload a voice recording blob',
        parameters: [
          { name: 'X-Voice-Duration-Ms', in: 'header', required: false, schema: { type: 'integer', minimum: 0 } },
          { name: 'X-Voice-File-Name', in: 'header', required: false, schema: { type: 'string' } },
          { name: 'X-Voice-Source', in: 'header', required: false, schema: { type: 'string' } },
          { name: 'X-Voice-Transcript', in: 'header', required: false, schema: { type: 'string' }, description: '语音识别文本' },
          { name: 'X-Voice-Llm-Reply', in: 'header', required: false, schema: { type: 'string' }, description: 'LLM 回复内容' },
        ],
        requestBody: {
          required: true,
          content: {
            'audio/webm': { schema: { type: 'string', format: 'binary' } },
            'audio/ogg': { schema: { type: 'string', format: 'binary' } },
            'audio/mp4': { schema: { type: 'string', format: 'binary' } },
            'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
          },
        },
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/voice/recordings/{id}': {
      get: {
        summary: 'Get voice recording metadata',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'OK' } },
      },
      delete: {
        summary: 'Delete a voice recording',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/voice/recordings/{id}/file': {
      get: {
        summary: 'Download or stream the voice recording file',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/voice/asr/providers': {
      get: {
        summary: 'List available ASR providers',
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/voice/asr/aliyun/config': {
      get: {
        summary: 'Get Aliyun ASR runtime config',
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/voice/asr/aliyun/token': {
      get: {
        summary: 'Get Aliyun ASR token',
        responses: { '200': { description: 'OK' } },
      },
    },
  },
} as const;
