/* api.js - talks to the Karo Recon engine. The login token lives in sessionStorage
   (cleared when the tab closes) and is sent on every request. */
const Api = {
  token() { return sessionStorage.getItem('karo_token'); },
  staff() { try { return JSON.parse(sessionStorage.getItem('karo_staff')); } catch (e) { return null; } },
  save(token, staff) { sessionStorage.setItem('karo_token', token); sessionStorage.setItem('karo_staff', JSON.stringify(staff)); },
  clear() { sessionStorage.removeItem('karo_token'); sessionStorage.removeItem('karo_staff'); Api.pin = null; },

  /* PIN unlock: sensitive actions (banks, M-Pesa, channels, staff access, renaming the school) ask an Admin for their PIN.
     The server answers 403 { code: 'pin_required' | 'pin_not_set' }; we ask once, keep the unlock in memory for 10 minutes
     (never saved to disk), and repeat the request. Routine work never asks. */
  pin: null,                                   // { token, until }
  pinToken() { return Api.pin && Api.pin.until > Date.now() ? Api.pin.token : null; },
  setPin(token, minutes) { Api.pin = { token: token, until: Date.now() + ((minutes || 10) - 0.5) * 60000 }; },
  async askPin(code) {
    const sid = '/schools/' + Api.staff().school_id;
    if (code === 'pin_not_set') {
      const r = await stDialog({ title: 'Set your PIN first', intro: 'This action is protected by your personal PIN (4 to 6 digits). Choose it now. We ask for your login password once to be sure it is you.',
        fields: [{ id: 'pw', label: 'Your login password', type: 'password', autocomplete: 'current-password' }, { id: 'p1', label: 'New PIN', type: 'password', autocomplete: 'off' }, { id: 'p2', label: 'New PIN again', type: 'password', autocomplete: 'off' }],
        okText: 'Save PIN', run: async function (v) { if (v.p1 !== v.p2) throw new Error('The two PINs are not the same.'); return Api.request('POST', sid + '/pin/set', { password: v.pw, pin: v.p1 }, true); } });
      if (!r || !r.token) return false; Api.setPin(r.token, r.minutes); return true;
    }
    const r = await stDialog({ title: 'Enter your PIN', intro: 'This is a sensitive action. Your PIN keeps it open for 10 minutes.',
      fields: [{ id: 'pin', label: 'Your PIN', type: 'password', autocomplete: 'off', inputmode: 'numeric' }],
      okText: 'Unlock', run: function (v) { return Api.request('POST', sid + '/pin/unlock', { pin: v.pin }, true); } });
    if (!r || !r.token) return false; Api.setPin(r.token, r.minutes); return true;
  },

  async request(method, path, body, noPinPrompt) {
    const headers = { 'Content-Type': 'application/json' };
    if (Api.token()) headers.Authorization = 'Bearer ' + Api.token();
    if (Api.pinToken()) headers['X-Pin-Token'] = Api.pinToken();
    const res = await fetch('/api' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let data = null;
    try { data = await res.json(); } catch (e) { /* empty body */ }
    if (res.status === 401 && Api.token()) { logout(); throw new Error('Your session expired - please log in again'); }
    if (res.status === 403 && data && (data.code === 'pin_required' || data.code === 'pin_not_set') && !noPinPrompt) {
      Api.pin = null;
      if (await Api.askPin(data.code)) return Api.request(method, path, body, true);   // asked once; try the action again
      throw new Error('PIN needed. Nothing was changed.');
    }
    if (!res.ok) throw new Error((data && data.error) || 'Request failed (' + res.status + ')');
    return data;
  },
  get(path) { return Api.request('GET', path); },
  post(path, body) { return Api.request('POST', path, body || {}); },
  put(path, body) { return Api.request('PUT', path, body || {}); },
};