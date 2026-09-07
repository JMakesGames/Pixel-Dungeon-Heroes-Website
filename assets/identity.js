// Shared player-identity helper used by tournaments.html, tournament.html, and
// leaderboard.html. A claimed name is permanent and unique site-wide (see
// server/db.js) — this file just manages the browser-side copy of it.
const PDH_IDENTITY_KEY = 'pdh_identity';

function pdhGetIdentity() {
  try { return JSON.parse(localStorage.getItem(PDH_IDENTITY_KEY) || 'null'); }
  catch { return null; }
}

function pdhSaveIdentity(identity) {
  localStorage.setItem(PDH_IDENTITY_KEY, JSON.stringify(identity));
}

/** Renders a claim-a-name card into `container`, or a "playing as" state if already claimed.
 *  Calls onReady(identity) once an identity exists (immediately if already claimed). */
function pdhRenderIdentityWidget(container, onReady) {
  const identity = pdhGetIdentity();
  if (identity) {
    container.innerHTML = `
      <div class="identity-card">
        <p class="signed-in">Playing as <b>${pdhEscape(identity.name)}</b></p>
      </div>`;
    onReady(identity);
    return;
  }

  container.innerHTML = `
    <div class="identity-card">
      <h3>PICK YOUR NAME</h3>
      <div class="identity-row">
        <input id="pdhNameInput" maxlength="20" placeholder="Your Hunter name">
        <button class="btn primary small" id="pdhClaimBtn">CLAIM</button>
      </div>
      <p class="hint">Your name should match or be close to your Hunter's name in-game.
        Names are permanent and unique — choose carefully, this can't be changed later.</p>
      <div class="form-error" id="pdhClaimError"></div>
    </div>`;

  const submit = () => {
    const nameInput = document.getElementById('pdhNameInput');
    const errorEl = document.getElementById('pdhClaimError');
    const name = nameInput.value.trim();
    errorEl.textContent = '';
    if (name.length < 2) { errorEl.textContent = 'Name must be at least 2 characters.'; return; }

    fetch('/api/players/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }).then(async r => {
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Could not claim that name');
      pdhSaveIdentity(data);
      pdhRenderIdentityWidget(container, onReady);
    }).catch(err => { errorEl.textContent = err.message; });
  };

  document.getElementById('pdhClaimBtn').addEventListener('click', submit);
  document.getElementById('pdhNameInput').addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
}

function pdhEscape(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
