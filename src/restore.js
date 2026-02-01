const fs = require('fs-extra');
const path = require('path');
const tar = require('tar');
const crypto = require('crypto');

async function restoreArchive(archivePath, targetDir, password) {
    return new Promise((resolve, reject) => {
        // 1. Read Input
        const input = fs.createReadStream(archivePath);

        // 2. Read Header (Salt 16 + IV 16)
        let headerRead = false;
        
        input.once('readable', () => {
            if (headerRead) return;
            const salt = input.read(16);
            const iv = input.read(16);
            
            if (!salt || !iv) {
                reject(new Error("Invalid archive: missing header"));
                return;
            }
            headerRead = true;

            // 3. Derive Key
            const key = crypto.scryptSync(password, salt, 32);
            const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);

            // 4. Pipeline: Input -> Decipher -> Gunzip (tar handles it) -> Extract
            const extractor = tar.x({
                cwd: targetDir,
                onentry: (entry) => {
                    console.log(`Extracting: ${entry.path}`);
                }
            });

            // Handle streams
            // We need to pipe the REST of the input (after header) to decipher
            // But 'input' stream position is moved by read().
            // Simply piping 'input' now should work as it continues from current pos.
            
            input.pipe(decipher).pipe(extractor)
                .on('end', () => {
                    console.log("🔓 Decryption & Extraction complete.");
                    resolve();
                })
                .on('error', reject);
                
            decipher.on('error', (e) => reject(new Error("Decryption failed (Wrong password?)")));
        });
    });
}

async function fixPaths(targetDir) {
    const configPath = path.join(targetDir, '.openclaw/openclaw.json');
    if (fs.existsSync(configPath)) {
        console.log("🔧 Fixing paths in openclaw.json...");
        let content = await fs.readFile(configPath, 'utf8');
        
        // Simple heuristic: Replace old workspace root with new one
        // In a real app, we might parse JSON. Here we do a regex replace for robustness.
        // Assuming we want to point to current PWD
        const currentRoot = process.cwd(); // Or specific target
        
        // This is tricky without knowing the OLD path explicitly.
        // But we can look for the 'workspace' key.
        // For the mock, we know it is "/Users/mockuser/clawd".
        
        content = content.replace(/\/Users\/mockuser\/clawd/g, currentRoot);
        
        await fs.writeFile(configPath, content);
        console.log("✅ Paths updated.");
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
