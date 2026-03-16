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
  },
} as const;
