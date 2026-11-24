import { promises as nodeFs } from 'fs';
import * as path from 'path';
import { RPC, RpcError } from './errors';

/** What the IDE adapter provides for files. */
export interface FsHost {
  /** Text of the file if it is open in an editor (unsaved changes included), else undefined. */
  readOpenDocument?(absPath: string): string | undefined | Promise<string | undefined>;
  /** Write the file through the editor's document APIs if possible. */
  write(absPath: string, content: string): Promise<void>;
}

/** Plain-disk implementation, used by tests and as a fallback. */
export const nodeFsHost: FsHost = {
  async write(absPath, content) {
    await nodeFs.mkdir(path.dirname(absPath), { recursive: true });
    await nodeFs.writeFile(absPath, content, 'utf8');
  },
};

function resolvePath(p: unknown, cwd: string): string {
  if (typeof p !== 'string' || p.length === 0) throw new RpcError(RPC.INVALID_PARAMS, 'path is required');
  return path.isAbsolute(p) ? path.normalize(p) : path.resolve(cwd, p);
}

/** Apply ACP `line` (1-based) and `limit` (line count) to text. */
export function sliceLines(text: string, line?: number, limit?: number): string {
  if ((line === undefined || line <= 1) && (limit === undefined || limit <= 0)) return text;
  const lines = text.split(/(?<=\n)/);
  const start = Math.max((line ?? 1) - 1, 0);
  const end = limit && limit > 0 ? start + Math.floor(limit) : undefined;
  return lines.slice(start, end).join('');
}

export async function readTextFile(host: FsHost, p: any, cwd: string): Promise<{ content: string }> {
  const abs = resolvePath(p.path, cwd);
  let text = await host.readOpenDocument?.(abs);
  if (text === undefined) {
    try {
      text = await nodeFs.readFile(abs, 'utf8');
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') throw new RpcError(RPC.RESOURCE_NOT_FOUND, `file not found: ${abs}`);
      throw new RpcError(RPC.INTERNAL_ERROR, `cannot read ${abs}: ${err.message}`);
    }
  }
  return { content: sliceLines(text, p.line, p.limit) };
}

export async function writeTextFile(host: FsHost, p: any, cwd: string): Promise<null> {
  const abs = resolvePath(p.path, cwd);
  try {
    await host.write(abs, typeof p.content === 'string' ? p.content : '');
  } catch (e) {
    throw new RpcError(RPC.INTERNAL_ERROR, `cannot write ${abs}: ${(e as Error).message}`);
  }
  return null;
}
