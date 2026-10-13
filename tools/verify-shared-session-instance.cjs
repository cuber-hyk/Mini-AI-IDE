/** 原生锁离线夹具：仅 TEMP synthetic 资料与自有子进程，不访问官网或用户资料。 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { app } = require('electron');
const { SharedSessionInstance } = require('../dist/main/sharedSessionInstance');

if (process.env.MINI_INSTANCE_CHILD === '1') {
  const directory = process.env.MINI_INSTANCE_DIRECTORY;
  app.setName('mini-ai-ide'); app.setPath('userData', directory);
  const write = event => fs.appendFileSync(process.env.MINI_INSTANCE_EVENTS, JSON.stringify({ event, pid: process.pid }) + '\n');
  const owner = new SharedSessionInstance(app);
  app.on('second-instance', () => write('second-instance'));
  if (!owner.acquire()) { write('rejected'); app.exit(0); }
  else {
    write('acquired');
    owner.setWindow({ isDestroyed: () => false, isMinimized: () => true,
      restore: () => write('restore'), show: () => write('show'), focus: () => write('focus') });
    app.whenReady().then(() => {
      const store = path.join(directory, 'synthetic.json');
      const previous = fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, 'utf8')) : { count: 0 };
      fs.writeFileSync(store, JSON.stringify({ count: previous.count + 1 }));
      write('ready');
      const timer = setInterval(() => { if (fs.existsSync(process.env.MINI_INSTANCE_STOP)) { clearInterval(timer); app.quit(); } }, 25);
    });
  }
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-instance-probe-'));
  app.setPath('userData', path.join(root, 'orchestrator'));
  const children = new Set(); const checks = [];
  const check = (label, value) => { assert.ok(value, label); checks.push(label); };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(read) { for (let n = 0; n < 240; n++) { if (read()) return; await sleep(25); } throw new Error('原生实例状态等待超时'); }
  function launch(name, directory, script) {
    fs.mkdirSync(directory, { recursive: true });
    const events = path.join(root, `${name}.jsonl`), stop = path.join(root, `${name}.stop`);
    const env = {
      ...process.env, MINI_INSTANCE_CHILD: '1', MINI_INSTANCE_DIRECTORY: directory,
      MINI_INSTANCE_EVENTS: events, MINI_INSTANCE_STOP: stop,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(process.execPath, [script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
    children.add(child); let stderr = '';
    child.stderr.on('data', data => { stderr += data.toString(); });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => { children.delete(child); resolve({ code, signal }); }));
    const rows = () => fs.existsSync(events) ? fs.readFileSync(events, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    return { child, exited, rows, has: event => rows().some(row => row.event === event), stop: () => fs.writeFileSync(stop, ''), errors: () => stderr };
  }
  app.whenReady().then(async () => {
    const same = path.join(root, 'shared-data'), separate = path.join(root, 'separate-data');
    const alternate = path.join(root, 'alternate-launch.cjs');
    fs.writeFileSync(alternate, `require(${JSON.stringify(__filename)});\n`);
    const first = launch('first', same, __filename);
    try { await until(() => first.has('ready')); } catch (error) { throw new Error(error.message + ': ' + first.errors()); }
    const second = launch('second', same, alternate); await until(() => second.has('rejected'));
    await second.exited; await until(() => first.has('second-instance'));
    check('不同脚本启动路径共享同应用名和资料目录，第二实例被拒绝且首实例收到激活事件', first.has('second-instance') && !second.has('ready'));
    check('第二实例事件仅激活既有窗口，不创建可见原生夹具窗口', ['restore', 'show', 'focus'].every(event => first.has(event)));
    check('拒绝实例未访问 synthetic 存储', JSON.parse(fs.readFileSync(path.join(same, 'synthetic.json'), 'utf8')).count === 1);
    const independent = launch('independent', separate, alternate); await until(() => independent.has('ready'));
    check('不同资料目录可并行运行，独立锁不影响原实例', first.child.exitCode === null && independent.has('acquired'));
    independent.stop(); await independent.exited; first.stop(); await first.exited;
    const restart = launch('restart', same, alternate); await until(() => restart.has('ready'));
    check('正常退出后另一启动路径可再次获得锁并读取原存储', JSON.parse(fs.readFileSync(path.join(same, 'synthetic.json'), 'utf8')).count === 2);
    restart.child.kill(); await restart.exited;
    const afterCrash = launch('after-crash', same, __filename); await until(() => afterCrash.has('ready'));
    check('仅终止自有夹具进程后锁随真实退出释放，下一实例可正常启动', afterCrash.has('acquired'));
    check('synthetic 资料顺序持久化，异常退出未清空已有文件', JSON.parse(fs.readFileSync(path.join(same, 'synthetic.json'), 'utf8')).count === 3);
    afterCrash.stop(); await afterCrash.exited;
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ checks, total: checks.length, root,
      scope: 'Electron 44.5.1 同 exe 不同脚本启动路径；未冒称不同发行版 exe 原生实测' }, null, 2));
    console.log(JSON.stringify({ passed: checks.length, root })); app.exit(0);
  }).catch(error => { console.error(error); for (const child of children) child.kill(); app.exit(1); });
}
