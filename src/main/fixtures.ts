/**
 * 本地文件读取的一个可复现样例目录（仅自检使用）
 *
 * 目的：让"打开目录 → 列目录 → 读文件"这条链路可以在**不联网**的情况下被验证。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface FixturePaths {
  root: string;
  utf8File: string;
  gbkFile: string;
  binaryFile: string;
  nestedDir: string;
}

/** 造一个临时样例目录，返回各文件路径 */
export function createFixtures(): FixturePaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-ai-ide-fixture-'));

  const utf8File = path.join(root, 'hello.ts');
  fs.writeFileSync(utf8File, 'export const greeting = "你好，世界";\nconsole.log(greeting);\n', 'utf8');

  // GBK 编码的中文内容（Node 无内置编码器，手工构造 GBK 字节）
  const gbkFile = path.join(root, 'gbk-note.txt');
  const gbkBytes = Buffer.from([
    0xd6, 0xd0, 0xce, 0xc4, // 中文
    0xb1, 0xe0, 0xc2, 0xeb, // 编码
    0xb2, 0xe2, 0xca, 0xd4, // 测试
    0x0a,
  ]);
  fs.writeFileSync(gbkFile, gbkBytes);

  const binaryFile = path.join(root, 'blob.bin');
  fs.writeFileSync(binaryFile, Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0x00]));

  const nestedDir = path.join(root, 'src');
  fs.mkdirSync(nestedDir);
  fs.writeFileSync(path.join(nestedDir, 'nested.ts'), 'export const nested = 42;\n', 'utf8');

  return { root, utf8File, gbkFile, binaryFile, nestedDir };
}
