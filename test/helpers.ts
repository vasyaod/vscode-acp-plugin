import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ClientServices } from '../src/core/client';
import { nodeFsHost } from '../src/core/fs';
import { PermissionDecision, PermissionHost, PermissionRequest } from '../src/core/permissions';

export function tmpProject(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acp-proj-')));
  fs.writeFileSync(path.join(dir, 'README.md'), '# Test project\nline two\nline three\nline four\n');
  return dir;
}

export class ScriptedPermissions implements PermissionHost {
  asked: PermissionRequest[] = [];
  signals: AbortSignal[] = [];
  constructor(public answers: Array<PermissionDecision | undefined | 'hang'> = []) {}
  ask(req: PermissionRequest, signal: AbortSignal): Promise<PermissionDecision | undefined> {
    this.asked.push(req);
    this.signals.push(signal);
    const a = this.answers.length ? this.answers.shift() : 'allow';
    if (a === 'hang') return new Promise(() => undefined); // user never answers
    return Promise.resolve(a);
  }
}

export function services(perms: PermissionHost, extra: Partial<ClientServices> = {}): ClientServices {
  return { fs: nodeFsHost, permissions: perms, autoAllow: () => false, ...extra };
}

export const CLIENT_INFO = { name: 'test', version: '0' };

export function until<T>(fn: () => T | undefined | false, ms = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const v = fn();
      if (v) return resolve(v as T);
      if (Date.now() - t0 > ms) return reject(new Error('timeout waiting for condition'));
      setTimeout(tick, 10);
    };
    tick();
  });
}
