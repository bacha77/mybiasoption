/**
 * Board Scanner Logic
 * Scans all active "cards" (symbols) to find best plays and identify board conflicts.
 */

export class BoardScanner {
    constructor(simulator) {
        this.simulator = simulator;
        this.sectorMap = {
            'XLK': ['AAPL', 'MSFT', 'NVDA', 'AMD'],
            'SMH': ['NVDA', 'AMD', 'TSM', 'MU'],
            'XLF': ['JPM', 'GS', 'BAC'],
            'XLY': ['AMZN', 'TSLA'],
            'XLC': ['META', 'GOOGL'],
            'KRE': ['JPM', 'GS'], // Regional proxy
            'XBI': ['IBB'], // Biotech proxy
            'IYT': ['UPS', 'FDX'] // Transports
        };
    }

    /**
     * Scans the current board state
     * @param {Array} watchlistData - Output from processWatchlist()
     * @param {Array} sectorData - Output from processSectors()
     * @param {Object} internals - Market internals (VIX, DXY, etc.)
     * @returns {Object} Scan results
     */
    scan(watchlistData, sectorData, internals) {
        try {
            console.log("[SCANNER] Processing board state...");
            
            // 1. Identify "Best Recommendations" with Alpha Extraction
            const recommendations = watchlistData
                .map(item => {
                    try {
                        const stock = this.simulator.stocks[item.symbol];
                        if (!stock || !stock.candles) return null;

                        const tf = this.simulator.currentTimeframe || '1m';
                        const candles = stock.candles[tf] || [];
                        
                        // Fetch required data for Alpha Calculation
                        const markers = this.simulator.getInstitutionalMarkers ? this.simulator.getInstitutionalMarkers(item.symbol, tf) || {} : {};
                        
                        let macroRegime = { regime: 'NEUTRAL', status: 'UNKNOWN' };
                        let goMatrix = { matrix: {}, signal: 'UNKNOWN', score: 0 };
                        let alphaTrigger = { probability: 0, status: 'SCANNING', conviction: 0 };
                        let irScore = { score: 50, status: 'NEUTRAL', shadow: { status: 'STABLE' } };
                        
                        if (this.simulator.eliteAlgo) {
                            macroRegime = this.simulator.eliteAlgo.calculateMacroRegime(
                                this.simulator.stocks['DX-Y.NYB'] || { dailyChangePercent: 0 },
                                this.simulator.stocks['^TNX'] || { dailyChangePercent: 0 },
                                this.simulator.stocks['^VIX'] || { currentPrice: 15 },
                                this.simulator.stocks['SPY'] || { dailyChangePercent: 0 }
                            );
                            
                            goMatrix = this.simulator.eliteAlgo.getMultiTFAlignment(stock.candles || {});
                            
                            irScore = this.simulator.eliteAlgo.calculateIRScore(
                                { score: item.confluenceScore || 0, bias: item.bias, internals: this.simulator.internals },
                                this.simulator.eliteAlgo.getKillzoneStatus(),
                                markers.radar?.smt,
                                markers.radar?.gex || [],
                                40, // Estimated retail sentiment if not provided
                                item.symbol,
                                candles
                            );
                            
                            alphaTrigger = this.simulator.eliteAlgo.calculateAlphaTrigger(
                                irScore,
                                macroRegime,
                                goMatrix,
                                stock.currentPrice || 0,
                                markers.radar?.gex || [],
                                { bias: item.bias || 'NEUTRAL' },
                                candles,
                                stock.news || []
                            );
                        }

                        // Scalp-Specific Metadata
                        const isKillzone = this.simulator.eliteAlgo.getKillzoneStatus().active;
                        const cvd = markers.cvd || 0;
                        
                        const dxy = this.simulator.stocks['DX-Y.NYB'] || { dailyChangePercent: 0 };
                        const vix = this.simulator.stocks['^VIX'] || { dailyChangePercent: 0 };
                        const macroVelocity = Math.abs(dxy.dailyChangePercent) > 0.05 || Math.abs(vix.dailyChangePercent) > 1.0;
                        
                        let isAlgoTrap = false;
                        if (alphaTrigger.expertNotes && alphaTrigger.expertNotes.some(note => note.includes('TRAP') || note.includes('DIVERGENCE'))) {
                            isAlgoTrap = true;
                        }

                        const voids = this.simulator.eliteAlgo.calculateLiquidityVoids(candles) || [];
                        const nearestVoid = voids.length > 0 ? voids[voids.length - 1] : null;
                        const isVacuumTarget = nearestVoid && (
                            (item.bias === 'BULLISH' && nearestVoid.type === 'BULLISH_VACUUM' && item.price < nearestVoid.start) ||
                            (item.bias === 'BEARISH' && nearestVoid.type === 'BEARISH_VACUUM' && item.price > nearestVoid.end)
                        );

                        const isScalp = (item.bias !== 'NEUTRAL' && isKillzone && Math.abs(cvd) > 500 && macroVelocity && !isAlgoTrap);

                        const nyTime = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
                        const totalMins = (nyTime.getHours() * 60) + nyTime.getMinutes();
                        const isJudasWindow = totalMins >= 570 && totalMins < 600;
                        const isJudas = isJudasWindow && (
                            (item.bias === 'BULLISH' && item.price < (markers.midnightOpen || item.price) && cvd > 300) ||
                            (item.bias === 'BEARISH' && item.price > (markers.midnightOpen || item.price) && cvd < -300)
                        );

                        let amdPhase = 'ACCUMULATION';
                        if (isJudasWindow) amdPhase = 'MANIPULATION (JUDAS)';
                        else if (totalMins >= 600 && totalMins < 840) amdPhase = 'DISTRIBUTION (EXPANSION)';
                        else if (totalMins >= 840) amdPhase = 'REVERSAL / DISTRIBUTION';

                        let smt = null;
                        if (item.symbol === 'SPY' || item.symbol === 'QQQ') {
                            const spyObj = this.simulator.stocks['SPY'];
                            const qqqObj = this.simulator.stocks['QQQ'];
                            if (spyObj && qqqObj && spyObj.candles && qqqObj.candles) {
                                smt = this.simulator.eliteAlgo.detectSMT(
                                    'SPY', spyObj.currentPrice, spyObj.candles[tf] || [],
                                    'QQQ', qqqObj.currentPrice, qqqObj.candles[tf] || []
                                );
                            }
                        }

                        // --- FINAL BOSS LEVEL UPGRADES: MSS, I-FVG, ICEBERG ---
                        const mss = this.simulator.eliteAlgo.detectMSS(candles);
                        const ifvg = this.simulator.eliteAlgo.detectInversionFVG(candles, item.price);
                        const iceberg = this.simulator.eliteAlgo.detectShadowBlocks(candles, item.price);

                        // --- SCALPER UPGRADE: SECTOR SYMBIOSIS (Sector Check) ---
                        let sectorAligned = true;
                        if (this.sectorMap && sectorData) {
                            const relevantSectorSym = Object.keys(this.sectorMap).find(s => this.sectorMap[s] && this.sectorMap[s].includes(item.symbol));
                            if (relevantSectorSym) {
                                const sectorObj = sectorData.find(s => s.symbol === relevantSectorSym);
                                if (sectorObj) {
                                    const isBullish = item.bias.includes('BULLISH');
                                    if (isBullish && (sectorObj.bias === 'BEARISH' || sectorObj.bias === 'STRONG BEARISH')) sectorAligned = false;
                                    if (!isBullish && (sectorObj.bias === 'BULLISH' || sectorObj.bias === 'STRONG BULLISH')) sectorAligned = false;
                                }
                            }
                        }

                        const isNeuralStrike = (
                            alphaTrigger.probability >= 85 && 
                            mss && 
                            smt && 
                            irScore && irScore.shadow?.status !== 'STABLE' && 
                            sectorAligned
                        );
                        
                        const recentVols = candles.slice(-20).map(c => Math.abs(c.close - c.open));
                        const avgVol = recentVols.length > 0 ? (recentVols.reduce((a, b) => a + b, 0) / recentVols.length) : 0;
                        const currentVol = candles.length > 0 ? Math.abs(candles[candles.length - 1].close - candles[candles.length - 1].open) : 0;
                        const isSqueezed = avgVol > 0 && currentVol < (avgVol * 0.4);

                        return {
                            symbol: item.symbol,
                            bias: item.bias || 'NEUTRAL',
                            action: item.recommendation?.action || 'WAIT',
                            score: item.confluenceScore || 0,
                            alpha: alphaTrigger.probability || 0,
                            alphaConviction: alphaTrigger.conviction || 0,
                            price: item.price,
                            isScalp: isScalp, 
                            isAlgoTrap: isAlgoTrap, 
                            isVacuumTarget: isVacuumTarget, 
                            isJudas: isJudas,
                            isNeuralStrike: !!isNeuralStrike,
                            isSqueezed: isSqueezed,
                            sectorAligned: sectorAligned,
                            amdPhase: amdPhase,
                            smt: smt,
                            mss: mss,
                            ifvg: ifvg,
                            isIceberg: !!iceberg,
                            whaleFlow: stock.netWhaleFlow || 0,
                            isElite: item.isElite || false
                        };
                    } catch (err) {
                        console.error(`[SCANNER] Individual symbol error for ${item.symbol}:`, err);
                        return null;
                    }
                })
                .filter(r => {
                    if (!r) return false;
                    if (r.isAlgoTrap) return false;
                    const isBullish = r.bias.includes('BULLISH');
                    if (isBullish && r.whaleFlow < -800000) return false;
                    if (!isBullish && r.whaleFlow > 800000) return false;

                    const now = new Date();
                    const nyTime = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
                    const isPreMarket = (nyTime.getHours() * 60 + nyTime.getMinutes()) < 570;
                    
                    if (isPreMarket) {
                        if (r.alpha < 75 || r.score < 80) return false;
                    }

                    return r.score >= 35 && r.alpha >= 30; // Loosened for visibility
                })
                .sort((a, b) => {
                    if (a.isNeuralStrike && !b.isNeuralStrike) return -1;
                    if (!a.isNeuralStrike && b.isNeuralStrike) return 1;
                    if (Math.abs(b.alpha - a.alpha) > 10) return b.alpha - a.alpha;
                    if (a.mss && !b.mss) return -1;
                    if (!a.mss && b.mss) return 1;
                    return b.score - a.score;
                });

            // Calculate Board Statistics
            const stats = { bullish: 0, bearish: 0, neutral: 0 };
            watchlistData.forEach(item => {
                const isBullish = item.bias && item.bias.includes('BULLISH');
                const isBearish = item.bias && item.bias.includes('BEARISH');
                if (isBullish) stats.bullish++;
                else if (isBearish) stats.bearish++;
                else stats.neutral++;
            });

            const total = watchlistData.length || 1;
            const bullPercent = Math.round((stats.bullish / total) * 100);
            const bearPercent = Math.round((stats.bearish / total) * 100);

            const sentiment = stats.bullish > stats.bearish ? 'BULLISH' : (stats.bearish > stats.bullish ? 'BEARISH' : 'NEUTRAL');

            // Identify Board Conflicts
            const conflicts = [];
            const spy = watchlistData.find(d => d.symbol === 'SPY');
            const qqq = watchlistData.find(d => d.symbol === 'QQQ');

            if (spy && qqq && spy.bias !== 'NEUTRAL' && qqq.bias !== 'NEUTRAL' && spy.bias !== qqq.bias) {
                conflicts.push({ type: 'INDEX_DIVERGENCE', severity: 'HIGH', message: `Tech (QQQ) is ${qqq.bias} while Broad Market (SPY) is ${spy.bias}.` });
            }

            return {
                timestamp: new Date().toISOString(),
                sentiment: sentiment,
                statistics: stats,
                bullPercent: bullPercent,
                bearPercent: bearPercent,
                recommendations: recommendations.slice(0, 10), // Increased visibility
                conflicts
            };
        } catch (err) {
            console.error("[SCANNER FATAL ERROR]:", err);
            return { error: err.message, recommendations: [], conflicts: [] };
        }
    }
}
