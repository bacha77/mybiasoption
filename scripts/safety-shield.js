import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const shieldRoot = path.join(root, 'shield_backups');

const foldersToBackup = ['src', 'public'];
const filesToBackup = ['package.json', 'watchlist.json', '.env'];

function getTimestamp() {
    const now = new Date();
    // Format: YYYY-MM-DD_HH-mm (Easier to read for the user)
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const h = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    return `${y}-${m}-${d}_${h}-${min}`;
}

function saveState() {
    const ts = getTimestamp();
    const dest = path.join(shieldRoot, ts);
    
    if (!fs.existsSync(shieldRoot)) fs.mkdirSync(shieldRoot, { recursive: true });
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });

    console.log(`\n[SHIELD] 🛡️  INITIATING INSTITUTIONAL SNAPSHOT: ${ts}...`);

    for (const folder of foldersToBackup) {
        const srcPath = path.join(root, folder);
        const destPath = path.join(dest, folder);
        if (fs.existsSync(srcPath)) {
            console.log(`  > Archiving ${folder}...`);
            copyRecursiveSync(srcPath, destPath);
        }
    }

    for (const file of filesToBackup) {
        const srcPath = path.join(root, file);
        const destPath = path.join(dest, file);
        if (fs.existsSync(srcPath)) {
            fs.copyFileSync(srcPath, destPath);
        }
    }

    // Update 'LATEST' pointer
    const latestPath = path.join(shieldRoot, 'LATEST_WORKING');
    if (fs.existsSync(latestPath)) try { fs.unlinkSync(latestPath); } catch(e) {}
    // We can't use symlinks easily on Windows without admin, so we just copy to LATEST_WORKING or use a file pointer
    fs.writeFileSync(path.join(shieldRoot, 'last_good.txt'), ts);

    console.log(`[SHIELD] ✅ SUCCESS: System state secured.`);
    console.log(`[SHIELD] Location: ${dest}`);
}

function listSnapshots() {
    if (!fs.existsSync(shieldRoot)) {
        console.log("[SHIELD] ❌ No snapshots found.");
        return [];
    }
    return fs.readdirSync(shieldRoot)
        .filter(f => fs.statSync(path.join(shieldRoot, f)).isDirectory() && f !== 'LATEST_WORKING')
        .sort().reverse();
}

function restoreState(targetTs) {
    let finalTs = targetTs;
    
    if (!finalTs) {
        const snapshots = listSnapshots();
        if (snapshots.length === 0) {
            console.error("[SHIELD] ❌ No snapshots found to restore.");
            return;
        }

        console.log("\n[SHIELD] 📂 AVAILABLE SYSTEM SNAPSHOTS:");
        console.log("------------------------------------------");
        snapshots.forEach((s, idx) => {
            const isLatest = (idx === 0);
            console.log(`  [${idx + 1}] ${s} ${isLatest ? ' (RECOMMENDED: LATEST GOOD)' : ''}`);
        });
        console.log("------------------------------------------");
        console.log("[QUERY] Select index to restore or press ENTER for LATEST:");
        
        // In node scripts, we can't easily wait for prompt in a blocking way without modules
        // So we will just explain the command for now if called without args
        console.log(`\n[SHIELD] To restore the latest: npm run rollback ${snapshots[0]}`);
        return;
    }

    const src = path.join(shieldRoot, finalTs);
    if (!fs.existsSync(src)) {
        console.error(`[SHIELD] ❌ Snapshot '${finalTs}' not found.`);
        return;
    }

    console.log(`\n[SHIELD] ⚠️  CRITICAL REVERT INITIATED: Restoring to ${finalTs}...`);

    // Safety backup of "Bad" state
    const rescueTs = `RESCUE_${getTimestamp()}`;
    const rescuePath = path.join(shieldRoot, rescueTs);
    console.log(`[SHIELD] Creating emergency rescue of current state: ${rescueTs}`);
    
    // Perform restore
    for (const folder of foldersToBackup) {
        const targetPath = path.join(root, folder);
        if (fs.existsSync(targetPath)) {
            // Move to rescue instead of deleting
            if (!fs.existsSync(rescuePath)) fs.mkdirSync(rescuePath, { recursive: true });
            fs.renameSync(targetPath, path.join(rescuePath, folder));
        }
        
        const snapshotPath = path.join(src, folder);
        if (fs.existsSync(snapshotPath)) {
            console.log(`  > Restoring ${folder}...`);
            copyRecursiveSync(snapshotPath, targetPath);
        }
    }

    for (const file of filesToBackup) {
        const targetPath = path.join(root, file);
        const snapshotPath = path.join(src, file);
        if (fs.existsSync(snapshotPath)) {
            fs.copyFileSync(snapshotPath, targetPath);
        }
    }

    console.log(`\n[SHIELD] ✨ RESTORATION COMPLETE.`);
    console.log(`[SHIELD] Version: ${finalTs}`);
    console.log(`[SHIELD] Status: RE-INITIALIZE SERVER TO APPLY CHANGES.`);
}

function copyRecursiveSync(src, dest) {
    const exists = fs.existsSync(src);
    const stats = exists && fs.statSync(src);
    const isDirectory = exists && stats.isDirectory();
    if (isDirectory) {
        if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
        fs.readdirSync(src).forEach((child) => {
            copyRecursiveSync(path.join(src, child), path.join(dest, child));
        });
    } else {
        fs.copyFileSync(src, dest);
    }
}

const args = process.argv.slice(2);
if (args.includes('--save')) {
    saveState();
} else if (args.includes('--restore')) {
    const ts = args.find(a => !a.startsWith('--'));
    restoreState(ts);
} else if (args.includes('--list')) {
    const snapshots = listSnapshots();
    console.log("\n[SHIELD] SNAPSHOT HISTORY:");
    snapshots.forEach(s => console.log(` - ${s}`));
} else {
    console.log("Usage: node safety-shield.js [--save | --restore <ts> | --list]");
}

