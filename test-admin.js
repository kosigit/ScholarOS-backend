// Quick standalone check of the new /admin logic — no real database,
// no real server started (require.main !== module here, so index.js
// only exports its functions instead of booting).
//
// ADMIN_USER/ADMIN_PASS are read into constants once, when index.js is
// first required (same pattern the file already uses for the AI model
// names) — realistic, since a real server's env vars don't change
// after it boots. To test both the "configured" and "not configured"
// cases we have to force Node to re-evaluate the file fresh for each,
// by clearing it out of the require cache in between.
function freshRequire() {
  delete require.cache[require.resolve('./index.js')];
  return require('./index.js');
}

let failures = 0;
function check(label, cond) {
  if (cond) {
    console.log(`  ok  - ${label}`);
  } else {
    console.log(`FAIL  - ${label}`);
    failures++;
  }
}

// --- unconfigured server, tested first, before ADMIN_USER/PASS exist ---
console.log('checkAdminAuth (server has no ADMIN_USER/ADMIN_PASS set)');
delete process.env.ADMIN_USER;
delete process.env.ADMIN_PASS;
{
  const { checkAdminAuth: authUnconfigured } = freshRequire();
  const { req, res } = fakeReqRes('Basic ' + Buffer.from('team:secret123').toString('base64'));
  let nextCalled = false;
  authUnconfigured(req, res, () => { nextCalled = true; });
  check('unconfigured server -> 503, refuses even correct-looking creds', res._status === 503 && !nextCalled);
}

// Now boot it "for real", with credentials set, like Railway would.
process.env.ADMIN_USER = 'team';
process.env.ADMIN_PASS = 'secret123';
const { checkAdminAuth, formatPassRate, renderAdminPage } = freshRequire();

// --- formatPassRate -------------------------------------------------
console.log('formatPassRate');
check('0 attempts -> null (not NaN)', formatPassRate(0, 0) === null);
check('10 attempts, 6 passed -> 60', formatPassRate(10, 6) === 60);
check('3 attempts, 1 passed -> 33 (rounded)', formatPassRate(3, 1) === 33);

// --- checkAdminAuth (configured) --------------------------------------
console.log('checkAdminAuth (configured)');
function fakeReqRes(authHeader) {
  const req = { headers: authHeader ? { authorization: authHeader } : {} };
  const res = {
    _status: 200,
    _headers: {},
    _sent: null,
    status(code) { this._status = code; return this; },
    set(k, v) { this._headers[k] = v; return this; },
    send(body) { this._sent = body; return this; }
  };
  return { req, res };
}
function basicHeader(user, pass) {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

{
  const { req, res } = fakeReqRes(null);
  let nextCalled = false;
  checkAdminAuth(req, res, () => { nextCalled = true; });
  check('no Authorization header -> 401, next() not called', res._status === 401 && !nextCalled);
}
{
  const { req, res } = fakeReqRes(basicHeader('team', 'WRONG'));
  let nextCalled = false;
  checkAdminAuth(req, res, () => { nextCalled = true; });
  check('wrong password -> 401, next() not called', res._status === 401 && !nextCalled);
}
{
  const { req, res } = fakeReqRes(basicHeader('team', 'secret123'));
  let nextCalled = false;
  checkAdminAuth(req, res, () => { nextCalled = true; });
  check('correct user+pass -> next() called, no error status set', nextCalled && res._status === 200);
}
// (the "server not configured at all" case is covered above, before
// ADMIN_USER/ADMIN_PASS were ever set — see top of file)

// --- renderAdminPage --------------------------------------------------
console.log('renderAdminPage');
{
  const html = renderAdminPage({
    totalSessions: 42,
    sessionsToday: 5,
    sessionsWeek: 20,
    byStatus: [{ status: 'ACTIVE', n: 10 }, { status: 'UNLOCKED', n: 32 }],
    distinctSubjects: 7,
    totalAttempts: 15,
    passedAttempts: 9
  });
  check('renders total sessions', html.includes('>42<'));
  check('renders pass rate as 60%', html.includes('60%'));
  check('renders both status rows', html.includes('ACTIVE') && html.includes('UNLOCKED'));
}
{
  // The exact case that used to be able to produce NaN%.
  const html = renderAdminPage({
    totalSessions: 0, sessionsToday: 0, sessionsWeek: 0,
    byStatus: [], distinctSubjects: 0, totalAttempts: 0, passedAttempts: 0
  });
  check('zero attempts renders em-dash, never "NaN%"', html.includes('—') && !html.includes('NaN'));
}

console.log(failures === 0 ? '\nAll admin checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
