// Type declaration shims for modules that couldn't be installed
// due to network/build constraints in this environment.

declare module 'express' {
  import { IncomingMessage, ServerResponse } from 'http';
  export interface Request extends IncomingMessage {
    params: Record<string, string>;
    query: Record<string, any>;
    body: any;
  }
  export interface Response extends ServerResponse {
    json(data: any): this;
    status(code: number): this;
    send(data: any): this;
    set(field: string, value: string): this;
  }
  export interface NextFunction {
    (err?: any): void;
  }
  export interface Application {
    use(...args: any[]): this;
    get(path: string, handler: (req: Request, res: Response) => void): this;
    post(path: string, handler: (req: Request, res: Response) => Promise<void> | void): this;
    delete(path: string, handler: (req: Request, res: Response) => void): this;
    listen(port: number, callback?: () => void): any;
  }
  interface Express {
    (): Application;
    json(): any;
    urlencoded(opts?: any): any;
  }
  const express: Express;
  export = express;
}

declare module 'better-sqlite3' {
  interface Statement {
    run(...params: any[]): { changes: number; lastInsertRowid: number };
    get(...params: any[]): any;
    all(...params: any[]): any[];
  }
  interface Database {
    prepare(sql: string): Statement;
    exec(sql: string): void;
    pragma(pragma: string): any;
    transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T;
    close(): void;
  }
  interface DatabaseConstructor {
    new(filename: string, options?: any): Database;
    (filename: string, options?: any): Database;
  }
  const Database: DatabaseConstructor;
  export = Database;
}
