import {
    estimateTokenCount,
    formatCompactNumber,
} from '../modules/text_utils.js';

export function getTokenEstimate(text: string) {
    const tokens = estimateTokenCount(text);
    return {
        label: `~${formatCompactNumber(tokens)} tokens`,
        title: `Estimated plot outline tokens: ${tokens.toLocaleString()}`,
        tokens,
    };
}
