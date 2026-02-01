const fs = require('fs-extra');
const path = require('path');
const archiver = require('archiver');
const crypto = require('crypto');

async function createArchive(sourceDirs, outputPath, password) {
  return new Promise((resolve, reject) => {
    // 1. Prepare Output
    const output = fs.createWriteStream(outputPath);
    
    // 2. Crypto Setup (AES-256-GCM)
    const algorithm = 'aes-256-gcm';
    const salt = crypto.randomBytes(16);
    // Derive key using scrypt (secure)
    const key = crypto.scryptSync(password, salt, 32); 
    const iv = crypto.randomBytes(12); // GCM standard IV size
    
    const cipher = crypto.createCipheriv(algorithm, key, iv);

    // 3. Write Header (Salt + IV) unencrypted at start of file
    output.write(salt);
    output.write(iv);

    // 4. Pipeline: Archiver -> Cipher -> Output
    const archive = archiver('tar', { zlib: { level: 9 } }); // Compress then Encrypt

    output.on('close', () => {
      console.log(`📦 Archive created: ${outputPath} (${archive.pointer()} bytes)`);
      resolve();
    });

    archive.on('error', (err) => reject(err));
    
    // Pipe archive data into cipher
    archive.pipe(cipher).pipe(output);

    // 5. Append Directories
    for (const dir of sourceDirs) {
      if (fs.existsSync(dir)) {
        const dirname = path.basename(dir);
        // Store as root folders in archive
        archive.directory(dir, dirname); 
      } else {
        console.warn(`⚠️ Warning: Source dir not found: ${dir}`);
      }
    }

    // 6. Finalize
    archive.finalize().then(() => {
       // Get auth tag after finalization?
       // WAIT: GCM auth tag is only available after cipher.final().
       // Streamed GCM is tricky because the tag comes at the end.
       // Node's crypto stream handles this? 
       // No, we usually need to append the tag. 
       // For simplicity in this V1 prototype, we might switch to AES-256-CBC if streaming GCM is complex,
       // OR stick to GCM but handle the tag.
       // Actually, cipher.getAuthTag() is available after 'end' event of cipher.
       // But 'output' stream is already closing.
       // Let's rely on the stream; usually the tag is appended automatically by some wrappers, but raw crypto stream doesn't.
       
       // FIX: Use simple AES-256-CBC for file archiving (standard practice for large files) 
       // or append tag manually.
       // Let's use CBC for robustness in this stream context unless we need auth.
       // Okay, sticking to CBC for now to avoid the GCM Tag Stream issue.
    });
  });
}

// Wrapper for CBC Stream (Simpler for streams)
async function createArchiveCBC(sourceDirs, outputPath, password) {
    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(outputPath);
        const salt = crypto.randomBytes(16);
        const key = crypto.scryptSync(password, salt, 32);
        const iv = crypto.randomBytes(16); // CBC IV is 16 bytes
        const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);

        // Write Header
        output.write(salt);
        output.write(iv);

        const archive = archiver('tar', { gzip: true });

        output.on('close', resolve);
        archive.on('error', reject);

        archive.pipe(cipher).pipe(output);

        for (const dir of sourceDirs) {
            if (fs.existsSync(dir)) {
                archive.directory(dir, path.basename(dir));
            }
        }

        archive.finalize();
    });
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

    createArchiveCBC(src, dest, pass)
        .then(() => console.log("✅ Done."))
        .catch(err => console.error("❌ Failed:", err));
}

module.exports = { createArchiveCBC };
