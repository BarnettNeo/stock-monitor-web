# 服务器 SQL 编码规范

## 目标
- 保持路由处理逻辑可读（不要把查询拼装胶水塞进业务分支里）。
- 确保动态 SQL 的参数顺序正确（`whereSql` 与 `params` 对得上）。
- 减少分页与日期过滤的复制粘贴。

## 规则
- 动态 `WHERE` 条件优先使用 `src/sql-utils.ts`：
  - `createWhereBuilder()`
  - `addClause()`
  - `addDatePrefixRange()`
  - `addLikeAny()`
  - `toWhereSql()`
- 所有外部输入（query/body/user 参数）都要走参数化 SQL（`?`），不要字符串拼接变量。
- 分页列表接口优先使用：
  - `normalizePagination()` 统一边界（page/pageSize/offset）
  - `queryPaged()` 统一 `COUNT + 列表` 查询
- 保持轻量抽象：不要为了“抽象更高级”引入重 ORM；尽量让 SQL 仍然清晰地靠近路由/仓储层。

## 推荐写法（示例）
- 用 `createWhereBuilder()` 构建过滤条件。
- 只在一个位置转换为 `{ whereSql, params }`。
- 列表接口用 `queryPaged()` 完成 `count + list`。
- 结果映射（row -> DTO）在路由里完成，便于阅读与维护。
