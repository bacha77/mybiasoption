import { execSync } from 'child_process';

function killPort(port) {
    try {
        console.log(`Searching for process on port ${port}...`);
        const output = execSync(`netstat -ano | findstr :${port}`).toString();
        const lines = output.split('\n');
        const pids = new Set();
        
        lines.forEach(line => {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 5) {
                const pid = parts[parts.length - 1];
                if (pid && pid !== '0' && !isNaN(pid)) {
                    pids.add(pid);
                }
            }
        });

        if (pids.size === 0) {
            console.log(`No process found on port ${port}.`);
            return;
        }

        pids.forEach(pid => {
            console.log(`Killing PID ${pid}...`);
            try {
                execSync(`taskkill /F /PID ${pid}`);
                console.log(`Successfully killed PID ${pid}.`);
            } catch (err) {
                console.error(`Failed to kill PID ${pid}: ${err.message}`);
            }
        });
    } catch (err) {
        console.log(`Error or no process on port ${port}: ${err.message}`);
    }
}

killPort(3000);
