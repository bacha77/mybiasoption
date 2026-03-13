
const testCases = [
    { time: 0, val: 1500000, desc: "Elite Block ($1.5M)" },
    { time: 1, val: 3500000, desc: "Ultra Block ($3.5M)" },
    { time: 5, val: 4000000, desc: "Ultra Block ($4.0M) - During Cooldown" },
    { time: 16, val: 3200000, desc: "Ultra Block ($3.2M) - Post Cooldown" },
    { time: 20, val: 2000000, desc: "Elite Block ($2.0M)" }
];

const lastAlerts = new Map();
const cooldown = 15; // Simulated minutes

console.log("--- INSTITUTIONAL SIGNAL GUARD DIAGNOSTIC ---");
console.log(`Filter Threshold: $3,000,000 | Cooldown: ${cooldown} mins\n`);

testCases.forEach(test => {
    let telegramSent = false;
    let hudSent = true; // Dashboard always gets it

    const lastWhale = lastAlerts.get("TEST_SYM") || -999;
    
    if (test.val >= 3000000 && (test.time - lastWhale >= cooldown)) {
        telegramSent = true;
        lastAlerts.set("TEST_SYM", test.time);
    }

    console.log(`[T+${test.time}m] ${test.desc}`);
    console.log(`   > HUD Update: ✅`);
    console.log(`   > Telegram Alert: ${telegramSent ? "🚀 FIRING" : "🚫 SUPPRESSED"}`);
    console.log("");
});

console.log("--- DIAGNOSTIC COMPLETE ---");
console.log("Result: Filter reduced 5 potential pings down to 2 critical alerts.");
