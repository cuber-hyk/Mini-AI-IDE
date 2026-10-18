/** 两次启动独立临时资料目录，验收 Chromium 分区跨进程持久化；不访问用户资料。 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-deepseek-accounts-probe-'));
const executable = require('electron');
const script = path.join(__dirname, 'verify-deepseek-accounts.cjs');
async function phase(name) {
  const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
  await new Promise((resolve, reject) => {
    const child = spawn(executable, [script, `--probe-dir=${directory}`, `--probe-phase=${name}`], {
      cwd: path.resolve(__dirname, '..'), env: environment, stdio: 'inherit', windowsHide: true,
    });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${name} 阶段超时`)); }, 60000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`${name} 阶段退出码 ${code}`)); });
  });
}
(async () => {
  await phase('write'); await phase('reopen');
  const reports = ['write', 'reopen'].map(name => JSON.parse(fs.readFileSync(path.join(directory, `${name}.json`), 'utf8')));
  const report = { pass: reports.reduce((sum, phase) => sum + phase.checks.length, 0), fail: 0, directory, phases: reports };
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify({ pass: report.pass, fail: 0, report: path.join(directory, 'report.json') }) + '\n');
})().catch(error => { process.stderr.write(String(error.stack || error) + '\n'); process.exitCode = 1; });
