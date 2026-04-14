import { InstitutionalAlgorithm } from './src/logic/institutional-algorithm.js';

const algo = new InstitutionalAlgorithm();
console.log("Check detectShadowBlocks:", typeof algo.detectShadowBlocks);
console.log("Check calculateIRScore:", typeof algo.calculateIRScore);
console.log("Check detectInversionFVG:", typeof algo.detectInversionFVG);
