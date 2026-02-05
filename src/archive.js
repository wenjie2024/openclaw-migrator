const fs = require('fs-extra');
const path = require('path');
const archiver = require('archiver');
const crypto = require('crypto');
const os = require('os');

const MAGIC = Buffer.from('OCM1');
const VERSION = 1;
const ALGO_GCM = 1;

// Auto-detect config and workspace
function detectSources() {
  const os = require('os');
  const home = process.env.HOME || os.homedir();
  const openclaw = path.join(home, '.openclaw');
  const clawdbot = path.join(home, '.clawdbot');

  // 1. Detect Config Directory
  let configDir = null;
  console.log("Checking HOME:", home);
  console.log("Checking openclaw:", openclaw, fs.existsSync(openclaw));
  console.log("Checking clawdbot:", clawdbot, fs.existsSync(clawdbot));

  if (fs.existsSync(openclaw)) configDir = openclaw;
  else if (fs.existsSync(clawdbot)) configDir = clawdbot;

  if (!configDir) {
    throw new Error("No OpenClaw installation found (~/.openclaw or ~/.clawdbot)");
  }

  // 2. Detect Workspace from Config
  const sources = [configDir];
  try {
    const configPath = path.join(configDir, 'openclaw.json');
    if (fs.existsSync(configPath)) {
      const config = fs.readJsonSync(configPath);
      const workspace = config?.agents?.defaults?.workspace || config?.workspace;

      if (workspace && fs.existsSync(workspace)) {
        if (path.resolve(workspace) !== path.resolve(configDir)) { // Avoid duplicates
          sources.push(workspace);
        }
      }
    }
  } catch (e) {
    console.warn("⚠️ Could not read workspace from config:", e.message);
  }

  return sources;
}

const DEFAULT_SOURCES = []; // Will be populated dynamically if needed

function buildHeader({ salt, iv }) {
  const header = Buffer.alloc(8);
  MAGIC.copy(header, 0);
  header.writeUInt8(VERSION, 4);
  header.writeUInt8(ALGO_GCM, 5);
  header.writeUInt8(salt.length, 6);
  header.writeUInt8(iv.length, 7);
  return Buffer.concat([header, salt, iv]);
}

async function createArchive(sourceDirs, outputPath, password) {
  let sources = sourceDirs;

  // Auto-detect if not provided
  if (!sources || sources.length === 0) {
    try {
      sources = detectSources();
      console.log("🔍 Auto-detected sources:", sources.join(", "));
    } catch (e) {
      return Promise.reject(e);
    }
  }

  return new Promise(async (resolve, reject) => {
    const output = fs.createWriteStream(outputPath);

    const salt = crypto.randomBytes(16);
    const key = crypto.scryptSync(password, salt, 32);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

    const header = buildHeader({ salt, iv });
    output.write(header);

    const archive = archiver('tar', { gzip: true });
    archive.on('error', reject);

    // Add manifest with workspace root (if available)
    const manifest = await buildManifest(sources).catch(() => null);
    if (manifest) {
      archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
    }

    for (const dir of sources) {
      if (fs.existsSync(dir)) {
        // Use directory name as internal path to keep structure
        const dirName = path.basename(dir);
        // Special case: If typical config dir, store as .openclaw-unified for restoration logic
        // But for now, keeping original names for simplicity
        archive.directory(dir, dirName);
      } else {
        console.warn(`⚠️ Warning: Source dir not found: ${dir}`);
      }
    }

    // Pipe archive -> cipher -> output (keep output open for authTag)
    archive.pipe(cipher).pipe(output, { end: false });

    cipher.on('end', () => {
      const authTag = cipher.getAuthTag();
      output.write(authTag);
      output.end();
    });

    output.on('close', () => resolve());
    output.on('error', reject);

    archive.finalize();
  });
}

async function buildManifest(sourceDirs) {
  const os = require('os');
  const pkg = await fs.readJson(path.join(__dirname, '../package.json')).catch(() => ({}));

  // Try to read workspace from openclaw.json if present
  const configDir = sourceDirs.find((d) => path.basename(d) === '.openclaw');
  let workspace = null;
  if (configDir) {
    const configPath = path.join(configDir, 'openclaw.json');
    if (fs.existsSync(configPath)) {
      const json = await fs.readJson(configPath).catch(() => null);
      workspace = json?.agents?.defaults?.workspace || null;
    }
  }

  return {
    version: pkg.version || '1.1.0',
    env: {
      node: process.version,
      platform: os.platform(),
      arch: os.arch()
    },
    workspace,
    home: os.homedir(),
    createdAt: new Date().toISOString()
  };
}

// CLI Driver
if (require.main === module) {
  const src = [
    path.join(__dirname, '../test-data/.openclaw'),
    path.join(__dirname, '../test-data/clawd')
  ];
  const dest = path.join(__dirname, '../test-data/test-archive.oca');
  const pass = process.env.MIGRATOR_PASSWORD;

  if (!pass) {
    console.error("Error: MIGRATOR_PASSWORD env var required");
    process.exit(1);
  }

  createArchive(src, dest, pass)
    .then(() => console.log("✅ Done."))
    .catch(err => console.error("❌ Failed:", err));
}

module.exports = { createArchive };
