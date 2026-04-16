import http from 'http';

function check() {
    http.get('http://localhost:3000/debug-state', (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
            try {
                const state = JSON.parse(data);
                console.log("SERVER STATE:", JSON.stringify(state.internals, null, 2));
                const sectors = state.sectors || [];
                const nonZeroSectors = sectors.filter(s => s.price > 0);
                console.log(`POLL: Found ${nonZeroSectors.length}/${sectors.length} sectors with non-zero prices.`);
                if (nonZeroSectors.length > 0) {
                    console.log("SAMPLE PRICE (SPY):", sectors.find(s => s.symbol === 'SPY')?.price);
                }
            } catch (e) {
                console.log("FAILED TO PARSE STATE:", e.message);
            }
        });
    }).on('error', (err) => {
        console.log("SERVER UNREACHABLE:", err.message);
    });
}

check();
