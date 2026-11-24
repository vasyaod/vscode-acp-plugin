import * as fs from 'fs';
import * as os from 'os';
import { describe, expect, it } from 'vitest';
import { AcpError } from '../src/core/errors';
import { runTokenCommand } from '../src/core/tokenCommand';

const node = JSON.stringify(process.execPath);
const SECRET = 'eyJhbGciOiJFUzI1NiJ9.c2VjcmV0.c2ln';

async function failure(cmd: string, opts = {}): Promise<AcpError> {
  const e = await runTokenCommand(cmd, opts).then(
    () => undefined,
    (err) => err,
  );
  expect(e).toBeInstanceOf(AcpError);
  return e as AcpError;
}

describe('runTokenCommand', () => {
  it('returns the trimmed stdout, through the shell', async () => {
    expect(await runTokenCommand(`echo "  ${SECRET}  "`)).toBe(SECRET);
    expect(await runTokenCommand(`printf 'abc' | tr a-c x-z`)).toBe('xyz');
  });

  it('runs in the home directory, not in whatever directory the editor has', async () => {
    const out = await runTokenCommand(`${node} -e "process.stdout.write(process.cwd())"`);
    expect(fs.realpathSync(out)).toBe(fs.realpathSync(os.homedir()));
  });

  it('gets no stdin (a prompting command fails instead of hanging)', async () => {
    const out = await runTokenCommand(`${node} -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write('stdin:'+d.length))"`);
    expect(out).toBe('stdin:0');
  });

  it('a non-zero exit is an auth error with the exit code and the first stderr line', async () => {
    const e = await failure(`${node} -e "console.error('\\nno such keychain item\\nmore'); process.exit(44)"`);
    expect(e.kind).toBe('auth');
    expect(e.message).toMatch(/exit code 44/);
    expect(e.message).toMatch(/no such keychain item/);
    expect(e.message).not.toMatch(/more/);
  });

  it('never puts the printed token in an error, even when the command then fails', async () => {
    const e = await failure(`${node} -e "process.stdout.write('${SECRET}'); process.exit(1)"`);
    expect(e.message).not.toContain(SECRET);
    const multi = await failure(`${node} -e "console.log('${SECRET}'); console.log('${SECRET}')"`);
    expect(multi.message).toMatch(/more than one word/);
    expect(multi.message).not.toContain(SECRET);
  });

  it('empty output, an empty command and a timeout are errors', async () => {
    expect((await failure('true')).message).toMatch(/printed nothing/);
    expect((await failure('   ')).kind).toBe('config');
    const t0 = Date.now();
    const slow = await failure(`${node} -e "setTimeout(()=>{}, 60000)"`, { timeoutMs: 300 });
    expect(slow.message).toMatch(/did not finish/);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('a command that does not exist is an auth error, not a crash', async () => {
    const e = await failure('/definitely/not/here/swarm_jwt');
    expect(e.kind).toBe('auth');
    expect(e.message).toMatch(/failed/);
  });
});
