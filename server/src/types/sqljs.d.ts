declare module 'sql.js' {
  export type Database = any;

  export type SqlJsStatic = {
    Database: new (...args: any[]) => Database;
  };

  const initSqlJs: (options?: any) => Promise<SqlJsStatic>;
  export default initSqlJs;
}
