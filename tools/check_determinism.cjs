'use strict';
// tools/check_determinism.cjs
// 重复出片 SHA-256 对拍：同一份 CSV 走两遍「校验 → 归一化 → 渲染 → 溯源」，
// 逐字节比较两个 MP4。这不是「网页产物 vs 直接调渲染器」那种同进程比较，
// 而是两次独立执行（不同任务目录、不同 runId、不同输出路径、不同进程）。
//
// 用法：
//   node tools/check_determinism.cjs
//   node tools/check_determinism.cjs --file my.csv --class cross_section --map '{"label":"区域","value":"毛利"}'
//
// 退出码：0 = 两次一致；1 = 不一致或执行失败。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const { validateImport } = require(path.join(ROOT, 'web', 'src', 'import', 'validate'));
const { countTextLines } = require(path.join(ROOT, 'web', 'src', 'csv'));
const genericChart = require(path.join(ROOT, 'web', 'src', 'adapters', 'genericChart.cjs'));

function parseArgs(argv) {
  const out = { file: path.join(ROOT, 'docs', 'samples', 'timeseries_single.csv'), cls: 'timeseries', map: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--file') out.file = path.resolve(argv[i + 1]);
    if (argv[i] === '--class') out.cls = argv[i + 1];
    if (argv[i] === '--map') out.map = JSON.parse(argv[i + 1]);
  }
  return out;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function runCommandSync(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// 一次完整出片：返回 { video, videoSha, traceSha, bytes, frames }
async function runOnce({ csvText, fileName, cls, title, unit, mapping, tag, workRoot }) {
  const taskDir = path.join(workRoot, tag);
  const outputDir = path.join(workRoot, tag + '_out');
  fs.mkdirSync(taskDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

  // 不固定 importedAt：网页路径每次创建任务都会取当前时间。
  // 正因如此，这个测试才能证明「时间戳没有渗进画面」——如果渗进去了，两次会不一致。
  const v = validateImport({
    dataClass: cls, csvText, fileName, title, unit, mapping,
  });
  if (!v.ok) throw new Error(`校验未通过（${v.code}）：${v.message}`);

  // 与 taskManager.createTask 同一处理：原样留档 + 指纹注入归一化模型
  const buf = Buffer.from(csvText, 'utf8');
  const sourceSha256 = crypto.createHash('sha256').update(buf).digest('hex');
  fs.writeFileSync(path.join(taskDir, 'source.csv'), buf);
  const model = JSON.parse(JSON.stringify(v.model));
  model.meta = Object.assign({}, model.meta, {
    sourceSha256,
    sourceBytes: buf.length,
    sourceLines: countTextLines(csvText),
  });
  fs.writeFileSync(path.join(taskDir, 'import.json'), JSON.stringify(model, null, 2), 'utf8');

  const adapter = genericChart[cls];
  const runId = 'web_' + tag.replace(/[^a-z0-9]/gi, '');
  const out = await adapter.execute({
    taskId: tag,
    runId,
    request: {},
    taskDir,
    PROJECT_ROOT: ROOT,
    OUTPUT_DIR: outputDir,
    runCommand: (cmd, args) => Promise.resolve(runCommandSync(cmd, args)),
    onStep: () => {},
    logWrite: () => {},
  });

  const tracePath = path.join(taskDir, 'traceability.json');
  return {
    video: out.mp4,
    videoSha: sha256(out.mp4),
    bytes: fs.statSync(out.mp4).size,
    traceSha: sha256(tracePath),
    trace: JSON.parse(fs.readFileSync(tracePath, 'utf8')),
  };
}

async function main() {
  const { file, cls, map } = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(file)) {
    console.error(`找不到文件：${file}`);
    process.exit(1);
  }
  const csvText = fs.readFileSync(file, 'utf8');
  const fileName = path.basename(file);
  const title = '重复出片对拍';
  const unit = '';

  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stv-det-'));
  console.log(`[determinism] 输入：${fileName}（class=${cls}，${Buffer.byteLength(csvText, 'utf8')} 字节）`);
  console.log(`[determinism] 工作目录：${workRoot}`);

  let a;
  let b;
  try {
    console.log('[determinism] 第 1 次出片…');
    a = await runOnce({ csvText, fileName, cls, title, unit, mapping: map, tag: 'runA', workRoot });
    console.log(`  video sha256=${a.videoSha}  ${a.bytes} 字节  ${a.trace.verification.verified}/${a.trace.verification.points} 点已溯源`);
    console.log('[determinism] 第 2 次出片…');
    b = await runOnce({ csvText, fileName, cls, title, unit, mapping: map, tag: 'runB', workRoot });
    console.log(`  video sha256=${b.videoSha}  ${b.bytes} 字节  ${b.trace.verification.verified}/${b.trace.verification.points} 点已溯源`);
  } catch (e) {
    console.error(`[determinism] 失败：${e && e.message ? e.message : e}`);
    process.exit(1);
  }

  const sameVideo = a.videoSha === b.videoSha;
  // traceability.json 里的 generatedAt / importedAt 每次不同，不能整文件比；
  // 只比较「数据部分」：源文件指纹 + 每条溯源记录。
  const dataOf = (t) => JSON.stringify({
    source: {
      fileName: t.source.fileName,
      sha256: t.source.sha256,
      bytes: t.source.bytes,
      lines: t.source.lines,
    },
    mapping: t.mapping,
    trace: t.trace,
    verification: t.verification,
  });
  const sameTrace = dataOf(a.trace) === dataOf(b.trace);

  console.log('');
  console.log(`  视频逐字节一致：${sameVideo ? '是' : '否'}`);
  console.log(`  溯源清单数据一致：${sameTrace ? '是' : '否'}`);
  console.log(`  输出目录：${path.dirname(a.video)} / ${path.dirname(b.video)}`);

  if (sameVideo && sameTrace) {
    console.log('\n[determinism] PASS：两次独立出片产物完全一致。');
    process.exit(0);
  }
  console.log('\n[determinism] FAIL：两次出片不一致，说明存在与数据无关的随机/时间因素。');
  process.exit(1);
}

main();
