/**
 * Imported FIRST by the e2e specs: the licence SDK reads these at module load.
 * Points every licence-server call (evaluation, heartbeat, revocation) at a
 * local stub so a test run never talks to the live HULO licence server.
 */
import * as http from 'http';

export const LICENCE_STUB_PORT = 3069;
const base = `http://127.0.0.1:${LICENCE_STUB_PORT}`;
process.env.HULO_LICENCE_EVAL_URL = `${base}/licence/eval/register`;
process.env.HULO_LICENCE_HEARTBEAT_URL = `${base}/licence/heartbeat`;
process.env.HULO_LICENCE_REVOCATION_URL = `${base}/licence/revoked.json`;
process.env.HULO_HEARTBEAT_DISABLED = 'true';

/** Start the stub. `evalActive` decides what /eval/register answers. */
export function startLicenceStub(evalActive: boolean): Promise<http.Server> {
    const srv = http.createServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        if (req.url?.startsWith('/licence/eval/register')) {
            return res.end(JSON.stringify({ status: evalActive ? 'eval' : 'expired', daysRemaining: 10 }));
        }
        if (req.url?.startsWith('/licence/revoked.json')) return res.end(JSON.stringify({ revoked: [] }));
        res.statusCode = 404;
        res.end('{}');
    });
    return new Promise(resolve => srv.listen(LICENCE_STUB_PORT, '127.0.0.1', () => resolve(srv)));
}
