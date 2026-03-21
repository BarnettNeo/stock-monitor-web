type SqlParam = any;

export type SqlWhereBuilder = {
  clauses: string[];
  params: SqlParam[];
};

// 创建 SQL 条件构建器
export function createWhereBuilder(seed = '1=1'): SqlWhereBuilder {
  return { clauses: [seed], params: [] };
}

// 添加 SQL 条件（单个）
export function addClause(
  builder: SqlWhereBuilder,
  clause: string,
  ...params: SqlParam[]
): void {
  builder.clauses.push(clause);
  if (params.length > 0) builder.params.push(...params);
}

// 添加日期范围过滤（前缀截取）
export function addDatePrefixRange(
  builder: SqlWhereBuilder,
  column: string,
  startDate?: string | null,
  endDate?: string | null,
): void {
  if (startDate) addClause(builder, `LEFT(${column}, 10) >= ?`, startDate);
  if (endDate) addClause(builder, `LEFT(${column}, 10) <= ?`, endDate);
}

// 添加模糊匹配（任意值）
export function addLikeAny(
  builder: SqlWhereBuilder,
  column: string,
  values: string[],
): void {
  const cleaned = values.map((v) => String(v).trim()).filter(Boolean);
  if (!cleaned.length) return;
  builder.clauses.push(`(${cleaned.map(() => `${column} LIKE ?`).join(' OR ')})`);
  builder.params.push(...cleaned.map((v) => `%${v}%`));
}

// 转换为 SQL WHERE 子句
export function toWhereSql(builder: SqlWhereBuilder): { whereSql: string; params: SqlParam[] } {
  // 默认 seed 通常是 `1=1`，为了减少生成的 SQL 冗余：仅当存在真实过滤条件时才输出 WHERE。
  const clauses = builder.clauses.filter((c) => c !== '1=1');
  if (clauses.length === 0) return { whereSql: '', params: builder.params };
  return { whereSql: `WHERE ${clauses.join(' AND ')}`, params: builder.params };
}

// 将 page/pageSize 规范化，统一分页边界处理。
export function normalizePagination(
  pageRaw: any,
  pageSizeRaw: any,
  maxPageSize = 100,
  defaultPageSize = 20,
): { page: number; pageSize: number; offset: number } {
  const page = Math.max(1, Number(pageRaw || '1') || 1);
  const raw = Number(pageSizeRaw || String(defaultPageSize)) || defaultPageSize;
  const pageSize = Math.min(Math.max(raw, 1), maxPageSize);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

// 统一分页查询（COUNT + 列表）
export async function queryPaged<T>(options: {
  baseFromSql: string;
  whereSql: string;
  params: SqlParam[];
  orderBySql: string;
  pageSize: number;
  offset: number;
  queryOne: <R = any>(sql: string, params?: SqlParam[]) => Promise<R | null>;
  query: <R = any>(sql: string, params?: SqlParam[]) => Promise<R[]>;
}): Promise<{ total: number; rows: T[] }> {
  const totalRow = await options.queryOne<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt ${options.baseFromSql} ${options.whereSql}`,
    options.params,
  );
  const total = Number(totalRow?.cnt || 0);

  const rows = await options.query<T>(
    `SELECT * ${options.baseFromSql} ${options.whereSql} ${options.orderBySql} LIMIT ? OFFSET ?`,
    [...options.params, options.pageSize, options.offset],
  );

  return { total, rows };
}
