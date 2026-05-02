import { els } from '../modules/dom_refs.js';
import {
    estimateTokenCount,
    formatCompactNumber,
} from '../modules/text_utils.js';

export function updatePlotTokenCount() {
    if (!els.plotTokenCount || !els.plotContent) return;

    const tokens = estimateTokenCount(els.plotContent.value);
    els.plotTokenCount.innerText = `~${formatCompactNumber(tokens)} tokens`;
    els.plotTokenCount.title = `Estimated plot outline tokens: ${tokens.toLocaleString()}`;
}
