const fs = require('fs-extra');
const path = require('path');
const tar = require('tar');
const crypto = require('crypto');
const { Transform } = require('stream');

const MAGIC = Buffer.from('OCM1');
const VERSION = 1;
const ALGO_GCM = 1;
const AUTH_TAG_LEN = 16;

class GcmTagSplitter extends Transform {
  constructor() {
    super();
    this.tail = Buffer.alloc(0);
  }

  _transform(chunk, enc, cb) {
    this.tail = Buffer.concat([this.tail, chunk]);
    if (this.tail.length > AUTH_TAG_LEN) {
      const emitLen = this.tail.length - AUTH_TAG_LEN;
      this.push(this.tail.slice(0, emitLen));
      this.tail = this.tail.slice(emitLen);
    }
    cb();
  }

  _flush(cb) {
    this.emit('tag', this.tail);
    cb();
  }
}

async function readExact(stream, n) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length >= n) {
        stream.pause();
        stream.removeListener('data', onData);
        stream.removeListener('error', onErr);
        const needed = buf.slice(0, n);
        const rest = buf.slice(n);
        if (rest.length) stream.unshift(rest);
        resolve(needed);
      }
    }
    function onErr(err) {
      reject(err);
    }
    stream.on('data', onData);
    stream.on('error', onErr);
    stream.resume();
  });
}

async function readHeader(input) {
  const fixed = await readExact(input, 8);
  if (!fixed.slice(0, 4).equals(MAGIC)) throw new Error('Invalid archive: bad magic');
  const version = fixed.readUInt8(4);
  const algo = fixed.readUInt8(5);
  const saltLen = fixed.readUInt8(6);
  const ivLen = fixed.readUInt8(7);
  if (version !== VERSION || algo !== ALGO_GCM) throw new Error('Unsupported archive version/algorithm');
  const rest = await readExact(input, saltLen + ivLen);
  const salt = rest.slice(0, saltLen);
  const iv = rest.slice(saltLen);
  return { salt, iv };
}

async function restoreArchive(archivePath, targetDir, password) {
  return new Promise(async (resolve, reject) => {
    const input = fs.createReadStream(archivePath);
    try {
      const { salt, iv } = await readHeader(input);
      const key = crypto.scryptSync(password, salt, 32);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);

      const splitter = new GcmTagSplitter();
      splitter.on('tag', (tag) => {
        try {
          decipher.setAuthTag(tag);
        } catch (e) {
          reject(new Error('Invalid auth tag'));
        }
      });

      const parser = new tar.Parser();

      parser.on('entry', (entry) => {
        const rootDir = entry.path.split('/')[0];
        let finalPath = entry.path;

        // --- Path Normalization Logic ---
        if (rootDir === '.clawdbot' || rootDir === '.openclaw') {
          // Config file -> .openclaw
          finalPath = entry.path.replace(rootDir, '.openclaw');
        } else if (entry.path !== 'manifest.json') {
          // Workspace content -> .openclaw/workspace
          const restPath = entry.path.substring(rootDir.length);
          finalPath = `.openclaw/workspace${restPath}`;
        }
        // ---------------------------------

        // Security Check
        if (finalPath.includes('..') || finalPath.startsWith('/')) {
          console.warn(`🚨 Security: Blocked suspicious path: ${finalPath}`);
          entry.resume(); // Skip
          return;
        }

        const fullDest = path.join(targetDir, finalPath);
        console.log(`Extracting: ${entry.path} -> ${finalPath}`);

        if (entry.type === 'Directory') {
          fs.ensureDirSync(fullDest);
          entry.resume();
        } else if (entry.type === 'File') {
          fs.ensureDirSync(path.dirname(fullDest));
          entry.pipe(fs.createWriteStream(fullDest));
        } else {
          entry.resume();
        }
      });

      decipher.on('error', () => reject(new Error('Decryption failed (Wrong password or corrupted archive)')));
      parser.on('error', reject);
      parser.on('end', () => {
        console.log('🔓 Decryption & Extraction complete.');
        resolve();
      });

      input.pipe(splitter).pipe(decipher).pipe(parser);
    } catch (e) {
      reject(e);
    }
  });
}

function deepReplacePaths(obj, oldPath, newPath) {
  if (typeof obj === 'string') {
    // Escape backslashes for Windows if needed, but here we focus on general path healing
    if (obj.includes(oldPath)) {
      return obj.replace(new RegExp(oldPath, 'g'), newPath);
    }
    return obj;
  } else if (Array.isArray(obj)) {
    return obj.map(item => deepReplacePaths(item, oldPath, newPath));
  } else if (typeof obj === 'object' && obj !== null) {
    const newObj = {};
    for (const key in obj) {
      newObj[key] = deepReplacePaths(obj[key], oldPath, newPath);
    }
    return newObj;
  }
  return obj;
}

async function fixPaths(targetDir) {
  const os = require('os');
  const configPath = path.join(targetDir, '.openclaw/openclaw.json');
  const manifestPath = path.join(targetDir, 'manifest.json');

  if (fs.existsSync(configPath)) {
    console.log('🔧 Running deep path healing on openclaw.json...');
    const json = await fs.readJson(configPath);
    const manifest = fs.existsSync(manifestPath) ? await fs.readJson(manifestPath) : {};

    const oldHome = manifest?.home;
    const newHome = process.env.HOME || os.homedir();

    let fixedJson = json;

    // 1. Heal based on HOME directory change
    if (oldHome && oldHome !== newHome) {
      console.log(`🏠 Home directory changed: ${oldHome} -> ${newHome}`);
      fixedJson = deepReplacePaths(fixedJson, oldHome, newHome);
    }

    // 2. Heal relative workspace if it was restored into a new location
    // New Standard: Always point to ~/.openclaw/workspace (or user provided path if we pass it later)

    // Construct the standard new workspace path
    const newWorkspace = path.join(targetDir, '.openclaw', 'workspace');
    console.log(`📂 Normalizing workspace config to: ${newWorkspace}`);

    // Force update workspace path
    if (!fixedJson.agents) fixedJson.agents = { defaults: {} };
    if (!fixedJson.agents.defaults) fixedJson.agents.defaults = {};
    fixedJson.agents.defaults.workspace = newWorkspace;

    // Also update root-level workspace if present (older config)
    if (fixedJson.workspace) {
      fixedJson.workspace = newWorkspace;
    }

    // Also fix any other references to old workspace path
    const oldWorkspace = manifest?.workspace;
    if (oldWorkspace) {
      fixedJson = deepReplacePaths(fixedJson, oldWorkspace, newWorkspace);
    }

    await fs.writeJson(configPath, fixedJson, { spaces: 2 });
    console.log('✅ Path healing complete.');
  }
}

// CLI Driver
if (require.main === module) {
  const archive = path.join(__dirname, '../test-data/test-archive.oca');
  const dest = path.join(__dirname, '../test-data/restore-site');
  const pass = process.env.MIGRATOR_PASSWORD;

  if (!pass) {
    console.error("Error: MIGRATOR_PASSWORD env var required");
    process.exit(1);
  }

  fs.ensureDirSync(dest);

  restoreArchive(archive, dest, pass)
    .then(() => fixPaths(dest))
    .then(() => console.log("✅ Restore Done."))
    .catch(err => console.error("❌ Failed:", err));
}

module.exports = { restoreArchive, fixPaths };
