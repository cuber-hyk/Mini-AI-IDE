/**
 * electron-builder 打包配置（Windows x64）
 *
 * 目标产物：
 *   - `Mini-AI-IDE-Setup-<ver>-x64.exe`   NSIS 安装程序（可选安装目录、桌面快捷方式）
 *   - `Mini-AI-IDE-Portable-<ver>-x64.exe` 免安装单文件（双击即用，绿色版）
 *
 * 本项目打包的几个非常规之处，逐条说明理由：
 *
 * 1) **运行时零依赖，但 `files` 里带了 `src/` 与 `test/fixtures/`**
 *    本应用在运行时不读 `node_modules`（Monaco 的 AMD 发行文件已由
 *    `scripts/copy-static.mjs` 复制进 `dist/renderer/vendor/monaco`），
 *    因此 asar 里本来只有 `dist/` 就够了。但 `src/main/selfTest.ts` 与
 *    `src/main/workspaceProbe.ts` 会去读**源码与测试样本**：
 *      - `__dirname/../../src/main`（index.ts / preload.ts 等 .ts 原文）
 *      - `__dirname/../../tools/renderer-scope-report.json`
 *      - `app.getAppPath()/test/fixtures/*.md`
 *    打包后 `__dirname` = `resources/app.asar/dist/main`，这些相对路径依然成立 ——
 *    只要相应文件确实在 asar 里。把它们带上（合计不到 1MB，压缩后更小），
 *    就**完整保留了现场自检能力**（`Mini-AI-IDE.exe --self-test`），
 *    客户机出问题时能直接拿到结论，而不必先把源码传过去。
 *
 * 2) **NSIS 默认 `deleteAppDataOnUninstall: true`，这里显式关掉**
 *    `%APPDATA%/mini-ai-ide` 里放着两样东西：用户设置（自定义格式要求、分栏宽度）
 *    和 `persist:postcheck` 分区里的**网页版登录态**。删掉它意味着重装后必须重新
 *    登录 DeepSeek —— 而分区名是固定的（见 index.ts `SESSION_PARTITION`），
 *    刻意保持稳定正是为了让登录态可复用。所以宁可留下数据也不要自动清空。
 *
 * 3) **不设 `publish`**
 *    本项目没有 CI 发布流程；显式置 `null` 以免 electron-builder 尝试探测
 *    GitHub / S3 凭据而失败。
 *
 * 4) **未配置代码签名**
 *    没有证书，因此产物是未签名 exe（Windows SmartScreen 会提示未知发布者）。
 *    这是刻意的：签名证书的采购与保管是独立决策，不该在打包脚本里假装解决。
 *    拿到证书后在此处补 `win.signtoolOptions` 即可，无需改动其他配置。
 *
 * 为什么文件名是 `.cjs`：electron-builder 的配置**自动发现**只认
 * `electron-builder.{yml,yaml,json,json5,toml,js,cjs,ts}` —— 不含 `.mjs`。
 * 一旦命名成 `.mjs`，配置会被静默忽略（不报错），`directories.output` 退回默认
 * 的 `dist`，而 `dist` 正是 tsc 的输出目录 —— builder 会把自己的 win-unpacked
 * 塞进去，紧接着 `dist/**` 又被默认 files 规则当成输出目录排除，最后报
 * 「Application entry file dist/main/index.js was not found in this archive」。
 * 记这一条是因为那个报错完全看不出是配置没加载，排查起来很绕。
 */
module.exports = {
  appId: 'com.miniai.desktop',
  productName: 'Mini-AI-IDE',
  copyright: 'Mini-AI-IDE contributors',

  /* 产物目录。与 .gitignore 的 `release/` 对应；不要改成 `dist/`——
     那是 TypeScript 的编译输出目录，会被 builder 自己清空。 */
  directories: {
    output: 'release',
    buildResources: 'build',
  },

  /**
   * asar 单文件打包。Electron 已 patch `fs`，读 asar 内的文件与普通文件无差别，
   * 因此上面第 1 条提到的 `fs.readFileSync(asar 内路径)` 可正常工作。
   */
  asar: true,

  files: [
    'dist/**/*',
    /* 现场自检要读的源码与样本，理由见本文件第 1 条 */
    'src/**/*',
    'test/fixtures/**/*',
    'tools/renderer-scope-report.json',
  ],

  win: {
    icon: 'build/icon.ico',
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'portable', arch: ['x64'] },
    ],
    /* Electron 44 已删除 Windows ia32 构建，这里只能是 x64（arm64 需另出构建） */
  },

  nsis: {
    /* 装哪让用户自己选，不要一键静默装到 Program Files */
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    perMachine: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Mini-AI-IDE',
    deleteAppDataOnUninstall: false,
    artifactName: '${productName}-Setup-${version}-${arch}.${ext}',
  },

  portable: {
    artifactName: '${productName}-Portable-${version}-${arch}.${ext}',
  },

  /* 无 CI 发布流程，显式关闭凭据探测 */
  publish: null,
};
