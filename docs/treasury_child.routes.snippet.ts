/**
 * Вставить в server.ts ДОЧЕРНЕГО магазина (после создания server/treasury_child.ts из treasury_child.reference.ts)
 */
import {
    getChildTreasurySummary,
    convertChildRubToUsdt,
    completeWithdrawalRequest,
} from './treasury_child.ts';

function treasuryAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
    const secret = process.env.TREASURY_API_SECRET;
    if (!secret || req.headers['x-treasury-secret'] !== secret) {
        return res.status(403).json({ ok: false, error: 'Forbidden' });
    }
    next();
}

app.get('/api/treasury/summary', treasuryAuth, async (_req, res) => {
    try {
        const summary = await getChildTreasurySummary(supabase);
        res.json(summary);
    } catch (e: any) {
        console.error('[treasury] summary', e);
        res.status(500).json({ ok: false, error: e.message });
    }
});

app.post('/api/treasury/convert', treasuryAuth, async (req, res) => {
    try {
        const rate = Number(req.body?.rate);
        const result = await convertChildRubToUsdt(supabase, rate);
        res.json(result);
    } catch (e: any) {
        console.error('[treasury] convert', e);
        res.status(500).json({ ok: false, error: e.message });
    }
});

app.post('/api/treasury/withdrawal/complete', treasuryAuth, async (req, res) => {
    try {
        const requestId = Number(req.body?.requestId);
        const result = await completeWithdrawalRequest(supabase, requestId);
        res.json(result);
    } catch (e: any) {
        console.error('[treasury] withdrawal/complete', e);
        res.status(500).json({ ok: false, error: e.message });
    }
});
