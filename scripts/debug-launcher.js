import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const logFile = path.join(process.cwd(), 'startup_debug.log');
const log = (msg) => {
    const formatted = `[${new Date().toISOString()}] ${msg}\n`;
    fs.appendFileSync(logFile, formatted);
    process.stdout.write(formatted);
};

fs.writeFileSync(logFile, `--- DEBUG LAUNCHER START ---\n`);

log(`Current CWD: ${process.cwd()}`);
log(`Node Version: ${process.version}`);

const server = spawn('node', ['src/index.js'], {
    env: { ...process.env, YF_NO_VALIDATION: '1' },
    shell: true
});

server.stdout.on('data', (data) => {
    log(`[STDOUT] ${data}`);
});

server.stderr.on('data', (data) => {
    log(`[STDERR] ${data}`);
});

server.on('error', (err) => {
    log(`[PROCESS ERROR] ${err.message}`);
});

server.on('close', (code) => {
    log(`[PROCESS CLOSED] with code ${code}`);
});

log(`Server process spawned with PID: ${server.pid}`);
