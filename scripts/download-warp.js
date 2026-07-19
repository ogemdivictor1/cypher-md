const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BIN_DIR = path.join(__dirname, '..', 'bin');

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(dest);
        return download(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (err) => { file.close(); fs.unlinkSync(dest, () => {}); reject(err); });
  });
}

async function main() {
  const platform = process.platform;
  const isLinux = platform === 'linux';
  const isWin = platform === 'win32';
  if (!isLinux && !isWin) {
    console.log('[setup] skipping warp download on', platform);
    return;
  }

  const goos = isLinux ? 'linux' : 'windows';
  const arch = process.arch === 'x64' ? 'amd64' : (process.arch === 'arm64' ? 'arm64' : 'amd64');
  const ext = isWin ? '.exe' : '';

  fs.mkdirSync(BIN_DIR, { recursive: true });

  const wgcfVer = '2.2.31';
  const wireproxyVer = '1.1.2';

  const wgcfUrl = `https://github.com/ViRb3/wgcf/releases/download/v${wgcfVer}/wgcf_${wgcfVer}_${goos}_${arch}${ext}`;
  const wgcfPath = path.join(BIN_DIR, `wgcf${ext}`);

  const wireproxyUrl = `https://github.com/windtf/wireproxy/releases/download/v${wireproxyVer}/wireproxy_${goos}_${arch}.tar.gz`;
  const wireproxyPath = path.join(BIN_DIR, `wireproxy${ext}`);

  if (!fs.existsSync(wgcfPath)) {
    console.log('[setup] downloading wgcf...');
    await download(wgcfUrl, wgcfPath);
    if (isLinux) fs.chmodSync(wgcfPath, 0o755);
    console.log('[setup] wgcf downloaded');
  } else {
    console.log('[setup] wgcf already exists');
  }

  if (!fs.existsSync(wireproxyPath)) {
    console.log('[setup] downloading wireproxy...');
    const tarPath = path.join(BIN_DIR, 'wireproxy.tar.gz');
    await download(wireproxyUrl, tarPath);
    execSync(`tar -xzf "${tarPath}" -C "${BIN_DIR}"`, { stdio: 'pipe' });
    fs.unlinkSync(tarPath);
    if (isLinux) fs.chmodSync(wireproxyPath, 0o755);
    console.log('[setup] wireproxy downloaded');
  } else {
    console.log('[setup] wireproxy already exists');
  }
}

main().catch(err => {
  console.error('[setup] warp download failed:', err.message);
  console.log('[setup] .play will fall back to direct yt-dlp');
});
