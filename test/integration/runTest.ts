import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

// Launches a real VS Code with the extension loaded and runs suite.ts inside it.
// Needs a display: on Linux use `xvfb-run -a npm run test:integration`.
async function main() {
  const root = path.resolve(__dirname, '../../..');
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-it-ws-'));
  fs.writeFileSync(path.join(workspace, 'README.md'), '# Integration project\n');
  try {
    await runTests({
      extensionDevelopmentPath: root,
      extensionTestsPath: path.resolve(__dirname, 'suite'),
      launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust'],
      extensionTestsEnv: { ACP_IT_WORKSPACE: workspace },
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
