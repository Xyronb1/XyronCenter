/**
 * Single-File Source Code Exporter for XYRON CENTER
 * 
 * Walks 2_Proje_Dosyalari_Source (and root config/doc files),
 * filters out node_modules, build artifacts, git/agent metadata, and binaries,
 * and concatenates all text/source files into:
 *   1_Kaynak_Kodlar_TXT/XYRON_CENTER_TUM_KAYNAK_KODLAR.txt
 */

const fs = require('fs');
const path = require('path');

// Determine Project Root and Source Directory
function resolvePaths() {
  let projectRoot = path.resolve(__dirname);
  if (path.basename(projectRoot) === '2_Proje_Dosyalari_Source') {
    projectRoot = path.resolve(projectRoot, '..');
  } else if (!fs.existsSync(path.join(projectRoot, '2_Proje_Dosyalari_Source'))) {
    // Look upwards
    let parent = path.dirname(projectRoot);
    while (parent !== projectRoot) {
      if (fs.existsSync(path.join(parent, '2_Proje_Dosyalari_Source'))) {
        projectRoot = parent;
        break;
      }
      parent = path.dirname(parent);
    }
  }

  const sourceDir = path.join(projectRoot, '2_Proje_Dosyalari_Source');
  const outputDir = path.join(projectRoot, '1_Kaynak_Kodlar_TXT');
  const outputFile = path.join(outputDir, 'XYRON_CENTER_TUM_KAYNAK_KODLAR.txt');

  return { projectRoot, sourceDir, outputDir, outputFile };
}

// Directory and File Filtering Rules
const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  '.agents',
  'dist',
  'build',
  '3_Final_EXE_Uygulama',
  '1_Kaynak_Kodlar_TXT',
  '.gemini',
  '.idea',
  '.vscode',
  'coverage',
  'tmp',
  'temp',
  'out'
]);

const EXCLUDED_EXTENSIONS = new Set([
  '.exe',
  '.dll',
  '.node',
  '.ico',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.webp',
  '.zip',
  '.asar',
  '.tar',
  '.gz',
  '.7z',
  '.pdf',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.log',
  '.map'
]);

const ALLOWED_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.css',
  '.html',
  '.md',
  '.bat',
  '.cmd',
  '.ps1',
  '.txt',
  '.yml',
  '.yaml'
]);

// Recursively collect all eligible files
function collectFiles(dirPath, projectRoot, collected = []) {
  if (!fs.existsSync(dirPath)) return collected;

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryName = entry.name;
    const fullPath = path.join(dirPath, entryName);

    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entryName)) continue;
      collectFiles(fullPath, projectRoot, collected);
    } else if (entry.isFile()) {
      const ext = path.extname(entryName).toLowerCase();
      // Skip excluded binaries and maps
      if (EXCLUDED_EXTENSIONS.has(ext)) continue;
      // Skip the output file itself
      if (entryName === 'XYRON_CENTER_TUM_KAYNAK_KODLAR.txt') continue;
      // Only include known source/text extensions
      if (!ALLOWED_EXTENSIONS.has(ext)) continue;

      collected.push(fullPath);
    }
  }

  return collected;
}

function exportSourceToTxt() {
  const { projectRoot, sourceDir, outputDir, outputFile } = resolvePaths();

  console.log('================================================================================');
  console.log('   XYRON CENTER - SINGLE-FILE SOURCE CODE EXPORTER');
  console.log('================================================================================');
  console.log(`[Exporter] Project Root: ${projectRoot}`);
  console.log(`[Exporter] Source Dir:   ${sourceDir}`);
  console.log(`[Exporter] Output Dir:   ${outputDir}`);
  console.log(`[Exporter] Output File:  ${outputFile}`);

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // 1. Collect files from 2_Proje_Dosyalari_Source
  const sourceFiles = collectFiles(sourceDir, projectRoot);

  // 2. Collect top-level project root text/config files
  const rootEntries = fs.readdirSync(projectRoot, { withFileTypes: true });
  const rootFiles = [];
  for (const entry of rootEntries) {
    if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (ALLOWED_EXTENSIONS.has(ext) && !EXCLUDED_EXTENSIONS.has(ext)) {
        if (entry.name !== 'XYRON_CENTER_TUM_KAYNAK_KODLAR.txt') {
          rootFiles.push(path.join(projectRoot, entry.name));
        }
      }
    }
  }

  // Combine and de-duplicate
  const allFilesSet = new Set([...rootFiles, ...sourceFiles]);
  const allFiles = Array.from(allFilesSet).sort();

  console.log(`[Exporter] Discovered ${allFiles.length} source and config files to concatenate.`);

  let totalLines = 0;
  let totalBytes = 0;
  const chunks = [];

  // Header Banner
  const headerBanner = [
    '================================================================================',
    'XYRON CENTER - COMPLETE SOURCE CODE CONCATENATION (ALL SOURCE FILES)',
    `Generated: ${new Date().toISOString()}`,
    `Total Files: ${allFiles.length}`,
    '================================================================================',
    '',
    ''
  ].join('\r\n');

  chunks.push(headerBanner);
  totalLines += headerBanner.split('\n').length;
  totalBytes += Buffer.byteLength(headerBanner, 'utf8');

  for (const filePath of allFiles) {
    const relPath = path.relative(projectRoot, filePath).replace(/\\/g, '/');
    let content = '';
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      console.warn(`[Exporter] Warning: Failed to read ${filePath}: ${err.message}`);
      continue;
    }

    const fileHeader = [
      '================================================================================',
      `FILE: ${relPath}`,
      '================================================================================',
      ''
    ].join('\r\n');

    const fileBlock = fileHeader + content + '\r\n\r\n';
    chunks.push(fileBlock);

    const lines = content.split('\n').length;
    totalLines += lines + 4;
    totalBytes += Buffer.byteLength(fileBlock, 'utf8');
  }

  const finalOutput = chunks.join('');
  fs.writeFileSync(outputFile, finalOutput, 'utf8');

  const stats = fs.statSync(outputFile);

  console.log('--------------------------------------------------------------------------------');
  console.log(`[Exporter] SUCCESS! Generated single source dump.`);
  console.log(`[Exporter] Total Files Processed: ${allFiles.length}`);
  console.log(`[Exporter] Total Lines Written:   ${totalLines.toLocaleString()}`);
  console.log(`[Exporter] Total File Size:       ${(stats.size / 1024).toFixed(2)} KB (${stats.size.toLocaleString()} bytes)`);
  console.log(`[Exporter] Output Path:           ${outputFile}`);
  console.log('================================================================================\n');

  return {
    outputFile,
    fileCount: allFiles.length,
    lineCount: totalLines,
    byteCount: stats.size
  };
}

if (require.main === module) {
  exportSourceToTxt();
}

module.exports = {
  exportSourceToTxt,
  resolvePaths,
  collectFiles,
  EXCLUDED_DIRS,
  EXCLUDED_EXTENSIONS,
  ALLOWED_EXTENSIONS
};
