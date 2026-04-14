import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';

/**
 * BIAS SHIELD WATCHDOG
 * Automatically detects changes and creates backups when the system is stable.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const pathsToWatch = [
    path.join(root, 'src'),
    path.join(root, 'public')
];

let changeTimeout = null;
const DEBOUNCE_TIME = 60000 * 5; // 5 minutes of silence before backup

console.log(`\n[WATCHDOG] 🛡️  Shield Sentinel Active.`);
console.log(`[WATCHDOG] Monitoring: src/ and public/`);
console.log(`[WATCHDOG] Automation: Snapshot will be taken after ${DEBOUNCE_TIME / 60000} mins of inactivity.`);

function triggerBackup() {
    console.log(`\n[WATCHDOG] 🚨 CHANGE DETECTED & SETTLED. Initiating Auto-Snapshot...`);
    exec('npm run checkpoint', (err, stdout, stderr) => {
        if (err) {
            console.error(`[WATCHDOG] ❌ Auto-Snapshot Failed:`, err);
            return;
        }
        console.log(stdout);
        console.log(`[WATCHDOG] ✅ Auto-Snapshot Complete.`);
    });
}

pathsToWatch.forEach(dir => {
    if (!fs.existsSync(dir)) return;
    
    fs.watch(dir, { recursive: true }, (event, filename) => {
        if (filename && (filename.endsWith('.js') || filename.endsWith('.css') || filename.endsWith('.html'))) {
            // Clear existing timeout
            if (changeTimeout) clearTimeout(changeTimeout);
            
            // Set new timeout
            changeTimeout = setTimeout(() => {
                triggerBackup();
                changeTimeout = null;
            }, DEBOUNCE_TIME);
            
            process.stdout.write(`\r[WATCHDOG] Activity in ${filename}... Pending Snapshot in ${DEBOUNCE_TIME / 1000}s   `);
        }
    });
});

// Run an initial backup just in case
console.log(`[WATCHDOG] Performing initial security scan...`);
triggerBackup();
